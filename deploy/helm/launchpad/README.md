# launchpad Helm chart

Deploys the existing Agent Launchpad app onto the VKE cluster provisioned by
`../volcengine-k8s`. See [ADR-0002](../../../docs/adr/0002-kubernetes-deployment-substrate.md)
for the broader plan this fits into.

## Before installing

1. **Build and push the image.** There's no CI/CD wiring yet (that's a
   separate ADR-0002 follow-up), so this is manual for now:

   ```bash
   docker build -t <registry-endpoint>/launchpad/agent-launchpad:<tag> .
   docker push <registry-endpoint>/launchpad/agent-launchpad:<tag>
   ```

   `<registry-endpoint>` and the `launchpad` namespace come from the
   Terraform module's `registry_name` / `registry_namespace` outputs — the
   registry's exact pull/push hostname isn't exposed as a Terraform
   attribute by this provider version, so read it from the Volcengine
   console.

2. **Provide secrets.** Create a `values-secret.yaml` (untracked — do not
   commit it) with at least:

   ```yaml
   secrets:
     APP_AUTH_TOKEN: "..."   # 24+ random characters
     ARK_API_KEY: "..."
   ```

   Add `OIDC_CLIENT_SECRET` and `SESSION_SECRET` too if setting
   `env.AUTH_MODE: oidc`. Alternatively, create the Secret yourself outside
   Helm and set `existingSecretName` instead of `secrets`.

## Install / upgrade

```bash
helm upgrade --install launchpad . \
  -f values-secret.yaml \
  --set image.repository=<registry-endpoint>/launchpad/agent-launchpad \
  --set image.tag=<tag> \
  --set env.ARK_MODEL=ep-your-endpoint-id
```

## Constraints, by design

- **Single replica only.** `replicaCount` defaults to `1` and must stay
  there until ADR-0001 Phase 2 (Postgres-backed repositories) replaces
  `JsonStore`, which is a single JSON file today — concurrent writers from
  two pods would corrupt it. The Deployment also uses `Recreate` strategy
  for this reason (the state PVC is `ReadWriteOnce`).
- **`RUNTIME_PROVIDER` stays `local-process`.** Codex runs in the same pod
  as the API, with no per-run sandbox — matching today's production default
  outside Kubernetes too. Real sandboxed execution (gVisor, a durable queue,
  object-storage workspaces) is ADR-0001 Phase 4, not this chart. The
  `runtime` node pool the Terraform module provisions is reserved for that
  and is unused until then.
- **No autoscaling, no NetworkPolicy.** Both would be premature ahead of the
  Phase 2/4 work above.
