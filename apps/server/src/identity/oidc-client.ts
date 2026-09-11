import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "../errors.js";
import type { OidcConfig } from "../config.js";
import type { OidcClaims, OidcMetadata } from "./types.js";

export function buildAuthorizationUrl(
  metadata: OidcMetadata,
  config: OidcConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Authorization Code + PKCE token exchange. Returns the raw `id_token`. */
export async function exchangeCodeForIdToken(
  metadata: OidcMetadata,
  config: OidcConfig,
  code: string,
  codeVerifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });
  let response: Response;
  try {
    response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new HttpError(502, "Could not reach the identity provider's token endpoint: " + String(error));
  }
  if (!response.ok) {
    throw new HttpError(401, "Identity provider rejected the authorization code");
  }
  const payload = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!payload || typeof payload.id_token !== "string") {
    throw new HttpError(502, "Identity provider token response carried no id_token");
  }
  return payload.id_token;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), { cooldownDuration: 30_000 });
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/** Verifies signature, issuer, audience, and expiry; extracts the claims we rely on. */
export async function verifyIdToken(
  metadata: OidcMetadata,
  config: OidcConfig,
  idToken: string,
): Promise<OidcClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwksFor(metadata.jwks_uri), {
      issuer: metadata.issuer,
      audience: config.clientId,
    }));
  } catch (error) {
    throw new HttpError(401, "Identity provider issued an invalid id_token: " + String(error));
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new HttpError(401, "id_token is missing a subject claim");
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

/** Test-only: drop a cached JWKS fetcher so a fresh fake IdP starts clean. */
export function resetJwksCache(): void {
  jwksCache.clear();
}
