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
import { baselineRules } from "./guardrail/engine.js";
import { registerIdentityRoutes } from "./identity/routes.js";
import { verifySessionToken } from "./identity/session.js";
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

const guardrailPolicyBody = z.object({
  sandboxMode: z.enum(["read-only", "workspace-write"]),
  networkAccess: z.boolean(),
  rules: z
    .array(
      z.object({
        kind: z.enum([
          "prompt_pattern",
          "command_pattern",
          "path_pattern",
          "output_pattern",
        ]),
        pattern: z.string().trim().min(1).max(512),
        effect: z.enum(["deny", "flag"]),
        message: z.string().trim().max(200),
      }),
    )
    .max(100),
});

// `/api/users` is the mock principal roster the local-mode switcher needs
// before a principal is chosen — no secrets, safe to expose past the identity
// gate. In oidc mode it would list real people's names/emails, so it moves
// behind the identity gate instead (see buildPublicPaths).
const ALWAYS_PUBLIC_PATHS = new Set(["/api/health", "/api/auth"]);
// The whole OIDC dance is necessarily pre-authentication.
const OIDC_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/exchange",
  "/api/auth/logout",
]);

function buildPublicPaths(config: AppConfig): Set<string> {
  const paths = new Set(ALWAYS_PUBLIC_PATHS);
  if (config.authMode === "local") {
    paths.add("/api/users");
  }
  // Always exempt from the identity gate, in every mode: in local mode the
  // handlers 404 themselves (requireOidc), a clean "this isn't available
  // here" rather than a confusing 401 "who are you" on a pre-auth endpoint.
  for (const path of OIDC_AUTH_PATHS) paths.add(path);
  return paths;
}

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
  const publicPaths = buildPublicPaths(config);

  // GET /api/audit — read API for the audit-log view. Inherits the same
  // bearer-token + principal gate as every other /api/* route via the
  // onRequest hooks below, even though it is registered above them
  // (app.test.ts locks that in — don't reorder without re-checking).
  // `scope` narrows what each principal may read: an operator (owner-capable)
  // sees the whole log; anyone else must name an Agent they own or can see,
  // and an untargeted query is limited to their own actions.
  await app.register(
    createAuditRoutes(auditStore, {
      scope: async (request, filter) => {
        const actor = (request as typeof request & { actor?: User }).actor;
        if (!actor) throw new HttpError(401, "Authentication required");
        if (filter.targetId) {
          const owns = service
            .listAgents()
            .some((agent) => agent.id === filter.targetId && agent.ownerId === actor.id);
          if (!owns && !policy.canSee(actor.id, filter.targetId)) {
            throw new HttpError(403, "Forbidden — you cannot view this Agent's audit log");
          }
          return filter;
        }
        if (actor.role === "owner-capable") return filter;
        return { ...filter, actorId: actor.id };
      },
    }),
  );

  // Coarse gate: shared operator token. Only meaningful in local mode — in
  // oidc mode the Authorization header carries the real session token, which
  // the identity hook below verifies properly, so this check is skipped
  // rather than doubled up on the same header.
  app.addHook("onRequest", async (request, reply) => {
    if (
      config.authMode !== "local" ||
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

  // Principal resolution.
  //   local: mock identity via the X-User-Id header against the seeded table.
  //   oidc:  verify the app's own session token (Authorization: Bearer),
  //          minted at /api/auth/callback after a real OIDC login.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || publicPaths.has(path)) {
      return;
    }
    if (config.authMode === "oidc") {
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const claims = token
        ? await verifySessionToken(config.oidc!.sessionSecret, token)
        : null;
      const user = claims ? policy.getUser(claims.sub) : undefined;
      if (!user) {
        return reply.code(401).send({ error: "Sign in required" });
      }
      request.actor = user;
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

  app.get("/api/auth", async () => ({
    required: config.authMode === "oidc" || config.authToken.length > 0,
    mode: config.authMode,
  }));

  registerIdentityRoutes(app, config, policy);

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

  // Runtime guardrail policy. The always-on platform baseline is returned
  // alongside so the UI can show what applies even with an empty policy.
  app.get("/api/agents/:id/guardrail", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return {
      policy: service.getGuardrailPolicy(id),
      baseline: baselineRules(),
      mode: service.guardrail.mode,
      sandboxCeiling: service.guardrail.sandboxCeiling,
    };
  });

  app.put("/api/agents/:id/guardrail", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = guardrailPolicyBody.parse(request.body);
    const actor = request.actor!;
    const before = service.getGuardrailPolicy(id);
    const policy = await service.setGuardrailPolicy(id, body);
    await auditLogger.record({
      actor: { id: actor.id, type: "human" },
      action: "policy.guardrail_update",
      target: { type: "agent", id },
      decision: "allow",
      payload: {
        checkpoint: "request",
        sandboxMode: policy.sandboxMode,
        networkAccess: policy.networkAccess,
        ruleCount: policy.rules.length,
        previousRuleCount: before.rules.length,
        previousSandboxMode: before.sandboxMode,
      },
    });
    return { policy };
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
