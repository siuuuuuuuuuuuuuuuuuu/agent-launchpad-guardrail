import Fastify from "fastify";
import { describe, expect, it } from "vitest";
// deliberately importing from the public barrel, not internal files - this
// is what enforcement/identity/frontend actually import, so it needs its
// own coverage instead of relying on the other test files hitting the
// internals directly.
import {
  AuditLogger,
  MemoryAuditStore,
  createAuditRoutes,
  redactPayload,
  type AuditEntry,
} from "./index.js";

describe("public entry point (src/index.ts)", () => {
  it("exports everything callers are told to import", () => {
    expect(AuditLogger).toBeTypeOf("function");
    expect(MemoryAuditStore).toBeTypeOf("function");
    expect(createAuditRoutes).toBeTypeOf("function");
    expect(redactPayload).toBeTypeOf("function");
  });

  it("works end to end through the barrel: record, query, route", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    await logger.record({
      actor: { id: "user-a" },
      action: "invoke",
      target: { type: "agent", id: "agent-1" },
      decision: "allow",
      payload: { token: "should-be-redacted" },
    });

    const app = Fastify();
    await app.register(createAuditRoutes(store));

    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { entries: AuditEntry[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.payload).toEqual({ token: "[REDACTED]" });
  });
});
