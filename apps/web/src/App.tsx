import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken, setCurrentUser } from "./api";
import type {
  Agent,
  AgentRun,
  AuditEntry,
  Grant,
  Message,
  Scope,
  SystemInfo,
  User,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

const SCOPE_OPTIONS: Scope[] = ["invoke", "view_config", "edit_config", "view_runs"];
const USER_STORAGE_KEY = "launchpad.currentUser";

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatStamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function grantState(grant: Grant): "revoked" | "expired" | "live" {
  if (grant.revokedAt) return "revoked";
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return "expired";
  return "live";
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function UserSwitcher({
  users,
  current,
  onSwitch,
}: {
  users: User[];
  current: User;
  onSwitch: (user: User) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"user-switcher " + (open ? "open" : "")}>
      <button className="user-switcher-trigger" onClick={() => setOpen((value) => !value)}>
        <span className="user-avatar">{current.name.slice(0, 1).toUpperCase()}</span>
        <span className="user-switcher-copy">
          <strong>{current.name}</strong>
          <span>{current.role}</span>
        </span>
        <span className="user-switcher-caret">▾</span>
      </button>
      {open && (
        <div className="user-switcher-menu">
          <span className="user-switcher-label">Act as (mock login)</span>
          {users.map((user) => (
            <button
              key={user.id}
              className={"user-switcher-item " + (user.id === current.id ? "active" : "")}
              onClick={() => {
                setOpen(false);
                if (user.id !== current.id) onSwitch(user);
              }}
            >
              <span className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
              <span className="user-switcher-copy">
                <strong>{user.name}</strong>
                <span>{user.role}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccessPanel({
  agent,
  users,
  currentUserId,
  onClose,
  onError,
  onChanged,
}: {
  agent: Agent;
  users: User[];
  currentUserId: string;
  onClose: () => void;
  onError: (reason: unknown) => void;
  onChanged: () => void;
}) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [grantedTo, setGrantedTo] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["invoke"]);
  const [expiresAt, setExpiresAt] = useState("");

  const candidates = useMemo(
    () => users.filter((user) => user.id !== agent.ownerId),
    [users, agent.ownerId],
  );

  const nameFor = useCallback(
    (id: string) => users.find((user) => user.id === id)?.name ?? id,
    [users],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.grants(agent.id);
      setGrants(result.grants);
    } catch (reason) {
      onError(reason);
    } finally {
      setLoading(false);
    }
  }, [agent.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setGrantedTo(candidates[0]?.id ?? "");
  }, [candidates]);

  const toggleScope = (scope: Scope) => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!grantedTo || scopes.length === 0) return;
    setBusy(true);
    try {
      const body: { grantedTo: string; scopes: Scope[]; expiresAt?: string } = {
        grantedTo,
        scopes,
      };
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      await api.createGrant(agent.id, body);
      setScopes(["invoke"]);
      setExpiresAt("");
      await refresh();
      onChanged();
    } catch (reason) {
      onError(reason);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    try {
      await api.revokeGrant(agent.id, grantId);
      await refresh();
      onChanged();
    } catch (reason) {
      onError(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <div className="settings-title">
        <div>
          <span className="eyebrow">Delegated access</span>
          <h2>Who can use {agent.name}</h2>
        </div>
        <button type="button" onClick={onClose}>×</button>
      </div>

      <p className="panel-hint">
        You own this Agent. Grants are scoped and revocable — enforcement happens
        server-side, revocation takes effect on the grantee's next request.
      </p>

      <div className="grant-list">
        {loading ? (
          <div className="grant-empty"><Spinner /> Loading grants…</div>
        ) : grants.length === 0 ? (
          <div className="grant-empty">No grants yet. {agent.name} is owner-only.</div>
        ) : (
          grants.map((grant) => {
            const state = grantState(grant);
            return (
              <div className={"grant-row grant-" + state} key={grant.id}>
                <div className="grant-who">
                  <strong>{nameFor(grant.grantedTo)}</strong>
                  <span>by {nameFor(grant.grantedBy)}</span>
                </div>
                <div className="grant-scopes">
                  {grant.scopes.map((scope) => (
                    <span className="scope-chip" key={scope}>{scope}</span>
                  ))}
                </div>
                <span className={"grant-state grant-state-" + state}>
                  {state}
                  {grant.expiresAt && state !== "revoked"
                    ? " · expires " + formatStamp(grant.expiresAt)
                    : ""}
                </span>
                <button
                  className="button button-danger"
                  disabled={busy || state === "revoked"}
                  onClick={() => revoke(grant.id)}
                >
                  Revoke
                </button>
              </div>
            );
          })
        )}
      </div>

      <form className="grant-form" onSubmit={submit}>
        <div className="grant-form-row">
          <label>
            Grant to
            <select
              value={grantedTo}
              onChange={(event) => setGrantedTo(event.target.value)}
              disabled={candidates.length === 0}
            >
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.role})
                </option>
              ))}
            </select>
          </label>
          <label>
            Expires (optional)
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
        </div>
        <div className="scope-picker">
          {SCOPE_OPTIONS.map((scope) => (
            <label key={scope} className="scope-option">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              {scope}
            </label>
          ))}
        </div>
        <div className="panel-footer">
          <span className="panel-note">
            {currentUserId === agent.ownerId ? "" : "Only the owner can grant access."}
          </span>
          <button
            className="button button-primary"
            disabled={busy || !grantedTo || scopes.length === 0}
          >
            {busy ? <Spinner /> : "Create grant"}
          </button>
        </div>
      </form>
    </section>
  );
}

