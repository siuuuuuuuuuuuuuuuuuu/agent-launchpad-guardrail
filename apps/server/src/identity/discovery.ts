import { HttpError } from "../errors.js";
import type { OidcMetadata } from "./types.js";

// Cache discovery documents per issuer for the life of the process. A wrong or
// unreachable issuer fails fast rather than retrying on every login attempt.
const cache = new Map<string, Promise<OidcMetadata>>();

export function discoverOidcMetadata(issuer: string): Promise<OidcMetadata> {
  const cached = cache.get(issuer);
  if (cached) return cached;
  const discovery = fetchMetadata(issuer).catch((error: unknown) => {
    cache.delete(issuer); // don't pin a transient failure forever
    throw error;
  });
  cache.set(issuer, discovery);
  return discovery;
}

async function fetchMetadata(issuer: string): Promise<OidcMetadata> {
  const url = issuer + "/.well-known/openid-configuration";
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new HttpError(
      503,
      "Could not reach the identity provider's discovery document: " + String(error),
    );
  }
  if (!response.ok) {
    throw new HttpError(503, "Identity provider discovery failed: HTTP " + response.status);
  }
  const body = (await response.json()) as Partial<OidcMetadata>;
  if (
    !body.authorization_endpoint ||
    !body.token_endpoint ||
    !body.jwks_uri ||
    !body.issuer
  ) {
    throw new HttpError(503, "Identity provider discovery document is missing required fields");
  }
  if (body.issuer.replace(/\/+$/, "") !== issuer) {
    // RFC 8414 §3.3 — the document must self-assert the issuer we asked for.
    throw new HttpError(503, "Identity provider discovery document issuer mismatch");
  }
  return {
    issuer: body.issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
  };
}

/** Test-only: clears the discovery cache between fake-IdP instances. */
export function resetDiscoveryCache(): void {
  cache.clear();
}
