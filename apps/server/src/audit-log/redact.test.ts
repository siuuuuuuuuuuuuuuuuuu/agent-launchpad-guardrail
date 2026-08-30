import { describe, expect, it } from "vitest";
import { redactPayload } from "./redact.js";

describe("redactPayload", () => {
  it("null/undefined in, null out", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeNull();
  });

  it("redacts top-level sensitive keys", () => {
    const out = redactPayload({ apiKey: "sk-abc123", note: "fine" });
    expect(out).toEqual({ apiKey: "[REDACTED]", note: "fine" });
  });

  it("redacts nested keys too", () => {
    const out = redactPayload({
      request: { headers: { Authorization: "Bearer xyz" }, url: "/agents/1" },
    });
    expect(out).toEqual({
      request: { headers: { Authorization: "[REDACTED]" }, url: "/agents/1" },
    });
  });

  it("matches key patterns regardless of casing/separators", () => {
    for (const key of ["token", "TOKEN", "api_key", "api-key", "ArkKey", "password", "secret"]) {
      const out = redactPayload({ [key]: "sensitive-value" });
      expect(out![key]).toBe("[REDACTED]");
    }
  });

  it("doesn't false-positive on innocuous keys", () => {
    const out = redactPayload({ action: "invoke", targetId: "agent-1" });
    expect(out).toEqual({ action: "invoke", targetId: "agent-1" });
  });

  it("redacts inside arrays of objects", () => {
    const out = redactPayload({ items: [{ secret: "a" }, { fine: "b" }] });
    expect(out).toEqual({ items: [{ secret: "[REDACTED]" }, { fine: "b" }] });
  });

  it("truncates long strings", () => {
    const longString = "x".repeat(1000);
    const out = redactPayload({ note: longString });
    expect((out!.note as string).length).toBeLessThan(1000);
    expect(out!.note).toContain("[TRUNCATED]");
  });

  it("caps array length", () => {
    const out = redactPayload({ items: Array.from({ length: 200 }, (_, i) => i) });
    expect((out!.items as unknown[]).length).toBeLessThanOrEqual(50);
  });

  it("doesn't blow up on circular refs", () => {
    const obj: Record<string, unknown> = { name: "agent" };
    obj.self = obj;
    expect(() => redactPayload(obj)).not.toThrow();
    expect(redactPayload(obj)!.self).toBe("[CIRCULAR]");
  });

  it("leaves numbers/booleans/null alone", () => {
    const out = redactPayload({ count: 3, ok: true, missing: null });
    expect(out).toEqual({ count: 3, ok: true, missing: null });
  });
});
