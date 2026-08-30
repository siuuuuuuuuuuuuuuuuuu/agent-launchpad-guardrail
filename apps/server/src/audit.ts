import { randomUUID } from "node:crypto";
import type { JsonStore } from "./store.js";
import type { AuditEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Observability / Audit Layer.
//
// Track ownership: this module is owned by the Audit role. The Enforcement
// layer depends ONLY on the `AuditLog` interface. `JsonAuditLog` is a thin
// working stub (flat table in the same JSON store); swap in the real
// write-on-decision store + query API behind the same interface.
// ---------------------------------------------------------------------------

export interface AuditInput {
  actorUserId: string;
  agentId: string | null;
  action: string;
  requestedScope: string | null;
  decision: "allow" | "deny";
  result: string;
}

export interface AuditQuery {
  actorUserId?: string | undefined;
  agentId?: string | undefined;
  action?: string | undefined;
  decision?: "allow" | "deny" | undefined;
  limit?: number | undefined;
}

export interface AuditLog {
  record(input: AuditInput): Promise<AuditEntry>;
  query(filter: AuditQuery): AuditEntry[];
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /AK(?:LT)?[A-Za-z0-9]{12,}/g,
  /\b[A-Za-z0-9._-]*(?:api[_-]?key|secret|token|password)[A-Za-z0-9._-]*\s*[=:]\s*\S+/gi,
];

/** Redact anything that looks like a credential before it reaches the log. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, "[redacted]"),
    text,
  );
}

export class JsonAuditLog implements AuditLog {
  constructor(private readonly store: JsonStore) {}

  async record(input: AuditInput): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actorUserId: input.actorUserId,
      agentId: input.agentId,
      action: input.action,
      requestedScope: input.requestedScope,
      decision: input.decision,
      result: redact(input.result).slice(0, 500),
    };
    await this.store.mutate((database) => {
      database.auditEntries.push(entry);
    });
    return entry;
  }

  query(filter: AuditQuery): AuditEntry[] {
    let entries = this.store.snapshot().auditEntries;
    if (filter.actorUserId) {
      entries = entries.filter((entry) => entry.actorUserId === filter.actorUserId);
    }
    if (filter.agentId) {
      entries = entries.filter((entry) => entry.agentId === filter.agentId);
    }
    if (filter.action) {
      entries = entries.filter((entry) => entry.action === filter.action);
    }
    if (filter.decision) {
      entries = entries.filter((entry) => entry.decision === filter.decision);
    }
    entries = entries.sort((left, right) =>
      right.timestamp.localeCompare(left.timestamp),
    );
    return filter.limit ? entries.slice(0, filter.limit) : entries;
  }
}
