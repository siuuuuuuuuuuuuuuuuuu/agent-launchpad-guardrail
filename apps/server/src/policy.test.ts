import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type { Agent } from "./types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-policy-"));
  dirs.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const agent = {
    id: "agent-1",
    name: "A",
    description: "",
    instructions: "",
    ownerId: "user-alice",
    status: "ready",
    workspacePath: "/tmp/a",
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies Agent;
  await store.mutate((db) => db.agents.push(agent));
  return { store, policy: new PolicyService(store), agentId: agent.id };
}

describe("PolicyService.hasScope", () => {
  it("lets the owner do anything, including owner-only actions", async () => {
    const { policy, agentId } = await fixture();
    for (const action of ["invoke", "delete", "grant", "edit_config"] as const) {
      expect(policy.hasScope("user-alice", agentId, action).allow).toBe(true);
    }
  });

  it("denies a stranger with no grant", async () => {
    const { policy, agentId } = await fixture();
    const decision = policy.hasScope("user-bob", agentId, "invoke");
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("no live grant");
  });

  it("allows exactly the granted scope and nothing else", async () => {
    const { store, policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke"],
    });
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(true);
    expect(policy.hasScope("user-bob", agentId, "view_config").allow).toBe(false);
    expect(policy.hasScope("user-bob", agentId, "delete").allow).toBe(false);
    void store;
  });

  it("never confers owner-only actions through a grant", async () => {
    const { policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke", "view_config", "edit_config", "view_runs"],
    });
    expect(policy.hasScope("user-bob", agentId, "delete").allow).toBe(false);
    expect(policy.hasScope("user-bob", agentId, "grant").allow).toBe(false);
  });

  it("stops honouring a grant the instant it is revoked", async () => {
    const { policy, agentId } = await fixture();
    const grant = await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke"],
    });
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(true);
    await policy.revokeGrant(agentId, grant.id);
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(false);
  });

  it("ignores an expired grant", async () => {
    const { policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke"],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(false);
  });

  it("rejects an unknown principal and an unknown agent", async () => {
    const { policy, agentId } = await fixture();
    expect(policy.hasScope("user-ghost", agentId, "invoke").reason).toBe("unknown principal");
    expect(policy.hasScope("user-alice", "agent-missing", "invoke").reason).toBe(
      "agent not found",
    );
  });
});
