import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig, OidcConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { PolicyService } from "../policy.js";
import { discoverOidcMetadata } from "./discovery.js";
import { handoffCodes, pendingLogins } from "./flow-store.js";
import { buildAuthorizationUrl, exchangeCodeForIdToken, verifyIdToken } from "./oidc-client.js";
import { createPkcePair } from "./pkce.js";
import { mintSessionToken } from "./session.js";

const callbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
const exchangeBody = z.object({ code: z.string().min(1) });

/**
 * The pre-authentication OIDC dance: `/login` redirects to the identity
 * provider, `/callback` receives it back and mints our own session token,
 * `/exchange` hands that token to the browser (a one-time code, never the
 * token itself, rides in the redirect URL — nothing sensitive touches
 * browser history), `/logout` is client-side-only (see docs/IDENTITY.md).
 * All four are no-ops (404) unless AUTH_MODE=oidc.
 */
export function registerIdentityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  policy: PolicyService,
): void {
  app.get("/api/auth/login", async (_request, reply) => {
    const oidc = requireOidc(config);
    const metadata = await discoverOidcMetadata(oidc.issuer);
    const state = randomUUID();
    const { codeVerifier, codeChallenge } = createPkcePair();
    pendingLogins.set(state, { codeVerifier });
    const authorizationUrl = buildAuthorizationUrl(metadata, oidc, state, codeChallenge);
    return reply.redirect(authorizationUrl);
  });

  app.get("/api/auth/callback", async (request, reply) => {
    const oidc = requireOidc(config);
    const { code, state } = callbackQuery.parse(request.query);
    const pending = pendingLogins.takeOnce(state);
    if (!pending) {
      throw new HttpError(400, "Login expired or was already completed — try signing in again");
    }
    const metadata = await discoverOidcMetadata(oidc.issuer);
    const idToken = await exchangeCodeForIdToken(metadata, oidc, code, pending.codeVerifier);
    const claims = await verifyIdToken(metadata, oidc, idToken);
    const user = await policy.provisionOidcUser(claims, oidc.adminEmails);
    const sessionToken = await mintSessionToken(oidc.sessionSecret, oidc.sessionTtlMs, user.id);
    const handoff = randomUUID();
    handoffCodes.set(handoff, { token: sessionToken });
    const destination = (config.webOrigin || "") + "/?auth=" + handoff;
    return reply.redirect(destination);
  });

  app.post("/api/auth/exchange", async (request) => {
    requireOidc(config);
    const { code } = exchangeBody.parse(request.body);
    const taken = handoffCodes.takeOnce(code);
    if (!taken) {
      throw new HttpError(400, "This login link was already used or has expired");
    }
    return { token: taken.token };
  });

  app.post("/api/auth/logout", async () => {
    requireOidc(config);
    // Stateless bearer token: there is nothing server-side to revoke here.
    // The client drops the token; it remains valid, at most, for
    // SESSION_TTL_MS — see docs/IDENTITY.md "Known limitations".
    return { ok: true };
  });
}

function requireOidc(config: AppConfig): OidcConfig {
  if (!config.oidc) throw new HttpError(404, "Not found");
  return config.oidc;
}
