# Policy Enforcement — contract & wiring

Track: **Bouncer / delegated access**. This doc is the seam between the
Enforcement Point (wired here), the Identity/Policy Plane, and the Audit Layer.

## Trust boundary

```
Browser ──X-User-Id + Bearer──▶ Fastify
                                  │  onRequest:  shared-token gate (unchanged)
                                  │  onRequest:  resolve X-User-Id → principal (401 if unknown)
                                  │  preHandler: CHECKPOINT 1 — enforce(route→action)   ◀── Policy Plane
                                  ▼
                              AgentService
                                  │  executeRun: CHECKPOINT 2 — enforce("invoke")       ◀── Policy Plane
                                  ▼
                              AgentRunner ─▶ Codex   (only reached if both checkpoints allow)
```

Every call to `enforce()` writes one audit entry via the audit subsystem's
`AuditLogger.record()` (allow **and** deny), tagged `payload.checkpoint` =
`"request"` | `"runtime"`. A request that skips checkpoint 1 (direct
`AgentService` call, future internal route) is still stopped at checkpoint 2.

## Identity (mock)

- Principal is the `X-User-Id` header, resolved against the seeded user table
  (`apps/server/src/seed.ts`: `user-alice` owner-capable, `user-bob`,
  `user-carol`). Unknown/missing → `401`.
- The Starter Kit's `APP_AUTH_TOKEN` bearer check stays as a coarse gate.
- Frontend: call `setCurrentUser(id)` (in `apps/web/src/api.ts`) from the user
  switcher; it is sent on every request.

## Data model (`apps/server/src/types.ts`)

| Type | Key fields |
| --- | --- |
| `User` | `id`, `name`, `role: "owner-capable" \| "standard"` |
| `Agent` (extended) | `+ ownerId` — set to the creator, backfilled by store migration |
| `Grant` | `agentId`, `grantedTo`, `grantedBy`, `scopes: Scope[]`, `expiresAt`, `revokedAt` |
| `AuditEntry` | owned by `apps/server/src/audit-log/types.ts`: `actor{id,type}`, `action`, `target{type,id}`, `decision`, `payload`, `timestamp` |

`Scope = "invoke" | "view_config" | "edit_config" | "view_runs"`. Store bumped
to `version: 2`; v1 files migrate on load (agents/runs get a fallback owner).

## The one primitive

```ts
policy.hasScope(actorUserId, agentId, action) -> { allow: boolean, reason: string }
```

- Owner of the Agent → allow, any action.
- `delete` / `grant` / `revoke` are **owner-only** — no grant can confer them.
- Otherwise: allow iff a non-revoked, non-expired `Grant` to that user for that
  Agent includes the scope named by `action`.
- Pure read over the current store snapshot ⇒ a revoked grant is refused on the
  caller's very next request.

## Route → action map (`apps/server/src/enforcement.ts` `RULES`)

| Method + route | action | who passes |
| --- | --- | --- |
| `GET /api/agents` | — | always; response filtered to owned + granted |
| `POST /api/agents` | `create` | any principal; becomes `ownerId` |
| `GET /api/agents/:id` | `view_config` | owner / `view_config` |
| `PATCH /api/agents/:id` | `edit_config` | owner / `edit_config` |
| `DELETE /api/agents/:id` | `delete` | owner only |
| `POST /api/agents/:id/start`·`/stop` | `invoke` | owner / `invoke` |
| `POST /api/agents/:id/messages` | `invoke` | owner / `invoke` — **+ checkpoint 2** |
| `GET /api/agents/:id/messages`·`/runs`, `GET /api/runs/:id` | `view_runs` | owner / `view_runs` |
| `GET`·`POST /api/agents/:id/grants` | `grant` | owner only |
| `DELETE /api/agents/:id/grants/:grantId` | `revoke` | owner only |

`grant`/`revoke` routes carry `handlerAudits` — the handler writes the one
authoritative entry (with `grantId`, `grantedTo`, `scopes`); the checkpoint only
logs the deny path. Listing grants (`GET`) is a read and is not logged on allow.

## New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/users` | seeded principals (for the switcher) |
| `GET /api/me` | current principal |
| `GET /api/agents/:id/grants` | list grants (owner) |
| `POST /api/agents/:id/grants` | `{ grantedTo, scopes[], expiresAt? }` → create grant (owner) |
| `DELETE /api/agents/:id/grants/:grantId` | revoke (owner) |
| `GET /api/audit` (from `audit-log/routes.ts`) | filtered audit log — `?actor=&action=&target=&decision=&from=&to=&limit=&cursor=` → `{ entries, nextCursor }` |

## Handoff notes

- **Identity/Policy owner:** `apps/server/src/policy.ts` internals + `seed.ts`.
  Keep `hasScope` / `getUser` / `canSee` signatures stable — the enforcement
  layer depends only on those. `createGrant` validates scopes, `expiresAt`, and
  that `grantedBy` is the Agent owner; swapping the seeded user table for a real
  identity provider is the intended next step and touches nothing else.
- **Audit** (merged from `main`, owned by `apps/server/src/audit-log/`):
  enforcement calls `AuditLogger.record({ actor, action, target, decision,
  payload })`. `createApp(config, service, auditStore, policy)` builds the
  Fastify-boundary logger and decorates `app.auditLogger`; `index.ts` builds a
  second logger over the same `JsonlAuditStore` for the runtime checkpoint in
  `AgentService`.

## Demo (curl — checkpoint is real, not a hidden button)

```bash
A='-H "X-User-Id: user-alice"'; B='-H "X-User-Id: user-bob"'
# Alice creates, Bob is denied invoke, Alice grants invoke, Bob invokes, Bob
# is denied delete (owner-only), Alice revokes, Bob is denied invoke again.
curl -sX POST localhost:3000/api/agents $A -d '{"name":"Builder"}'
curl -sX POST localhost:3000/api/agents/$ID/messages $B -d '{"content":"hi"}'   # 403
curl -sX POST localhost:3000/api/agents/$ID/grants   $A -d '{"grantedTo":"user-bob","scopes":["invoke"]}'
curl -sX POST localhost:3000/api/agents/$ID/messages $B -d '{"content":"hi"}'   # 202
curl -sX DELETE localhost:3000/api/agents/$ID        $B                          # 403 owner-only
curl -sX DELETE localhost:3000/api/agents/$ID/grants/$GRANT $A                    # 200
curl -sX POST localhost:3000/api/agents/$ID/messages $B -d '{"content":"hi"}'   # 403
curl -s "localhost:3000/api/audit?target=$ID" $A
```

Tests: `policy.test.ts` (hasScope + grant validation), `enforcement.test.ts`
(full HTTP scenario + runtime-boundary bypass), `guardrail-integration.test.ts`
(identity → enforcement → audit through the real `GET /api/audit` route).
`./scripts/guardrail-demo.sh` runs the scenario above against a live server.
