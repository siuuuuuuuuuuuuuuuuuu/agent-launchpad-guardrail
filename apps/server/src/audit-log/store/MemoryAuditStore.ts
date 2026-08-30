import type { AuditEntry, AuditQueryFilter, AuditQueryResult, AuditStore } from "../types.js";
import { filterEntries } from "./filter.js";

// in-memory, mainly for tests. nothing persists across a restart.
export class MemoryAuditStore implements AuditStore {
  private entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<AuditEntry> {
    this.entries.push(entry);
    return entry;
  }

  async query(filter: AuditQueryFilter): Promise<AuditQueryResult> {
    return filterEntries(this.entries, filter);
  }
}
