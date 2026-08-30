import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuditLogger } from "./audit-log/logger.js";
import { MemoryAuditStore } from "./audit-log/store/MemoryAuditStore.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  // A FakeRunner run settles a tick after the test returns; on Windows its
  // trailing store write can race the cleanup (ENOTEMPTY). Retry briefly.
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
    return { output: "done", threadId: "thread-1", usage: null };
  }
  async cancel() {
    return false;
  }
  async isAvailable() {
    return true;
  }
}

async function harness(runner: AgentRunner = new FakeRunner()) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-enf-"));
  dirs.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const policy = new PolicyService(store);
  const auditStore = new MemoryAuditStore();
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    policy,
    new AuditLogger(auditStore),
  );
  await service.initialize();
  const app = await createApp(config, service, auditStore, policy);
  return { app, service, policy, auditStore };
}

const as = (userId: string) => ({ "x-user-id": userId });

// Flatten jone's audit entries to "actor:action:decision" for terse assertions.
async function decisions(store: MemoryAuditStore, targetId: string) {
  const { entries } = await store.query({ targetId });
  return entries;
}

describe("Enforcement Point — request boundary", () => {
  it("runs the delegated-access demo scenario end to end", async () => {
    const { app, auditStore } = await harness();

    // 1. Alice creates an Agent — she becomes the owner.
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Builder" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;
    expect(created.json().agent.ownerId).toBe("user-alice");

    // 2. Bob invokes without a grant — denied server-side.
    const blocked = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: as("user-bob"),
      payload: { content: "hello" },
    });
    expect(blocked.statusCode).toBe(403);

    // 3. Alice grants Bob invoke-only.
    const grant = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/grants",
      headers: as("user-alice"),
      payload: { grantedTo: "user-bob", scopes: ["invoke"] },
    });
    expect(grant.statusCode).toBe(201);
    const grantId = grant.json().grant.id as string;

    // 4. Bob invokes — allowed, logged.
    const invoked = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: as("user-bob"),
      payload: { content: "hello" },
    });
    expect(invoked.statusCode).toBe(202);

    // 5. Bob tries to delete (outside scope) — denied, even via direct API.
    const deleteAttempt = await app.inject({
      method: "DELETE",
      url: "/api/agents/" + agentId,
      headers: as("user-bob"),
    });
    expect(deleteAttempt.statusCode).toBe(403);
    expect(deleteAttempt.json().error).toContain("owner-only");

    // 6. Alice revokes Bob's grant.
    const revoke = await app.inject({
      method: "DELETE",
      url: "/api/agents/" + agentId + "/grants/" + grantId,
      headers: as("user-alice"),
    });
    expect(revoke.statusCode).toBe(200);

    // 7. Bob invokes again — denied, though it was allowed moments ago.
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: as("user-bob"),
      payload: { content: "hello again" },
    });
    expect(afterRevoke.statusCode).toBe(403);

    // 8. Alice is unaffected throughout.
    const aliceInvoke = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: as("user-alice"),
      payload: { content: "owner still works" },
    });
    expect(aliceInvoke.statusCode).toBe(202);

    // Audit trail carries every decision.
    const trail = await decisions(auditStore, agentId);
    const summary = trail.map((e) => e.actor.id + ":" + e.action + ":" + e.decision);
    expect(summary).toContain("user-bob:invoke:deny");
    expect(summary).toContain("user-bob:invoke:allow");
    expect(summary).toContain("user-bob:delete:deny");
    expect(summary).toContain("user-alice:grant:allow");
    expect(summary).toContain("user-alice:revoke:allow");

    // Dual checkpoint: the invoke Bob was allowed is logged at both boundaries.
    const bobInvokeAllows = trail.filter(
      (e) => e.actor.id === "user-bob" && e.action === "invoke" && e.decision === "allow",
    );
    const checkpoints = new Set(
      bobInvokeAllows.map((e) => (e.payload as { checkpoint?: string })?.checkpoint),
    );
    expect(checkpoints.has("request")).toBe(true);
    expect(checkpoints.has("runtime")).toBe(true);

    // grant/revoke are logged exactly once (the handler's rich entry — the
    // checkpoint defers its allow write), and each carries the grant detail.
    const grantEntries = trail.filter((e) => e.action === "grant" && e.decision === "allow");
    expect(grantEntries).toHaveLength(1);
    expect(grantEntries[0]!.payload).toMatchObject({ grantedTo: "user-bob", scopes: ["invoke"] });
    expect(trail.filter((e) => e.action === "revoke")).toHaveLength(1);

    await app.close();
  });

  it("still logs a denied grant attempt from a non-owner", async () => {
    const { app, auditStore } = await harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Builder" },
    });
    const agentId = created.json().agent.id as string;

    const denied = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/grants",
      headers: as("user-bob"),
      payload: { grantedTo: "user-carol", scopes: ["invoke"] },
    });
    expect(denied.statusCode).toBe(403);

    const { entries } = await auditStore.query({ targetId: agentId, action: "grant" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decision).toBe("deny");
    await app.close();
  });

  it("filters the Agent listing to owned + granted Agents", async () => {
    const { app } = await harness();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: as("user-alice"),
      payload: { name: "Private" },
    });
    const agentId = created.json().agent.id as string;

    expect(
      (await app.inject({ method: "GET", url: "/api/agents", headers: as("user-bob") })).json()
        .agents,
    ).toHaveLength(0);

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/grants",
      headers: as("user-alice"),
      payload: { grantedTo: "user-bob", scopes: ["view_config"] },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/agents", headers: as("user-bob") })).json()
        .agents,
    ).toHaveLength(1);
    await app.close();
  });

  it("rejects requests with no principal header", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("Enforcement Point — runtime boundary", () => {
  it("blocks a run that bypassed the request boundary", async () => {
    const { service, auditStore } = await harness();
    const agent = await service.createAgent({ name: "Builder" }, "user-alice");

    // Call the service directly as Bob — no HTTP, no grant. The request-boundary
    // check never ran, but the runtime checkpoint fails the run closed.
    await service.sendMessage(agent.id, "do work", "user-bob");
    await expect
      .poll(async () => service.getRuns(agent.id)[0]?.status)
      .toBe("failed");

    const { entries } = await auditStore.query({
      targetId: agent.id,
      action: "invoke",
      decision: "deny",
    });
    const runtimeDeny = entries.find(
      (e) => (e.payload as { checkpoint?: string })?.checkpoint === "runtime",
    );
    expect(runtimeDeny).toBeDefined();
  });
});
