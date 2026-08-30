import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import { MemoryAuditStore } from "./audit-log/store/MemoryAuditStore.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  findRunAgentId: () => null,
} as unknown as AgentService;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function planeFor(): Promise<{
  policy: PolicyService;
  auditStore: MemoryAuditStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return { policy: new PolicyService(store), auditStore: new MemoryAuditStore() };
}

const alice = { "x-user-id": "user-alice" };

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const { policy, auditStore } = await planeFor();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      auditStore,
      policy,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token", ...alice },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("rejects an unknown principal even with a valid shared token", async () => {
    const { policy, auditStore } = await planeFor();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      auditStore,
      policy,
    );
    const denied = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-user-id": "user-nobody" },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  // The audit log is the evidence layer — it records who did what to which
  // Agent, so reading it must be gated by the shared token AND a known
  // principal, like every other /api/* route. This works only because the
  // createAuditRoutes plugin inherits the root onRequest hooks even though
  // it is registered above them in app.ts — locking that in.
  it("protects the audit log with the same gate as every other /api route", async () => {
    const { policy, auditStore } = await planeFor();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      auditStore,
      policy,
    );

    const noToken = await app.inject({ method: "GET", url: "/api/audit" });
    expect(noToken.statusCode).toBe(401);

    const noPrincipal = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(noPrincipal.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: "Bearer a-strong-test-token", ...alice },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ entries: [], nextCursor: null });
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const { policy, auditStore } = await planeFor();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      auditStore,
      policy,
    );
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", ...alice },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", ...alice },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});
