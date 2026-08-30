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

Every call to `enforce()` writes one `AuditEntry` (allow **and** deny) before it
returns or throws. A request that skips checkpoint 1 (direct `AgentService`
call, future internal route) is still stopped at checkpoint 2.

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
| `AuditEntry` | `timestamp`, `actorUserId`, `agentId`, `action`, `requestedScope`, `decision`, `result` |

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

## New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/users` | seeded principals (for the switcher) |
| `GET /api/me` | current principal |
| `GET /api/agents/:id/grants` | list grants (owner) |
| `POST /api/agents/:id/grants` | `{ grantedTo, scopes[], expiresAt? }` → create grant (owner) |
| `DELETE /api/agents/:id/grants/:grantId` | revoke (owner) |
| `GET /api/audit?actorUserId=&agentId=&action=&decision=&limit=` | filtered audit log |

## Handoff notes

- **Identity/Policy owner:** `apps/server/src/policy.ts` internals + `seed.ts`
  are yours. Keep `hasScope` / `getUser` / `canSee` signatures; the grant CRUD
  here is a minimal placeholder.
- **Audit owner:** `apps/server/src/audit.ts` — keep the `AuditLog` interface;
  `JsonAuditLog` is a stub over the same JSON store. `redact()` strips
  key/token/password-shaped strings before write.

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
curl -s "localhost:3000/api/audit?agentId=$ID" $A
```

Tests: `apps/server/src/policy.test.ts`, `apps/server/src/enforcement.test.ts`
(full scenario + runtime-boundary bypass).
