import { randomUUID } from "node:crypto";
import { redactPayload } from "./redact.js";
import type { AuditEntry, AuditEntryInput, AuditStore } from "./types.js";

export interface AuditLoggerOptions {
  // if true, a failed write rethrows and fails the caller's request.
  // default is false: log it loudly and move on, so a storage hiccup here
  // can't take down an otherwise-correct allow/deny decision.
  strict?: boolean;
}

// enforcement calls record() after every allow/deny, identity calls it
// after grant/revoke. see README for the exact call shape.
export class AuditLogger {
  constructor(
    private readonly store: AuditStore,
    private readonly options: AuditLoggerOptions = {},
  ) {}

  async record(input: AuditEntryInput): Promise<AuditEntry> {
    assertValid(input);

    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      actor: { type: "human", ...input.actor },
      action: input.action,
      target: input.target,
      decision: input.decision,
      payload: redactPayload(input.payload ?? null),
    };

    try {
      await this.store.append(entry);
    } catch (err) {
      console.error("[audit-log] failed to persist entry:", JSON.stringify(entry), err);
      if (this.options.strict) throw err;
    }

    return entry;
  }
}

// catches a malformed call early instead of writing a broken entry
function assertValid(input: AuditEntryInput): void {
  const problems: string[] = [];
  if (!input.actor?.id) problems.push("actor.id is required");
  if (!input.action) problems.push("action is required");
  if (!input.target?.type) problems.push("target.type is required");
  if (!input.target?.id) problems.push("target.id is required");
  if (input.decision !== "allow" && input.decision !== "deny") {
    problems.push('decision must be "allow" or "deny"');
  }
  if (problems.length > 0) {
    throw new Error(`AuditLogger.record: invalid input — ${problems.join("; ")}`);
  }
}
