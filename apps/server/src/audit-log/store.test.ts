import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry, AuditStore } from "./types.js";
import { MemoryAuditStore } from "./store/MemoryAuditStore.js";
import { JsonlAuditStore } from "./store/JsonlAuditStore.js";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    actor: overrides.actor ?? { id: "user-a", type: "human" },
    action: overrides.action ?? "invoke",
    target: overrides.target ?? { type: "agent", id: "agent-1" },
    decision: overrides.decision ?? "allow",
    payload: overrides.payload ?? null,
  };
}

// run the same tests against both store impls so they can't drift apart
describe.each([
  {
    name: "MemoryAuditStore",
    makeStore: (): AuditStore => new MemoryAuditStore(),
  },
  {
    name: "JsonlAuditStore",
    makeStore: (() => {
      return (): AuditStore => {
        const dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
        return new JsonlAuditStore(join(dir, "audit.jsonl"));
      };
    })(),
  },
])("$name (AuditStore contract)", ({ makeStore }) => {
  let store: AuditStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("append returns what you gave it", async () => {
    const entry = makeEntry();
    const result = await store.append(entry);
    expect(result).toEqual(entry);
  });

  it("no filter = everything, newest first", async () => {
    const older = makeEntry({ id: "1", timestamp: "2026-08-30T10:00:00.000Z" });
    const newer = makeEntry({ id: "2", timestamp: "2026-08-30T10:05:00.000Z" });
    await store.append(older);
    await store.append(newer);

    const result = await store.query({});
    expect(result.entries.map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("filters by actorId", async () => {
    await store.append(makeEntry({ id: "1", actor: { id: "user-a" } }));
    await store.append(makeEntry({ id: "2", actor: { id: "user-b" } }));

    const result = await store.query({ actorId: "user-b" });
    expect(result.entries.map((e) => e.id)).toEqual(["2"]);
  });

  it("filters by decision", async () => {
    await store.append(makeEntry({ id: "1", decision: "allow" }));
    await store.append(makeEntry({ id: "2", decision: "deny" }));

    const result = await store.query({ decision: "deny" });
    expect(result.entries.map((e) => e.id)).toEqual(["2"]);
  });

  it("filters by targetId + action together", async () => {
    await store.append(makeEntry({ id: "1", target: { type: "agent", id: "agent-1" }, action: "invoke" }));
    await store.append(makeEntry({ id: "2", target: { type: "agent", id: "agent-2" }, action: "invoke" }));
    await store.append(makeEntry({ id: "3", target: { type: "agent", id: "agent-1" }, action: "delete" }));

    const result = await store.query({ targetId: "agent-1", action: "invoke" });
    expect(result.entries.map((e) => e.id)).toEqual(["1"]);
  });

  it("filters by time range, inclusive", async () => {
    await store.append(makeEntry({ id: "1", timestamp: "2026-08-30T09:00:00.000Z" }));
    await store.append(makeEntry({ id: "2", timestamp: "2026-08-30T10:00:00.000Z" }));
    await store.append(makeEntry({ id: "3", timestamp: "2026-08-30T11:00:00.000Z" }));

    const result = await store.query({ from: "2026-08-30T10:00:00.000Z", to: "2026-08-30T10:30:00.000Z" });
    expect(result.entries.map((e) => e.id)).toEqual(["2"]);
  });

  it("paginates with limit + cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(
        makeEntry({ id: `${i}`, timestamp: new Date(2026, 7, 30, 10, i).toISOString() }),
      );
    }

    const page1 = await store.query({ limit: 2 });
    expect(page1.entries.map((e) => e.id)).toEqual(["4", "3"]);
    expect(page1.nextCursor).toBe("3");

    const page2 = await store.query({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.entries.map((e) => e.id)).toEqual(["2", "1"]);
    expect(page2.nextCursor).toBe("1");

    const page3 = await store.query({ limit: 2, cursor: page2.nextCursor! });
    expect(page3.entries.map((e) => e.id)).toEqual(["0"]);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("JsonlAuditStore persistence", () => {
  it("survives reopening the same file (simulates a backend restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
    const filePath = join(dir, "audit.jsonl");
    try {
      const storeA = new JsonlAuditStore(filePath);
      await storeA.append(makeEntry({ id: "1" }));

      const storeB = new JsonlAuditStore(filePath);
      const result = await storeB.query({});
      expect(result.entries.map((e) => e.id)).toEqual(["1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a corrupted line instead of dying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
    const filePath = join(dir, "audit.jsonl");
    try {
      const store = new JsonlAuditStore(filePath);
      await store.append(makeEntry({ id: "1" }));
      const { appendFileSync } = await import("node:fs");
      appendFileSync(filePath, "{not valid json\n");
      await store.append(makeEntry({ id: "2" }));

      const result = await store.query({});
      expect(result.entries.map((e) => e.id).sort()).toEqual(["1", "2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
