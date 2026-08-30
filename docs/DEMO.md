# Demo — 3-minute delegated-access walkthrough

Shows per-Agent delegated access, server-side enforcement, live revocation, and
the audit trail. Two ways to run it: the scripted API walkthrough (fast, no ARK
key needed) and the browser version (what you present).

## Setup (once, before the demo)

```bash
npm run poc          # ARK_API_KEY + ARK_MODEL in env, or a .env file
# server + web on http://localhost:3000
```

For the browser demo you want a working Runtime (real `ARK_API_KEY`) so an
allowed invoke returns a result. The API script works without one — an allowed
invoke returns 503 and the point (the decision + audit entry) still lands.

Principals are seeded (`apps/server/src/seed.ts`): **Alice** (owner-capable),
**Bob**, **Carol**. No passwords — identity is the `X-User-Id` header, set by the
UI's principal switcher.

## Scripted version (≈15s, proves it's real)

```bash
./scripts/guardrail-demo.sh
```

Creates an Agent as Alice, runs all 8 steps as Alice/Bob via direct `curl`
(no UI), and prints the audit trail. Exit code 0 means every decision matched.
Use this as the reproducibility check and as a fallback if the browser misbehaves.

## Browser version (the 3-minute script)

| ⏱ | Do | Say / show |
| --- | --- | --- |
| 0:00 | Open `localhost:3000`. Pick **Alice**. Create Agent "Playground". Send it one prompt, let it respond. | "Single-user starter kit — we added identity, authorization, and audit. Alice owns this Agent." |
| 0:40 | Switch principal to **Bob**. Open Playground, send a prompt. | Denied banner: *no live grant for scope 'invoke'*. "Bob has no access. This is refused in the backend, not hidden in the UI." |
| 1:05 | Switch to **Alice** → **Access** panel → grant **Bob** `invoke` only → Create grant. | "Scoped grant. Not view-config, not delete — just invoke." |
| 1:30 | Switch to **Bob**. Send a prompt — it runs. | "Same user, same UI, now allowed — because the grant exists." |
| 1:50 | In a terminal, as Bob, hit the API directly: `curl -X DELETE localhost:3000/api/agents/$ID -H "X-User-Id: user-bob"` | `403` — *owner-only action: delete*. "Bypassing the UI doesn't help. Delete is owner-only; no grant can confer it." |
| 2:10 | Switch to **Alice** → **Access** → **Revoke** Bob's grant. | "Revoked, live." |
| 2:25 | Switch to **Bob**. Send a prompt. | Denied again. "Allowed 30 seconds ago. Revocation takes effect on his next request — it's a fresh read, no cache." |
| 2:40 | Switch to **Alice** → **Audit** panel. Toggle **deny**. | "Every decision — grant, allow, deny, revoke — with actor, action, checkpoint, reason, timestamp. Here are exactly the three denials we just triggered." |
| 2:55 | — | "Enforced at the request boundary *and* re-checked at the Runtime boundary before Codex runs. A bypass at one layer is still stopped at the other." |

## What the audit trail looks like

```
user-alice  create   allow [request]
user-bob    invoke   deny  [request] no live grant for scope 'invoke'
user-alice  grant    allow [request]
user-bob    invoke   allow [request] grant <id>
user-bob    delete   deny  [request] owner-only action: delete
user-alice  revoke   allow [request]
user-bob    invoke   deny  [request] no live grant for scope 'invoke'
user-alice  invoke   allow [request] owner
```

With a real `ARK_API_KEY`, each allowed invoke also produces a second
`invoke allow [runtime]` entry — checkpoint 2, logged just before Codex starts.

## If something breaks

- **Every request 401s** — no principal selected; pick a user, or clear
  `localStorage` and reload.
- **Allowed invoke returns 503** — no `ARK_API_KEY`. Expected outside the demo
  box; enforcement and audit are unaffected.
- **Browser flaky** — run `./scripts/guardrail-demo.sh` and narrate its output.

## Known limitations (state these, don't hide them)

- Mock identity (`X-User-Id`), not production auth — intentional per scope.
- One protected resource type (Agents) wired; the scope model generalizes.
- Audit is a flat filterable table, not a span-tree observability system.
- No sandboxing work beyond what revocation itself provides.
