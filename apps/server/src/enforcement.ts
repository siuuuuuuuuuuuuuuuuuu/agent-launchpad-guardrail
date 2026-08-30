import type { AuditLogger } from "./audit-log/logger.js";
import { HttpError } from "./errors.js";
import type { Action, PolicyService } from "./policy.js";

// ---------------------------------------------------------------------------
// Enforcement Point.
//
// Every Agent-touching request maps to exactly one Action. The same
// `enforce()` primitive runs at two boundaries:
//   1. the Fastify request boundary (preHandler), before any handler logic;
//   2. the AgentRunner boundary, re-checked immediately before Codex is
//      invoked, so a bypass at layer 1 still cannot reach the Runtime.
// No decision is silent: allow and deny are both written to the audit log.
// ---------------------------------------------------------------------------

export type AgentIdSource = "params.id" | "run.id";

export interface EnforcementRule {
  method: string;
  /** Fastify route pattern, e.g. "/api/agents/:id/messages". */
  url: string;
  action: Action;
  agentIdFrom: AgentIdSource;
}

export const RULES: readonly EnforcementRule[] = [
  { method: "GET", url: "/api/agents/:id", action: "view_config", agentIdFrom: "params.id" },
  { method: "PATCH", url: "/api/agents/:id", action: "edit_config", agentIdFrom: "params.id" },
  { method: "DELETE", url: "/api/agents/:id", action: "delete", agentIdFrom: "params.id" },
  { method: "POST", url: "/api/agents/:id/start", action: "invoke", agentIdFrom: "params.id" },
  { method: "POST", url: "/api/agents/:id/stop", action: "invoke", agentIdFrom: "params.id" },
  { method: "POST", url: "/api/agents/:id/messages", action: "invoke", agentIdFrom: "params.id" },
  { method: "GET", url: "/api/agents/:id/messages", action: "view_runs", agentIdFrom: "params.id" },
  { method: "GET", url: "/api/agents/:id/runs", action: "view_runs", agentIdFrom: "params.id" },
  { method: "GET", url: "/api/runs/:id", action: "view_runs", agentIdFrom: "run.id" },
  { method: "GET", url: "/api/agents/:id/grants", action: "grant", agentIdFrom: "params.id" },
  { method: "POST", url: "/api/agents/:id/grants", action: "grant", agentIdFrom: "params.id" },
  {
    method: "DELETE",
    url: "/api/agents/:id/grants/:grantId",
    action: "revoke",
    agentIdFrom: "params.id",
  },
] as const;

export function matchRule(
  method: string,
  routeUrl: string | undefined,
): EnforcementRule | undefined {
  if (!routeUrl) return undefined;
  const upper = method.toUpperCase();
  return RULES.find((rule) => rule.method === upper && rule.url === routeUrl);
}

export interface EnforceArgs {
  actorUserId: string;
  agentId: string | null;
  action: Action;
  policy: PolicyService;
  audit: AuditLogger;
  /** Which checkpoint is speaking — recorded on the audit entry payload. */
  checkpoint: "request" | "runtime";
}

/**
 * Run one authorization decision: consult the Policy Plane, write the outcome
 * to the audit log (both allow and deny — the enforcement seam the audit
 * subsystem expects), and throw `HttpError` on deny. Returns nothing on allow.
 */
export async function enforce(args: EnforceArgs): Promise<void> {
  const { actorUserId, agentId, action, policy, audit, checkpoint } = args;

  const decision = agentId
    ? policy.hasScope(actorUserId, agentId, action)
    : { allow: false, reason: "agent not found" };

  await audit.record({
    actor: { id: actorUserId, type: "human" },
    action,
    target: { type: "agent", id: agentId ?? "unknown" },
    decision: decision.allow ? "allow" : "deny",
    payload: { checkpoint, reason: decision.reason, requestedScope: action },
  });

  if (!decision.allow) {
    if (decision.reason === "agent not found") {
      throw new HttpError(404, "Agent not found");
    }
    throw new HttpError(403, "Forbidden — " + decision.reason);
  }
}
