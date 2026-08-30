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

  it("allows a future expiry and rejects a past expiry", async () => {
    const { policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(true);

    await policy.createGrant({
      agentId,
      grantedTo: "user-carol",
      grantedBy: "user-alice",
      scopes: ["invoke"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(policy.hasScope("user-carol", agentId, "invoke").allow).toBe(false);
  });

  it("revocation is effective immediately", async () => {
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

  it("owner access works without a grant", async () => {
    const { policy, agentId } = await fixture();
    expect(policy.hasScope("user-alice", agentId, "invoke").allow).toBe(true);
    expect(policy.hasScope("user-alice", agentId, "delete").allow).toBe(true);
  });

  it("rejects an unknown principal and an unknown agent", async () => {
    const { policy, agentId } = await fixture();
    expect(policy.hasScope("user-ghost", agentId, "invoke").reason).toBe("unknown principal");
    expect(policy.hasScope("user-alice", "agent-missing", "invoke").reason).toBe(
      "agent not found",
    );
  });

  it("isolates grants to the correct Agent", async () => {
    const { store, policy } = await fixture();
    const agentA = {
      id: "agent-a",
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
    const agentB = {
      id: "agent-b",
      name: "B",
      description: "",
      instructions: "",
      ownerId: "user-alice",
      status: "ready",
      workspacePath: "/tmp/b",
      codexThreadId: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies Agent;
    await store.mutate((db) => {
      db.agents.push(agentA, agentB);
    });
    await policy.createGrant({
      agentId: agentA.id,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke"],
    });
    expect(policy.hasScope("user-bob", agentA.id, "invoke").allow).toBe(true);
    expect(policy.hasScope("user-bob", agentB.id, "invoke").allow).toBe(false);
  });

  it("isolates grants to the correct user", async () => {
    const { policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke"],
    });
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(true);
    expect(policy.hasScope("user-carol", agentId, "invoke").allow).toBe(false);
  });

  it("accepts multiple granted scopes while denying ungranted ones", async () => {
    const { policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke", "view_config"],
    });
    expect(policy.hasScope("user-bob", agentId, "invoke").allow).toBe(true);
    expect(policy.hasScope("user-bob", agentId, "view_config").allow).toBe(true);
    expect(policy.hasScope("user-bob", agentId, "view_runs").allow).toBe(false);
  });

  it("denies owner-only actions even to a delegated user", async () => {
    const { policy, agentId } = await fixture();
    await policy.createGrant({
      agentId,
      grantedTo: "user-bob",
      grantedBy: "user-alice",
      scopes: ["invoke", "view_config", "edit_config", "view_runs"],
    });
    expect(policy.hasScope("user-bob", agentId, "delete").allow).toBe(false);
    expect(policy.hasScope("user-bob", agentId, "grant").allow).toBe(false);
    expect(policy.hasScope("user-bob", agentId, "revoke").allow).toBe(false);
  });

  it("rejects invalid grant scopes before they are persisted", async () => {
    const { policy, agentId } = await fixture();
    await expect(
      policy.createGrant({
        agentId,
        grantedTo: "user-bob",
        grantedBy: "user-alice",
        scopes: ["invoke", "not-a-real-scope" as never],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
