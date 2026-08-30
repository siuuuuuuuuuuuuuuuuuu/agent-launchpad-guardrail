import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "./logger.js";
import { MemoryAuditStore } from "./store/MemoryAuditStore.js";
import type { AuditEntry, AuditQueryFilter, AuditQueryResult, AuditStore } from "./types.js";

describe("AuditLogger.record", () => {
  it("writes an entry with a generated id + timestamp", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    const entry = await logger.record({
      actor: { id: "user-b" },
      action: "invoke",
      target: { type: "agent", id: "agent-1" },
      decision: "deny",
    });

    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
    expect(entry.actor).toEqual({ id: "user-b", type: "human" });
    expect(entry.decision).toBe("deny");

    const { entries } = await store.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(entry.id);
  });

  it("redacts the payload before it hits the store", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    await logger.record({
      actor: { id: "user-a" },
      action: "invoke",
      target: { type: "agent", id: "agent-1" },
      decision: "allow",
      payload: { arkKey: "secret-value", reason: "scoped invoke" },
    });

    const { entries } = await store.query({});
    expect(entries[0]!.payload).toEqual({ arkKey: "[REDACTED]", reason: "scoped invoke" });
  });

  it("keeps an explicit actor.type instead of defaulting", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    const entry = await logger.record({
      actor: { id: "agent-runner", type: "agent" },
      action: "invoke",
      target: { type: "agent", id: "agent-1" },
      decision: "allow",
    });

    expect(entry.actor.type).toBe("agent");
  });

  it("throws if actor.id is missing", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    await expect(
      logger.record({
        actor: { id: "" },
        action: "invoke",
        target: { type: "agent", id: "agent-1" },
        decision: "allow",
      }),
    ).rejects.toThrow(/actor\.id is required/);

    expect((await store.query({})).entries).toHaveLength(0);
  });

  it("throws on a bogus decision value", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    await expect(
      logger.record({
        actor: { id: "user-a" },
        action: "invoke",
        target: { type: "agent", id: "agent-1" },
        decision: "maybe" as never,
      }),
    ).rejects.toThrow(/decision must be/);
  });

  it("throws if target.id is missing", async () => {
    const store = new MemoryAuditStore();
    const logger = new AuditLogger(store);

    await expect(
      logger.record({
        actor: { id: "user-a" },
        action: "invoke",
        target: { type: "agent", id: "" },
        decision: "allow",
      }),
    ).rejects.toThrow(/target\.id is required/);
  });

  describe("store write fails", () => {
    function makeFailingStore(): AuditStore {
      return {
        append: vi.fn(async (_entry: AuditEntry) => {
          throw new Error("disk full");
        }),
        query: vi.fn(async (_filter: AuditQueryFilter): Promise<AuditQueryResult> => ({
          entries: [],
          nextCursor: null,
        })),
      };
    }

    it("non-strict (default): still resolves, doesn't break the caller", async () => {
      const store = makeFailingStore();
      const logger = new AuditLogger(store);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const entry = await logger.record({
        actor: { id: "user-a" },
        action: "invoke",
        target: { type: "agent", id: "agent-1" },
        decision: "allow",
      });

      expect(entry.decision).toBe("allow");
      expect(errorSpy).toHaveBeenCalled(); // failure still has to show up somewhere
      errorSpy.mockRestore();
    });

    it("strict: true rethrows so the caller can fail closed", async () => {
      const store = makeFailingStore();
      const logger = new AuditLogger(store, { strict: true });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        logger.record({
          actor: { id: "user-a" },
          action: "invoke",
          target: { type: "agent", id: "agent-1" },
          decision: "allow",
        }),
      ).rejects.toThrow(/disk full/);

      errorSpy.mockRestore();
    });
  });
});
