/** Discovered from `${issuer}/.well-known/openid-configuration`. */
export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** The claims this app relies on out of a verified `id_token`. */
export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
}

/** What a verified session token asserts about the caller. */
export interface SessionClaims {
  sub: string;
}
