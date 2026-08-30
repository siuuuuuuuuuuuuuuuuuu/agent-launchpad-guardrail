import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { JsonAuditLog } from "./audit.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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
  const audit = new JsonAuditLog(store);
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    policy,
    audit,
  );
  await service.initialize();
  const app = await createApp(config, service, policy, audit);
  return { app, service, policy, audit };
}

const as = (userId: string) => ({ "x-user-id": userId });

describe("Enforcement Point — request boundary", () => {
  it("runs the delegated-access demo scenario end to end", async () => {
    const { app, audit } = await harness();

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
    const trail = audit.query({ agentId });
    const summary = trail.map((e) => e.actorUserId + ":" + e.action + ":" + e.decision);
    expect(summary).toContain("user-bob:invoke:deny");
    expect(summary).toContain("user-bob:invoke:allow");
    expect(summary).toContain("user-bob:delete:deny");
    expect(summary).toContain("user-alice:grant:allow");
    expect(summary).toContain("user-alice:revoke:allow");
    // Dual checkpoint: the invoke that Bob was allowed is logged twice.
    const bobInvokeAllows = trail.filter(
      (e) => e.actorUserId === "user-bob" && e.action === "invoke" && e.decision === "allow",
    );
    expect(bobInvokeAllows.some((e) => e.result.startsWith("request"))).toBe(true);
    expect(bobInvokeAllows.some((e) => e.result.startsWith("runtime"))).toBe(true);

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

    expect((await app.inject({ method: "GET", url: "/api/agents", headers: as("user-bob") })).json().agents).toHaveLength(0);

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/grants",
      headers: as("user-alice"),
      payload: { grantedTo: "user-bob", scopes: ["view_config"] },
    });
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: as("user-bob") })).json().agents).toHaveLength(1);
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
    const { service, audit } = await harness();
    const agent = await service.createAgent({ name: "Builder" }, "user-alice");

    // Call the service directly as Bob — no HTTP, no grant. The request-boundary
    // check never ran, but the runtime checkpoint fails the run closed.
    await service.sendMessage(agent.id, "do work", "user-bob");
    await expect
      .poll(async () => {
        const runs = service.getRuns(agent.id);
        return runs[0]?.status;
      })
      .toBe("failed");

    const runtimeDeny = audit
      .query({ agentId: agent.id, action: "invoke", decision: "deny" })
      .find((e) => e.result.startsWith("runtime"));
    expect(runtimeDeny).toBeDefined();
  });
});
