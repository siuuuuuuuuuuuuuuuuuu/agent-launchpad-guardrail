# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Identity is a **mock**: a trusted `X-User-Id` header resolved against a seeded
  user table (`apps/server/src/seed.ts`). No OAuth/SSO, no passwords, no session
  management. Anything that can set request headers can assume any principal —
  the shared `APP_AUTH_TOKEN` is the only barrier to that.
- Authorization **is** enforced server-side (per-Agent delegated, scoped,
  revocable grants; checked at the Fastify and `AgentRunner` boundaries; every
  decision audited). See [docs/POLICY_ENFORCEMENT.md](docs/POLICY_ENFORCEMENT.md).
  It is not a general policy engine and covers one resource type (Agents).
- Audit reads are scoped by principal: an operator (`owner-capable`) sees the
  whole log; anyone else must name an Agent they own or hold a grant on, and an
  untargeted query returns only their own actions. This is coarse — a grantee
  can still see other principals' activity on a shared Agent.
- No tenant isolation at the Runtime/container layer.
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
