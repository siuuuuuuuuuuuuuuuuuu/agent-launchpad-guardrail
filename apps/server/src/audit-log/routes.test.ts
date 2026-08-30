import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuditRoutes } from "./routes.js";
import { AuditLogger } from "./logger.js";
import { MemoryAuditStore } from "./store/MemoryAuditStore.js";

describe("GET /api/audit", () => {
  let store: MemoryAuditStore;
  let logger: AuditLogger;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    store = new MemoryAuditStore();
    logger = new AuditLogger(store);
    app = Fastify();
    await app.register(createAuditRoutes(store));

    await logger.record({
      actor: { id: "user-a" },
      action: "invoke",
      target: { type: "agent", id: "agent-1" },
      decision: "allow",
    });
    await logger.record({
      actor: { id: "user-b" },
      action: "delete",
      target: { type: "agent", id: "agent-1" },
      decision: "deny",
    });
  });

  it("no query params = everything", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(2);
  });

  it("?actor=", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?actor=user-b" });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].actor.id).toBe("user-b");
  });

  it("?decision=", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?decision=deny" });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].decision).toBe("deny");
  });

  it("400s on a bogus decision value", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?decision=maybe" });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a bogus actorType", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?actorType=robot" });
    expect(res.statusCode).toBe(400);
  });

  it("respects limit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=1" });
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });

  it("400s on a non-numeric limit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=abc" });
    expect(res.statusCode).toBe(400);
  });

  it("400s on limit=0", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=0" });
    expect(res.statusCode).toBe(400);
  });

  it("400s on limit over the max", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=999" });
    expect(res.statusCode).toBe(400);
  });

  it("400s on an unparseable 'from'", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?from=not-a-date" });
    expect(res.statusCode).toBe(400);
  });

  it("400s on an unparseable 'to'", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?to=not-a-date" });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid ISO 'from'", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit?from=2020-01-01T00:00:00.000Z" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/audit with authorize", () => {
  it("403s when authorize returns false", async () => {
    const store = new MemoryAuditStore();
    const app = Fastify();
    await app.register(createAuditRoutes(store, { authorize: async () => false }));

    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(403);
  });

  it("lets it through when authorize returns true", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);
    await logger.record({
      actor: { id: "user-a" },
      action: "invoke",
      target: { type: "agent", id: "agent-1" },
      decision: "allow",
    });

    const app = Fastify();
    await app.register(createAuditRoutes(store, { authorize: async () => true }));

    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(1);
  });

  it("no authorize option = open access", async () => {
    const store = new MemoryAuditStore();
    const app = Fastify();
    await app.register(createAuditRoutes(store));

    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
  });
});
