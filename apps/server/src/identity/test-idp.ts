import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// A minimal, real OIDC provider for tests: standard discovery, a real JWKS
// endpoint, and a token endpoint that signs a real RS256 id_token. Exercises
// the actual network calls the server makes (discovery, JWKS fetch, token
// exchange, signature verification) instead of stubbing them out — this is
// the same shape a real WorkOS/Okta/Auth0/Keycloak issuer presents.

export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The claims the next `/token` call's id_token will carry. */
  setNextClaims(claims: { sub: string; email?: string; name?: string }): void;
  close(): Promise<void>;
}

export async function startFakeIdp(
  clientId = "test-client",
  clientSecret = "test-secret",
): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  let issuer = "";
  let nextClaims: { sub: string; email?: string; name?: string } = { sub: "unset" };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/.well-known/openid-configuration") {
        respondJson(res, {
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
        });
        return;
      }
      if (url.pathname === "/jwks") {
        respondJson(res, { keys: [publicJwk] });
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const idToken = await new SignJWT({
          email: nextClaims.email,
          name: nextClaims.name,
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject(nextClaims.sub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        respondJson(res, { id_token: idToken, access_token: "fake-access-token" });
        return;
      }
      res.statusCode = 404;
      res.end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  issuer = "http://127.0.0.1:" + port;

  return {
    issuer,
    clientId,
    clientSecret,
    setNextClaims: (claims) => {
      nextClaims = claims;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function respondJson(res: import("node:http").ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
