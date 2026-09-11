import { createHash, randomBytes } from "node:crypto";

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 — S256 code verifier + challenge for the authorization code flow. */
export function createPkcePair(): PkcePair {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function randomState(): string {
  return base64url(randomBytes(24));
}
