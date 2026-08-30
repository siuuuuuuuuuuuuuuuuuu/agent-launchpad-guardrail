import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import { JsonAuditLog } from "./audit.js";
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

async function planeFor(): Promise<{ policy: PolicyService; audit: JsonAuditLog }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return { policy: new PolicyService(store), audit: new JsonAuditLog(store) };
}

const alice = { "x-user-id": "user-alice" };

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const { policy, audit } = await planeFor();
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      policy,
      audit,
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
    const { policy, audit } = await planeFor();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, policy, audit);
    const denied = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-user-id": "user-nobody" },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const { policy, audit } = await planeFor();
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, policy, audit);
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
