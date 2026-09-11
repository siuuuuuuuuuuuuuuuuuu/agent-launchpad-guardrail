import type {
  Agent,
  AgentRun,
  AuditPage,
  Grant,
  GuardrailPolicy,
  GuardrailPolicyResponse,
  GuardrailRuleInput,
  GuardrailSandboxMode,
  Message,
  Scope,
  SystemInfo,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";
let currentUserId = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

/** Mock identity: the selected principal is sent on every request as X-User-Id. */
export function setCurrentUser(userId: string): void {
  currentUserId = userId.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...(currentUserId ? { "X-User-Id": currentUserId } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean; mode: "local" | "oidc" }>("/api/auth"),
  // AUTH_MODE=oidc only: exchange the one-time code from the /api/auth/callback
  // redirect for the app's session token, and best-effort logout.
  exchange: (code: string) =>
    request<{ token: string }>("/api/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),

  // Identity & Policy plane
  users: () => request<{ users: User[] }>("/api/users"),
  me: () => request<{ user: User }>("/api/me"),
  grants: (agentId: string) =>
    request<{ grants: Grant[] }>("/api/agents/" + agentId + "/grants"),
  createGrant: (
    agentId: string,
    body: { grantedTo: string; scopes: Scope[]; expiresAt?: string },
  ) =>
    request<{ grant: Grant }>("/api/agents/" + agentId + "/grants", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeGrant: (agentId: string, grantId: string) =>
    request<{ grant: Grant }>(
      "/api/agents/" + agentId + "/grants/" + grantId,
      { method: "DELETE" },
    ),

  // Runtime guardrails
  guardrail: (agentId: string) =>
    request<GuardrailPolicyResponse>("/api/agents/" + agentId + "/guardrail"),
  setGuardrail: (
    agentId: string,
    body: {
      sandboxMode: GuardrailSandboxMode;
      networkAccess: boolean;
      rules: GuardrailRuleInput[];
    },
  ) =>
    request<{ policy: GuardrailPolicy }>("/api/agents/" + agentId + "/guardrail", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  // GET /api/audit — filters: actor, action, target, decision, from, to, limit, cursor
  audit: (params: Record<string, string> = {}) =>
    request<AuditPage>(
      "/api/audit" +
        (Object.keys(params).length
          ? "?" + new URLSearchParams(params).toString()
          : ""),
    ),
};