function AuditPanel({
  agent,
  users,
  onClose,
  onError,
  reloadKey,
}: {
  agent: Agent;
  users: User[];
  onClose: () => void;
  onError: (reason: unknown) => void;
  reloadKey: number;
}) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<"" | "allow" | "deny">("");

  const nameFor = useCallback(
    (id: string) => users.find((user) => user.id === id)?.name ?? id,
    [users],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { target: agent.id, limit: "100" };
      if (decision) params.decision = decision;
      const page = await api.audit(params);
      setEntries(page.entries);
    } catch (reason) {
      onError(reason);
    } finally {
      setLoading(false);
    }
  }, [agent.id, decision, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  return (
    <section className="settings-panel">
      <div className="settings-title">
        <div>
          <span className="eyebrow">Audit log</span>
          <h2>Every decision on {agent.name}</h2>
        </div>
        <button type="button" onClick={onClose}>×</button>
      </div>

      <div className="audit-toolbar">
        <div className="audit-filter">
          {(["", "allow", "deny"] as const).map((value) => (
            <button
              key={value || "all"}
              className={"audit-tab " + (decision === value ? "active" : "")}
              onClick={() => setDecision(value)}
            >
              {value || "all"}
            </button>
          ))}
        </div>
        <button className="button button-ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="audit-table-wrap">
        {loading ? (
          <div className="grant-empty"><Spinner /> Loading…</div>
        ) : entries.length === 0 ? (
          <div className="grant-empty">No entries match.</div>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Decision</th>
                <th>Checkpoint</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const payload = (entry.payload ?? {}) as Record<string, unknown>;
                const detail =
                  (payload.reason as string) ??
                  (payload.grantedTo
                    ? "→ " + nameFor(String(payload.grantedTo))
                    : "");
                return (
                  <tr key={entry.id}>
                    <td>{formatStamp(entry.timestamp)}</td>
                    <td>{nameFor(entry.actor.id)}</td>
                    <td><code>{entry.action}</code></td>
                    <td>
                      <span className={"decision decision-" + entry.decision}>
                        {entry.decision}
                      </span>
                    </td>
                    <td>{(payload.checkpoint as string) ?? "—"}</td>
                    <td className="audit-detail">{detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [auditReloadKey, setAuditReloadKey] = useState(0);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [restrictedView, setRestrictedView] = useState(false);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [tokenReady, setTokenReady] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUserState] = useState<User | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const report = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 403) {
      setDenied(reason.message);
    } else {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) setTokenReady(true);
      })
      .catch((reason) => report(reason));
    return () => {
      mountedRef.current = false;
    };
  }, [report]);

  // Once the shared token clears, load the mock principal roster and restore
  // the previously-selected principal if it is still valid.
  useEffect(() => {
    if (!tokenReady || currentUser) return;
    void api
      .users()
      .then(({ users: roster }) => {
        if (!mountedRef.current) return;
        setUsers(roster);
        const saved = localStorage.getItem(USER_STORAGE_KEY);
        const restored = roster.find((user) => user.id === saved);
        if (restored) void chooseUser(restored);
      })
      .catch((reason) => report(reason));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenReady, currentUser, report]);

  useEffect(() => {
    if (!currentUser) return;
    setActiveRun(null);
    setShowSettings(false);
    setShowAccess(false);
    setShowAudit(false);
    setDenied(null);
    setRestrictedView(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) => report(reason));
        }
      })
      .catch((reason) => {
        // A grant may cover invoke but not view_runs — opening the Agent then
        // hits a read the principal can't make. That's expected, not an error.
        if (reason instanceof ApiError && reason.status === 403) {
          setMessages([]);
          setRestrictedView(true);
        } else {
          report(reason);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMessages, selectedId, currentUser]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  async function chooseUser(user: User) {
    setCurrentUser(user.id);
    localStorage.setItem(USER_STORAGE_KEY, user.id);
    setCurrentUserState(user);
    setError(null);
    setDenied(null);
    setRestrictedView(false);
    setSelectedId(null);
    try {
      await bootstrap();
    } catch (reason) {
      report(reason);
    }
  }

  const switchUser = async (user: User) => {
    setAgents([]);
    setMessages([]);
    await chooseUser(user);
  };

  const signOut = () => {
    localStorage.removeItem(USER_STORAGE_KEY);
    setCurrentUser("");
    setCurrentUserState(null);
    setAgents([]);
    setMessages([]);
    setSelectedId(null);
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDenied(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    setDenied(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setDenied(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    setDenied(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } catch (reason) {
      // invoke without view_runs: the run was accepted, we just can't follow it.
      if (reason instanceof ApiError && reason.status === 403) {
        if (selectedIdRef.current === agentId) setRestrictedView(true);
        return;
      }
      throw reason;
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    setDenied(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      report(reason);
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await api.users();
      setTokenReady(true);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        report(reason);
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired && !tokenReady) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Choose a principal</h1>
          <p>
            Mock identity for the demo — every request is made as this user. Owners
            manage their Agents; others act only within a granted scope.
          </p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="user-pick-grid">
            {users.map((user) => (
              <button
                key={user.id}
                className="user-pick-card"
                onClick={() => void chooseUser(user)}
              >
                <span className="user-avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                <strong>{user.name}</strong>
                <span>{user.role}</span>
              </button>
            ))}
            {users.length === 0 && <Spinner />}
          </div>
        </section>
      </main>
    );
  }

  const isOwner = selected != null && selected.ownerId === currentUser.id;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <UserSwitcher users={users} current={currentUser} onSwitch={switchUser} />

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>
                  {agent.ownerId === currentUser.id ? "Owner" : "Granted access"}
                </span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              No Agents you can see. Create one, or ask an owner for a grant.
            </div>
          )}
        </nav>

        <button className="sidebar-signout" onClick={signOut}>
          Switch principal
        </button>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {denied && (
          <div className="denied-banner" role="alert">
            <span className="denied-badge">DENIED</span>
            <span>{denied}</span>
            <button onClick={() => setDenied(null)}>×</button>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  <span className="owner-tag">
                    {isOwner ? "you own this" : "owned by " +
                      (users.find((user) => user.id === selected.ownerId)?.name ?? selected.ownerId)}
                  </span>
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => {
                    setShowAudit((value) => !value);
                    setShowSettings(false);
                    setShowAccess(false);
                  }}
                >
                  Audit
                </button>
                {isOwner && (
                  <button
                    className="button button-ghost"
                    onClick={() => {
                      setShowAccess((value) => !value);
                      setShowSettings(false);
                      setShowAudit(false);
                    }}
                  >
                    Access
                  </button>
                )}
                <button
                  className="button button-ghost"
                  onClick={() => {
                    setShowSettings((value) => !value);
                    setShowAccess(false);
                    setShowAudit(false);
                  }}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showAccess && isOwner && (
              <AccessPanel
                agent={selected}
                users={users}
                currentUserId={currentUser.id}
                onClose={() => setShowAccess(false)}
                onError={report}
                onChanged={() => setAuditReloadKey((value) => value + 1)}
              />
            )}

            {showAudit && (
              <AuditPanel
                agent={selected}
                users={users}
                onClose={() => setShowAudit(false)}
                onError={report}
                reloadKey={auditReloadKey}
              />
            )}

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {restrictedView && (
                  <div className="view-note">
                    Your access to {selected.name} doesn't include <code>view_runs</code> —
                    you can send messages, but run history and output stay hidden.
                  </div>
                )}
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
