// Audit entry shape, matches the brief: actor, action, target, decision, timestamp, redacted payload.

export interface AuditActor {
  id: string;
  type?: "human" | "agent"; // defaults to human if omitted
}

export interface AuditTarget {
  type: string; // "agent" | "grant" etc
  id: string;
}

export type AuditAction =
  | "invoke"
  | "view_config"
  | "delete"
  | "start"
  | "stop"
  | "grant"
  | "revoke"
  | (string & {});

export type AuditDecision = "allow" | "deny";

export interface AuditEntryInput {
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  decision: AuditDecision;
  payload?: Record<string, unknown> | null; // gets redacted before storage, don't rely on that though
  timestamp?: string; // defaults to now, mostly here for tests
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  decision: AuditDecision;
  payload: Record<string, unknown> | null;
}

export interface AuditQueryFilter {
  actorId?: string;
  actorType?: "human" | "agent";
  action?: AuditAction;
  targetId?: string;
  targetType?: string;
  decision?: AuditDecision;
  from?: string;
  to?: string;
  limit?: number; // default 50, capped at 200
  cursor?: string;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  nextCursor: string | null;
}

// storage seam, swap this for a real db later without touching the logger or routes
export interface AuditStore {
  append(entry: AuditEntry): Promise<AuditEntry>;
  query(filter: AuditQueryFilter): Promise<AuditQueryResult>;
}
