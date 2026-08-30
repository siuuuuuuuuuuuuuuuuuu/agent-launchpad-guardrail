import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AuditDecision, AuditQueryFilter, AuditStore } from "./types.js";

interface AuditQueryString {
  actor?: string;
  actorType?: string;
  action?: string;
  target?: string;
  targetType?: string;
  decision?: string;
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
}

const VALID_DECISIONS: ReadonlySet<string> = new Set(["allow", "deny"]);
const MAX_LIMIT = 200;

export interface AuditRoutesOptions {
  // gate on who can read the log. left unset it's open to anyone - fine
  // for local dev, should get wired up to identity/policy before the demo.
  authorize?: (request: FastifyRequest) => boolean | Promise<boolean>;
  // narrow the query to what this caller may see. return the filter to use
  // (server wins over user input) or throw an error with a `statusCode` to
  // reject. left unset, the parsed query is used as-is.
  scope?: (
    request: FastifyRequest,
    filter: AuditQueryFilter,
  ) => AuditQueryFilter | Promise<AuditQueryFilter>;
}

// GET /api/audit - filterable read api behind the frontend's log view
export function createAuditRoutes(store: AuditStore, options: AuditRoutesOptions = {}): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: AuditQueryString }>("/api/audit", async (request, reply) => {
      if (options.authorize) {
        const allowed = await options.authorize(request);
        if (!allowed) {
          return reply.status(403).send({ error: "not authorized to view the audit log" });
        }
      }

      const q = request.query;

      if (q.decision && !VALID_DECISIONS.has(q.decision)) {
        return reply.status(400).send({ error: "decision must be one of: allow, deny" });
      }
      if (q.actorType && q.actorType !== "human" && q.actorType !== "agent") {
        return reply.status(400).send({ error: "actorType must be one of: human, agent" });
      }

      let limit: number | undefined;
      if (q.limit !== undefined) {
        limit = Number(q.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
          return reply.status(400).send({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
        }
      }

      for (const [name, value] of [
        ["from", q.from],
        ["to", q.to],
      ] as const) {
        if (value !== undefined && Number.isNaN(Date.parse(value))) {
          return reply.status(400).send({ error: `${name} must be a valid ISO 8601 timestamp` });
        }
      }

      // built with conditional spreads, not plain assignment - this repo's
      // tsconfig has exactOptionalPropertyTypes on, so an optional field
      // can't be assigned an explicit `undefined`, it has to be left out
      const filter: AuditQueryFilter = {
        ...(q.actor !== undefined && { actorId: q.actor }),
        ...(q.actorType !== undefined && { actorType: q.actorType as "human" | "agent" }),
        ...(q.action !== undefined && { action: q.action }),
        ...(q.target !== undefined && { targetId: q.target }),
        ...(q.targetType !== undefined && { targetType: q.targetType }),
        ...(q.decision !== undefined && { decision: q.decision as AuditDecision }),
        ...(q.from !== undefined && { from: q.from }),
        ...(q.to !== undefined && { to: q.to }),
        ...(limit !== undefined && { limit }),
        ...(q.cursor !== undefined && { cursor: q.cursor }),
      };

      let scoped = filter;
      if (options.scope) {
        try {
          scoped = await options.scope(request, filter);
        } catch (error) {
          const status =
            typeof (error as { statusCode?: unknown }).statusCode === "number"
              ? (error as { statusCode: number }).statusCode
              : 403;
          const message = error instanceof Error ? error.message : "not authorized";
          return reply.status(status).send({ error: message });
        }
      }

      const result = await store.query(scoped);
      return reply.send(result);
    });
  };
}
