# Identity — contract & wiring

Phase 1 of [ADR 0001](adr/0001-enterprise-saas-target-architecture.md): real,
verified identity as the trust root everything else (authorization, runtime
guardrails, audit) already assumes. Provider-agnostic — standard OIDC
discovery + Authorization Code + PKCE, so any compliant identity provider
works (WorkOS is the reference target for a B2B SaaS; Okta, Entra, Auth0, and
Keycloak also work unmodified).

`AUTH_MODE=local` (default) is the original mock `X-User-Id` + seeded-user
path, completely unchanged — every existing test, script, and doc that
predates this still applies as written. `AUTH_MODE=oidc` replaces it. The two
modes are mutually exclusive per deployment; nothing in between.

## Why this, not the mock

The mock accepts any `X-User-Id` header as fact — "authorization" and "audit"
were only ever as trustworthy as whoever could set an HTTP header. Everything
downstream (`PolicyService.hasScope`, the audit log's `actor.id`, the
guardrail engine's `checkpoint` records) inherits its integrity from identity.
This closes that gap without touching any of those downstream consumers —
`PolicyService.getUser(id)` is still the only lookup they use.

## Flow

```
Browser                          Server (AUTH_MODE=oidc)              Identity Provider
   │  GET /api/auth/login  ────────▶ store {state, PKCE verifier}
   │                                 302 -> authorize?state&code_challenge
   │  ─────────────────────────────────────────────────────────────────▶  login + consent
   │  ◀───────────────────────────────────────────────────────  302 -> /api/auth/callback?code&state
   │  GET /api/auth/callback ─────▶ take {state}, verify PKCE
   │                                 POST /token (code, verifier)  ─────▶
   │                                 ◀───────────────────────────────────  id_token (signed)
   │                                 verify id_token (issuer, audience,
   │                                   signature via JWKS)
   │                                 PolicyService.provisionOidcUser(claims)
   │                                 mint our own session token (HS256, short TTL)
   │                                 store {handoff code -> session token}
   │                                 302 -> WEB_ORIGIN/?auth=<handoff code>
   │  ◀── 302 ──────────────────────
   │  POST /api/auth/exchange {code} ▶ take {handoff code}, return {token}
   │  every request: Authorization: Bearer <token>  ▶ verify (our own HS256), look up User
```

No cookie, ever — the browser holds the session token exactly like the
existing shared `APP_AUTH_TOKEN` bearer credential (`api.ts`'s `setAuthToken`,
unchanged). That sidesteps CSRF entirely: a cookie is sent automatically by
the browser on any request to the origin; a bearer header is not. The
handoff-code indirection keeps the token itself out of the URL and browser
history — only a one-time, 60-second code rides in the redirect.

## Session token vs id_token

The browser never sees the IdP's `id_token` or holds a long-lived IdP-issued
credential. After verifying it once at `/api/auth/callback`, the server mints
its **own** short-lived session token (`identity/session.ts`, HS256, signed
with `SESSION_SECRET`, default 12h TTL) carrying only `sub = <local user id>`.
This is what the browser actually holds and sends. Consequences:

- A compromised `SESSION_SECRET` is a full identity compromise (rotate it —
  every outstanding session token invalidates immediately, since verification
  is stateless).
- Re-authentication with the IdP is required every `SESSION_TTL_MS`; there is
  **no refresh-token flow** in this increment (a documented limitation, see
  below).

## Provisioning (`PolicyService.provisionOidcUser`)

Just-in-time: a verified `id_token` is sufficient to create a local `User`
row, matched by `idpSubject === claims.sub`. On every login the name/email are
refreshed from the latest claims. Role comes from `OIDC_ADMIN_EMAILS` (a
static, comma-separated allowlist) **at first login only** — an owner later
dropped from the allowlist keeps whatever they already own rather than being
silently demoted mid-session. This is deliberately the simplest thing that
lets the demo show an owner-capable path without wiring real group sync.

This lives in `policy.ts`, not a separate identity-owned table, because the
existing ownership boundary already puts the user table there
(`docs/POLICY_ENFORCEMENT.md`): "Identity/Policy owner: `apps/server/src/
policy.ts` internals... swapping the seeded user table for a real identity
provider is the intended next step and touches nothing else." This is that
step; `hasScope` / `canSee` / route enforcement are untouched.

## Configuration (`apps/server/src/config.ts`)

| Variable | Required when `AUTH_MODE=oidc` | Purpose |
| --- | --- | --- |
| `AUTH_MODE` | — | `local` (default) or `oidc` |
| `OIDC_ISSUER` | yes | Base URL; `${issuer}/.well-known/openid-configuration` must resolve |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | yes | From the IdP application |
| `OIDC_REDIRECT_URI` | yes | Must exactly match what's registered with the IdP |
| `OIDC_SCOPES` | no (default `openid profile email`) | |
| `OIDC_ADMIN_EMAILS` | no | Comma-separated; see Provisioning above |
| `SESSION_SECRET` | yes, 24+ chars | Signs the app's own session token |
| `SESSION_TTL_MS` | no (default 12h) | |
| `WEB_ORIGIN` | no | Where `/api/auth/callback` redirects to; leave unset for same-origin (production) |

`loadConfig()` throws at startup if `AUTH_MODE=oidc` is set without the
required fields — fails fast, not on the first login attempt.

## Endpoints (`apps/server/src/identity/routes.ts`)

All four 404 when `AUTH_MODE=local` (the route exists; the handler refuses):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/login` | 302 to the IdP's authorization endpoint |
| `GET /api/auth/callback` | Receives the IdP redirect; completes the flow described above |
| `POST /api/auth/exchange` | `{ code }` → `{ token }`, one-time |
| `POST /api/auth/logout` | Client-side only (see Known limitations) |
| `GET /api/auth` | Now also returns `mode: "local" \| "oidc"` — the frontend's only branch point |

`GET /api/users` (the mock-mode principal roster) requires authentication in
oidc mode — it would otherwise leak real people's names and emails to anyone
unauthenticated.

## Known limitations

- **No refresh tokens.** A session expires after `SESSION_TTL_MS` with a
  full re-login, not a silent refresh. Acceptable for this increment; a
  rotating refresh token is the ADR's Phase 1 target.
- **Logout is client-side only.** The session token is a stateless signed JWT
  with nothing server-side to revoke; a leaked token remains valid until it
  naturally expires. Short TTLs mitigate; a revocation list is future work.
- **Role from a static allowlist, not group sync.** `OIDC_ADMIN_EMAILS` is a
  placeholder for real role/group provisioning (SCIM), which is Phase 3
  (tenancy) territory in the ADR.
- **In-memory flow state.** `identity/flow-store.ts`'s `state -> PKCE
  verifier` and `handoff code -> session token` maps are per-process, exactly
  like `JsonStore`. A multi-replica control plane needs this in Redis — see
  ADR 0001.
- **No tenancy.** Every OIDC-provisioned user lands in the same flat
  namespace as everyone else; there is still no `organization` concept.

## Tests

`identity-oidc.test.ts` runs the real flow against a real, ephemeral OIDC
provider (`identity/test-idp.ts`) — a local HTTP server with actual RSA
signing, real discovery and JWKS responses, not a stubbed network boundary.
Covers: login → callback → exchange → authenticated request; admin-email
provisioning; idempotent re-login for the same subject; the full
authorization flow (grants, ownership) for an OIDC-provisioned actor; a
reused handoff code; an unknown/reused `state`; a garbage bearer token; the
coarse `APP_AUTH_TOKEN` no longer doubling as a session in oidc mode; `/api/
users` requiring auth; and that every OIDC route 404s under the (default)
local mode. A `loadConfig` validation block covers the required-field and
`SESSION_SECRET` length checks.
