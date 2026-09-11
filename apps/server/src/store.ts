import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultGuardrailPolicy } from "./guardrail/policy-defaults.js";
import { DEFAULT_OWNER_ID, SEED_USERS } from "./seed.js";
import type { Agent, AgentRun, Database, GuardrailPolicy, User } from "./types.js";

const CURRENT_VERSION = 3 as const;

const emptyDatabase = (): Database => ({
  version: CURRENT_VERSION,
  users: structuredClone(SEED_USERS) as User[],
  agents: [],
  messages: [],
  runs: [],
  grants: [],
});

// Forward-migrate any earlier on-disk shape:
//   v1 -> v2  identity/policy tables (owner backfill)
//   v2 -> v3  per-Agent guardrailPolicy (baseline default backfill)
function migrate(raw: Record<string, unknown>): Database {
  const users =
    Array.isArray(raw.users) && raw.users.length > 0
      ? (raw.users as User[])
      : (structuredClone(SEED_USERS) as User[]);
  const fallbackOwner =
    users.find((user) => user.role === "owner-capable")?.id ??
    users[0]?.id ??
    DEFAULT_OWNER_ID;
  const agents = ((raw.agents as Agent[]) ?? []).map((agent) => ({
    ...agent,
    ownerId: agent.ownerId ?? fallbackOwner,
    guardrailPolicy: normalizeStoredPolicy(agent.guardrailPolicy),
  }));
  const runs = ((raw.runs as AgentRun[]) ?? []).map((run) => ({
    ...run,
    actorUserId: run.actorUserId ?? fallbackOwner,
  }));
  return {
    version: CURRENT_VERSION,
    users,
    agents,
    messages: (raw.messages as Database["messages"]) ?? [],
    runs,
    grants: (raw.grants as Database["grants"]) ?? [],
  };
}

/** Backfill or repair a stored guardrail policy so every Agent has a valid one. */
function normalizeStoredPolicy(stored: unknown): GuardrailPolicy {
  const fallback = defaultGuardrailPolicy();
  if (!stored || typeof stored !== "object") return fallback;
  const value = stored as Partial<GuardrailPolicy>;
  return {
    sandboxMode: value.sandboxMode === "read-only" ? "read-only" : "workspace-write",
    networkAccess: value.networkAccess === true,
    rules: Array.isArray(value.rules) ? value.rules : [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = migrate(parsed);
      if (parsed.version !== CURRENT_VERSION) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
