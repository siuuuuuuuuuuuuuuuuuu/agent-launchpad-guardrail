// Strips anything secret-shaped out of a payload before it's written.
// Runs unconditionally inside AuditLogger.record(), no way to skip it.

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?header|bearer|credential|cookie|ark[_-]?key|private[_-]?key)/i;

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 6;

export function redactPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (payload == null) return null;
  const seen = new WeakSet<object>();
  return (redactValue(payload, 0, seen) ?? {}) as Record<string, unknown>;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH_EXCEEDED]";

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`
      : value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactValue(item, depth + 1, seen));
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value as object)) return "[CIRCULAR]";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(val, depth + 1, seen);
    }
    return out;
  }

  return value;
}
