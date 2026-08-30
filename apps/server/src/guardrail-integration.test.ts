import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuditLogger } from "./audit-log/logger.js";
import { JsonlAuditStore } from "./audit-log/store/JsonlAuditStore.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

// End-to-end across all three new subsystems: identity (X-User-Id) → enforcement
// (both checkpoints) → audit (real JsonlAuditStore, read back through the real
// GET /api/audit route the UI uses). If this passes, the demo's audit beat works.

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

class FakeRunner implements AgentRunner {
  async run() {
    return { output: "ok", threadId: "thread-1", usage: null };
  }
  async cancel() {
    return false;
  }
  async isAvailable() {
    return true;
  }
}

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-integ-"));
  dirs.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const auditFile = path.join(root, "audit.jsonl");
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const policy = new PolicyService(store);
  const auditStore = new JsonlAuditStore(auditFile);
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
    policy,
    new AuditLogger(auditStore),
  );
  await service.initialize();
  const app = await createApp(config, service, auditStore, policy);
  return { app, service, auditFile };
}

const as = (userId: string) => ({ "x-user-id": userId });

async function auditRows(app: Awaited<ReturnType<typeof harness>>["app"], query = "") {
  const res = await app.inject({ method: "GET", url: "/api/audit" + query, headers: as("user-alice") });
  expect(res.statusCode).toBe(200);
  return (res.json() as { entries: Array<Record<string, any>> }).entries;
}

describe("guardrail integration: identity → enforcement → audit", () => {
  it("writes the whole demo sequence to the real audit store, readable via GET /api/audit", async () => {
    const { app, auditFile } = await harness();

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Playground" },
    });
    const agentId = created.json().agent.id as string;

    // Bob denied, Alice grants, Bob allowed, Bob denied delete, Alice revokes, Bob denied.
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: as("user-bob"),
      payload: { content: "hi" },
    });
    const grant = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: as("user-alice"),
      payload: { grantedTo: "user-bob", scopes: ["invoke"] },
    });
    const grantId = grant.json().grant.id as string;
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: as("user-bob"),
      payload: { content: "hi" },
    });
    await app.inject({ method: "DELETE", url: `/api/agents/${agentId}`, headers: as("user-bob") });
    await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}/grants/${grantId}`,
      headers: as("user-alice"),
    });
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: as("user-bob"),
      payload: { content: "hi again" },
    });

    const rows = await auditRows(app, `?target=${agentId}&limit=200`);
    const sequence = rows
      .map((e) => `${e.actor.id}:${e.action}:${e.decision}`)
      .reverse();

    // the demo beats all landed (runtime-checkpoint allows may be interleaved).
    expect(sequence).toEqual(
      expect.arrayContaining([
        "user-alice:create:allow",
        "user-bob:invoke:deny",
        "user-alice:grant:allow",
        "user-bob:invoke:allow",
        "user-bob:delete:deny",
        "user-alice:revoke:allow",
      ]),
    );
    // the two Bob invoke denials plus the delete denial — nothing else denied.
    expect(sequence.filter((s) => s.endsWith(":deny"))).toEqual([
      "user-bob:invoke:deny",
      "user-bob:delete:deny",
      "user-bob:invoke:deny",
    ]);

    // every row is renderable by the log view.
    for (const e of rows) {
      expect(e.actor?.id).toBeTruthy();
      expect(e.decision).toMatch(/^(allow|deny)$/);
      expect(e.target?.id).toBeTruthy();
      expect(e.timestamp).toBeTruthy();
    }

    // grant/revoke are logged once each (handler entry, not a second checkpoint one).
    expect(rows.filter((e) => e.action === "grant" && e.decision === "allow")).toHaveLength(1);
    expect(rows.filter((e) => e.action === "revoke")).toHaveLength(1);

    // the store actually persisted to disk.
    const onDisk = (await readFile(auditFile, "utf8")).trim().split("\n");
    expect(onDisk.length).toBe(rows.length);

    await app.close();
  });

  it("logs an allowed invoke at BOTH the request and runtime checkpoints", async () => {
    const { app } = await harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Dual" },
    });
    const agentId = created.json().agent.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: as("user-alice"),
      payload: { content: "go" },
    });
    expect(sent.statusCode).toBe(202);

    await expect
      .poll(async () => {
        const rows = await auditRows(app, `?target=${agentId}&action=invoke&decision=allow`);
        return new Set(rows.map((e) => e.payload?.checkpoint));
      })
      .toEqual(new Set(["request", "runtime"]));

    await app.close();
  });

  it("filters by decision and by actor the way the UI does", async () => {
    const { app } = await harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Filter" },
    });
    const agentId = created.json().agent.id as string;
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: as("user-carol"),
      payload: { content: "no access" },
    });

    const denies = await auditRows(app, "?decision=deny");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies.every((e) => e.decision === "deny")).toBe(true);

    const carol = await auditRows(app, "?actor=user-carol");
    expect(carol.every((e) => e.actor.id === "user-carol")).toBe(true);
    expect(carol.some((e) => e.action === "invoke" && e.decision === "deny")).toBe(true);

    await app.close();
  });

  it("stops honouring an expired grant on the next HTTP request", async () => {
    const { app } = await harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Expiry" },
    });
    const agentId = created.json().agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: as("user-alice"),
      payload: {
        grantedTo: "user-bob",
        scopes: ["invoke"],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });

    const blocked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: as("user-bob"),
      payload: { content: "too late" },
    });
    expect(blocked.statusCode).toBe(403);

    await app.close();
  });

  it("rejects an unknown principal before any enforcement rule runs", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-user-id": "user-nobody" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("scopes the audit read to what the caller may see", async () => {
    const { app } = await harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Scoped" },
    });
    const agentId = created.json().agent.id as string;

    // a standard user with no grant cannot read this Agent's log.
    const blocked = await app.inject({
      method: "GET",
      url: `/api/audit?target=${agentId}`,
      headers: as("user-bob"),
    });
    expect(blocked.statusCode).toBe(403);

    // grant Bob invoke — now canSee is true and the targeted read is allowed.
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: as("user-alice"),
      payload: { grantedTo: "user-bob", scopes: ["invoke"] },
    });
    const allowed = await app.inject({
      method: "GET",
      url: `/api/audit?target=${agentId}`,
      headers: as("user-bob"),
    });
    expect(allowed.statusCode).toBe(200);

    // an untargeted read by a standard user is narrowed to their own actions.
    await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: as("user-bob"),
    });
    const mine = await app.inject({ method: "GET", url: "/api/audit", headers: as("user-bob") });
    expect(mine.statusCode).toBe(200);
    const rows = (mine.json() as { entries: Array<Record<string, any>> }).entries;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.actor.id === "user-bob")).toBe(true);

    // the operator (owner-capable) still sees the whole log.
    const operator = await app.inject({ method: "GET", url: "/api/audit", headers: as("user-alice") });
    expect(
      (operator.json() as { entries: unknown[] }).entries.length,
    ).toBeGreaterThan(rows.length);

    await app.close();
  });
});
