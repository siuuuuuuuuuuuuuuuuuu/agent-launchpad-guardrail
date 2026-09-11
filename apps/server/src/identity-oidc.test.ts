import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { AuditLogger } from "./audit-log/logger.js";
import { MemoryAuditStore } from "./audit-log/store/MemoryAuditStore.js";
import { loadConfig } from "./config.js";
import { resetDiscoveryCache } from "./identity/discovery.js";
import { resetJwksCache } from "./identity/oidc-client.js";
import { type FakeIdp, startFakeIdp } from "./identity/test-idp.js";
import { PolicyService } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

// Real OIDC flow end to end: discovery -> Authorization Code + PKCE ->
// signature-verified id_token -> JIT provisioning -> our own session token ->
// authenticated requests through the SAME enforcement layer the local-mode
// tests exercise. Nothing here is stubbed at the network boundary; the fake
// IdP (identity/test-idp.ts) is a real HTTP server signing real RS256 tokens.

class FakeRunner implements AgentRunner {
  async run() {
    return { output: "ok", threadId: "t", usage: null };
  }
  async cancel() {
    return false;
  }
  async isAvailable() {
    return true;
  }
}

const dirs: string[] = [];
let idp: FakeIdp;

beforeEach(async () => {
  idp = await startFakeIdp();
});

afterEach(async () => {
  await idp.close();
  resetDiscoveryCache();
  resetJwksCache();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function harness(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-oidc-"));
  dirs.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    AUTH_MODE: "oidc",
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    OIDC_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
    SESSION_SECRET: "x".repeat(32),
    ...overrides,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const policy = new PolicyService(store);
  const auditStore = new MemoryAuditStore();
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
  return { app, config };
}

function stateFromLoginRedirect(location: string): string {
  const url = new URL(location);
  const state = url.searchParams.get("state");
  if (!state) throw new Error("login redirect carried no state");
  return state;
}

function handoffCodeFromCallbackRedirect(location: string): string {
  const url = new URL(location, "http://localhost");
  const code = url.searchParams.get("auth");
  if (!code) throw new Error("callback redirect carried no auth code");
  return code;
}

async function login(
  app: Awaited<ReturnType<typeof harness>>["app"],
  claims: { sub: string; email?: string; name?: string },
): Promise<string> {
  idp.setNextClaims(claims);
  const start = await app.inject({ method: "GET", url: "/api/auth/login" });
  expect(start.statusCode).toBe(302);
  const state = stateFromLoginRedirect(start.headers.location as string);

  const callback = await app.inject({
    method: "GET",
    url: "/api/auth/callback?code=idp-issued-code&state=" + state,
  });
  expect(callback.statusCode).toBe(302);
  const handoff = handoffCodeFromCallbackRedirect(callback.headers.location as string);

  const exchange = await app.inject({
    method: "POST",
    url: "/api/auth/exchange",
    payload: { code: handoff },
  });
  expect(exchange.statusCode).toBe(200);
  return exchange.json().token as string;
}

describe("OIDC identity", () => {
  it("logs a real user in and resolves them as the request principal", async () => {
    const { app } = await harness();
    const token = await login(app, { sub: "idp|alice", email: "alice@example.com", name: "Alice" });

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer " + token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
      role: "standard",
    });
    await app.close();
  });

  it("provisions owner-capable for an allow-listed admin email", async () => {
    const { app } = await harness({ OIDC_ADMIN_EMAILS: "boss@example.com, other@example.com" });
    const token = await login(app, { sub: "idp|boss", email: "Boss@Example.com", name: "Boss" });
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer " + token },
    });
    expect(me.json().user.role).toBe("owner-capable");
    await app.close();
  });

  it("re-provisions the same idp subject to the same local user on a second login", async () => {
    const { app } = await harness();
    const first = await login(app, { sub: "idp|carol", email: "carol@example.com", name: "Carol" });
    const firstMe = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer " + first },
    });
    const second = await login(app, { sub: "idp|carol", email: "carol@example.com", name: "Carol R." });
    const secondMe = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer " + second },
    });
    expect(secondMe.json().user.id).toBe(firstMe.json().user.id);
    expect(secondMe.json().user.name).toBe("Carol R.");
    await app.close();
  });

  it("runs the full authorization flow for a real OIDC-provisioned actor", async () => {
    const { app } = await harness();
    const ownerToken = await login(app, { sub: "idp|owner", email: "owner@example.com" });
    const otherToken = await login(app, { sub: "idp|other", email: "other@example.com" });

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: "Bearer " + ownerToken },
      payload: { name: "Builder" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const denied = await app.inject({
      method: "DELETE",
      url: "/api/agents/" + agentId,
      headers: { authorization: "Bearer " + otherToken },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a handoff code used twice", async () => {
    const { app } = await harness();
    idp.setNextClaims({ sub: "idp|dave", email: "dave@example.com" });
    const start = await app.inject({ method: "GET", url: "/api/auth/login" });
    const state = stateFromLoginRedirect(start.headers.location as string);
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=x&state=" + state,
    });
    const handoff = handoffCodeFromCallbackRedirect(callback.headers.location as string);

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/exchange",
      payload: { code: handoff },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/exchange",
      payload: { code: handoff },
    });
    expect(second.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a callback with an unknown or reused state", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=x&state=never-issued",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a request with a garbage bearer token", async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("does not accept the coarse APP_AUTH_TOKEN gate as a session in oidc mode", async () => {
    const { app } = await harness({ APP_AUTH_TOKEN: "a".repeat(32) });
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer " + "a".repeat(32) },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("requires auth for /api/users once real identity is on (no mock roster leak)", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("404s the OIDC routes when AUTH_MODE is local (the default)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-oidc-local-"));
    dirs.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const policy = new PolicyService(store);
    const auditStore = new MemoryAuditStore();
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
    expect((await app.inject({ method: "GET", url: "/api/auth/login" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/auth" })).json()).toMatchObject({
      mode: "local",
    });
    await app.close();
  });
});

describe("OIDC config validation", () => {
  it("requires the OIDC_* variables and a strong SESSION_SECRET", () => {
    expect(() => loadConfig({ NODE_ENV: "test", AUTH_MODE: "oidc" })).toThrow(
      /requires OIDC_ISSUER/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        AUTH_MODE: "oidc",
        OIDC_ISSUER: "https://idp.example.com",
        OIDC_CLIENT_ID: "id",
        OIDC_CLIENT_SECRET: "secret",
        OIDC_REDIRECT_URI: "https://app.example.com/api/auth/callback",
        SESSION_SECRET: "too-short",
      }),
    ).toThrow(/SESSION_SECRET/);
  });
});
