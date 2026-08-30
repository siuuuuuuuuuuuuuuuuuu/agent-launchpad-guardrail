import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type { Grant, Scope, User } from "./types.js";

// ---------------------------------------------------------------------------
// Identity & Policy Plane.
//
// Track ownership: this module is owned by the Identity/Policy role. The
// Enforcement layer depends ONLY on the exported surface below
// (`PolicyService.hasScope`, `getUser`, `canSee`). Internals — the grant
// lookup, the seed table, grant CRUD — can be reworked freely as long as that
// surface holds. No general-purpose policy engine: a single
// `hasScope(user, agentId, action)` check is the whole contract.
// ---------------------------------------------------------------------------

export const SCOPES: readonly Scope[] = [
  "invoke",
  "view_config",
  "edit_config",
  "view_runs",
] as const;

/** Every Agent-touching operation the Enforcement Point recognises. */
export type Action = Scope | "delete" | "grant" | "revoke" | "create" | "list";

/** Actions only the Agent owner may perform — no grant can confer them. */
const OWNER_ONLY: ReadonlySet<Action> = new Set<Action>([
  "delete",
  "grant",
  "revoke",
]);

export interface PolicyDecision {
  allow: boolean;
  reason: string;
}

function grantIsLive(grant: Grant, at: number): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= at) return false;
  return true;
}

export interface CreateGrantInput {
  agentId: string;
  grantedTo: string;
  grantedBy: string;
  scopes: Scope[];
  expiresAt?: string | null;
}

export class PolicyService {
  constructor(private readonly store: JsonStore) {}

  getUser(userId: string): User | undefined {
    return this.store.snapshot().users.find((user) => user.id === userId);
  }

  listUsers(): User[] {
    return this.store.snapshot().users;
  }

  /**
   * The single enforcement primitive. Pure read over the current store
   * snapshot, so a revoked grant is refused on the caller's very next request.
   */
  hasScope(actorUserId: string, agentId: string, action: Action): PolicyDecision {
    const database = this.store.snapshot();

    const user = database.users.find((item) => item.id === actorUserId);
    if (!user) return { allow: false, reason: "unknown principal" };

    const agent = database.agents.find((item) => item.id === agentId);
    if (!agent) return { allow: false, reason: "agent not found" };

    if (agent.ownerId === actorUserId) {
      return { allow: true, reason: "owner" };
    }
    if (OWNER_ONLY.has(action)) {
      return { allow: false, reason: "owner-only action: " + action };
    }

    const scope = action as Scope;
    const grant = database.grants.find(
      (item) =>
        item.agentId === agentId &&
        item.grantedTo === actorUserId &&
        item.scopes.includes(scope) &&
        grantIsLive(item, Date.now()),
    );
    if (grant) return { allow: true, reason: "grant " + grant.id };
    return { allow: false, reason: "no live grant for scope '" + scope + "'" };
  }

  /** Whether the Agent should appear in this user's listing at all. */
  canSee(actorUserId: string, agentId: string): boolean {
    return (
      this.hasScope(actorUserId, agentId, "view_config").allow ||
      this.hasScope(actorUserId, agentId, "invoke").allow ||
      this.hasScope(actorUserId, agentId, "view_runs").allow
    );
  }

  listGrants(agentId: string): Grant[] {
    return this.store
      .snapshot()
      .grants.filter((grant) => grant.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createGrant(input: CreateGrantInput): Promise<Grant> {
    // Validated here, not only in the route's zod schema, so a direct caller
    // (the runtime checkpoint, a future internal service) can't persist a
    // malformed grant. The HTTP path rejects most of this earlier with a 400.
    const normalizedScopes = [...new Set(input.scopes)] as Scope[];
    for (const scope of normalizedScopes) {
      if (!SCOPES.includes(scope)) {
        throw new HttpError(400, "Invalid scope: " + scope);
      }
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const parsed = Date.parse(input.expiresAt);
      if (Number.isNaN(parsed)) {
        throw new HttpError(400, "expiresAt must be a valid ISO timestamp");
      }
    }

    const timestamp = new Date().toISOString();
    const grant: Grant = {
      id: randomUUID(),
      agentId: input.agentId,
      grantedTo: input.grantedTo,
      grantedBy: input.grantedBy,
      scopes: normalizedScopes,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === input.agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (!database.users.some((item) => item.id === input.grantedBy)) {
        throw new HttpError(400, "grantedBy is not a known user");
      }
      if (!database.users.some((item) => item.id === input.grantedTo)) {
        throw new HttpError(400, "grantedTo is not a known user");
      }
      if (input.grantedBy !== agent.ownerId) {
        throw new HttpError(403, "Only the Agent owner can grant access");
      }
      if (input.grantedTo === agent.ownerId) {
        throw new HttpError(400, "Owner already has full access");
      }
      database.grants.push(grant);
    });
    return grant;
  }

  async revokeGrant(agentId: string, grantId: string): Promise<Grant> {
    return this.store.mutate((database) => {
      const grant = database.grants.find(
        (item) => item.id === grantId && item.agentId === agentId,
      );
      if (!grant) throw new HttpError(404, "Grant not found");
      if (!grant.revokedAt) grant.revokedAt = new Date().toISOString();
      return structuredClone(grant);
    });
  }
}
