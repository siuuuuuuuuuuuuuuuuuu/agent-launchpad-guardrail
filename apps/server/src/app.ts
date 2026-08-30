import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentService } from "./agent-service.js";
import { AuditLogger } from "./audit-log/logger.js";
import { createAuditRoutes } from "./audit-log/routes.js";
import type { AuditStore } from "./audit-log/types.js";
import type { AppConfig } from "./config.js";
import { enforce, matchRule } from "./enforcement.js";
import { HttpError } from "./errors.js";
import type { PolicyService } from "./policy.js";
import type { User } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: User;
  }
  // lets any route handler reach `request.server.auditLogger.record(...)`
  // without having to thread it through every function signature
  interface FastifyInstance {
    auditLogger: AuditLogger;
  }
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const grantParams = z.object({
  id: z.string().uuid(),
  grantId: z.string().uuid(),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const createGrantBody = z.object({
  grantedTo: z.string().trim().min(1),
  scopes: z
    .array(z.enum(["invoke", "view_config", "edit_config", "view_runs"]))
    .min(1),
  expiresAt: z.string().datetime().optional(),
});

// `/api/users` is the mock principal roster the switcher needs before a
// principal is chosen — no secrets, safe to expose past the identity gate.
const PUBLIC_PATHS = new Set(["/api/health", "/api/auth", "/api/users"]);

export async function createApp(
  config: AppConfig,
  service: AgentService,
  auditStore: AuditStore,
  policy: PolicyService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    allowedHeaders: ["authorization", "content-type", "x-user-id"],
  });

  const auditLogger = new AuditLogger(auditStore);
  app.decorate("auditLogger", auditLogger);

  // GET /api/audit — read API for the audit-log view. Inherits the same
  // bearer-token + principal gate as every other /api/* route via the
  // onRequest hooks below, even though it is registered above them
  // (app.test.ts locks that in — don't reorder without re-checking).
  await app.register(createAuditRoutes(auditStore));

  // Coarse gate: shared operator token (unchanged from the Starter Kit).
  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  // Principal resolution: mock identity via the X-User-Id header, checked
  // against the mock user table. No production auth — intentional per scope.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || PUBLIC_PATHS.has(path)) {
      return;
    }
    const headerValue = request.headers["x-user-id"];
    const userId = (Array.isArray(headerValue) ? headerValue[0] : headerValue)?.trim();
    const user = userId ? policy.getUser(userId) : undefined;
    if (!user) {
      return reply
        .code(401)
        .send({ error: "Unknown or missing X-User-Id principal" });
    }
    request.actor = user;
  });

  // Enforcement Point — checkpoint 1: every Agent-touching route resolves to
  // one Action and passes hasScope() before its handler runs.
  app.addHook("preHandler", async (request) => {
    const rule = matchRule(request.method, request.routeOptions.url);
    if (!rule) return;
    const actor = request.actor;
    if (!actor) throw new HttpError(401, "Authentication required");

    const params = (request.params ?? {}) as Record<string, string>;
    const agentId =
      rule.agentIdFrom === "run.id"
        ? service.findRunAgentId(params.id ?? "")
        : (params.id ?? null);

    await enforce({
      actorUserId: actor.id,
      agentId,
      action: rule.action,
      policy,
      audit: auditLogger,
      checkpoint: "request",
      handlerAudits: rule.handlerAudits ?? false,
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/users", async () => ({ users: policy.listUsers() }));

  app.get("/api/me", async (request) => ({ user: request.actor }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => {
    const actor = request.actor!;
    const agents = service
      .listAgents()
      .filter((agent) => agent.ownerId === actor.id || policy.canSee(actor.id, agent.id));
    return { agents };
  });

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const actor = request.actor!;
    const agent = await service.createAgent(body, actor.id);
    await auditLogger.record({
      actor: { id: actor.id, type: "human" },
      action: "create",
      target: { type: "agent", id: agent.id },
      decision: "allow",
      payload: { owner: actor.id, checkpoint: "request" },
    });
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, request.actor!.id);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  // Grant management (owner-only, enforced by the "grant"/"revoke" Actions).
  app.get("/api/agents/:id/grants", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { grants: policy.listGrants(id) };
  });

  app.post("/api/agents/:id/grants", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = createGrantBody.parse(request.body);
    const actor = request.actor!;
    const grant = await policy.createGrant({
      agentId: id,
      grantedTo: body.grantedTo,
      grantedBy: actor.id,
      scopes: body.scopes,
      expiresAt: body.expiresAt ?? null,
    });
    await auditLogger.record({
      actor: { id: actor.id, type: "human" },
      action: "grant",
      target: { type: "agent", id },
      decision: "allow",
      payload: {
        grantId: grant.id,
        grantedTo: body.grantedTo,
        scopes: body.scopes,
        checkpoint: "request",
      },
    });
    return reply.code(201).send({ grant });
  });

  app.delete("/api/agents/:id/grants/:grantId", async (request) => {
    const { id, grantId } = grantParams.parse(request.params);
    const actor = request.actor!;
    const grant = await policy.revokeGrant(id, grantId);
    await auditLogger.record({
      actor: { id: actor.id, type: "human" },
      action: "revoke",
      target: { type: "agent", id },
      decision: "allow",
      payload: {
        grantId,
        grantedTo: grant.grantedTo,
        scopes: grant.scopes,
        checkpoint: "request",
      },
    });
    return { grant };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
