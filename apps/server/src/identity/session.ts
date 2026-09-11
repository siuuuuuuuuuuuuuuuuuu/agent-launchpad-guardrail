import { jwtVerify, SignJWT } from "jose";
import type { SessionClaims } from "./types.js";

// The app's own session token, minted after a verified OIDC login and handed
// to the browser as a bearer credential (the SPA sends it exactly like the
// existing shared APP_AUTH_TOKEN — no cookie, so no CSRF surface to add).
// HS256 keeps this dependency-free; SESSION_SECRET is required, validated,
// and never logged (config.ts, audit-log/redact.ts key-pattern already covers
// any field literally named *secret*).

const ISSUER = "volc-agent-launchpad";

export async function mintSessionToken(
  secret: string,
  ttlMs: number,
  userId: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + ttlMs) / 1000))
    .sign(key);
}

export async function verifySessionToken(
  secret: string,
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}
