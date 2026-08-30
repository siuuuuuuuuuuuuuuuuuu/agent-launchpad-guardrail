import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry, AuditQueryFilter, AuditQueryResult, AuditStore } from "../types.js";
import { filterEntries } from "./filter.js";

// append-only jsonl file. no db to set up, survives a restart, easy to cat
// while debugging. query reads the whole file each time - fine at demo
// scale, first thing to swap out if this ever needs to handle real volume.
export class JsonlAuditStore implements AuditStore {
  constructor(private readonly filePath: string) {
    const dir = dirname(filePath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async append(entry: AuditEntry): Promise<AuditEntry> {
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  async query(filter: AuditQueryFilter): Promise<AuditQueryResult> {
    return filterEntries(this.readAll(), filter);
  }

  private readAll(): AuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, "utf8").split("\n").filter((l) => l.trim());
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // corrupted line (e.g. a torn write) - skip it instead of failing the whole query
      }
    }
    return entries;
  }
}
