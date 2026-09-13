# ADR 0002 — Kubernetes deployment substrate

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Platform team
- **Supersedes:** none

## Context

[ADR 0001](0001-enterprise-saas-target-architecture.md) lists "deployment
substrate" as open question #1: Kubernetes vs. a managed container platform vs.
Volcengine-native services. That ADR flags it as needing a decision **before
Phase 2 infra work** (Postgres, stateless control plane) and as the choice that
drives the Phase 4 sandbox (gVisor assumes Kubernetes). The decision is now
made: **Kubernetes.**

Current state, for grounding:

- Production defaults to `RUNTIME_PROVIDER=local-process`
  (`.env.example`, `apps/server/src/config.ts`): Codex runs in-process, with no
  per-run sandbox container at all. `ContainerCodexRunner`
  (`apps/server/src/container-codex-runner.ts`) exists and shells out to
  `docker run` with bind mounts, but it's opt-in
  (`RUNTIME_PROVIDER=container`) and only usable where the server process
  itself has real Docker access — nothing in `Dockerfile` or
  `docker-compose.yml` mounts a Docker socket into the app container today.
- Persistence is a single-process `JsonStore` (`apps/server/src/store.ts`)
  writing one JSON file to `APP_DATA_DIR` — matches the ADR-0001 gap table's
  "single-process JSON file" row exactly.
- Infra today is one Volcengine ECS VM provisioned by Terraform
  (`deploy/volcengine/main.tf`: VPC, subnet, security group, ECS instance,
  EIP) running Docker Compose, documented in `docs/DEPLOYMENT.md`.

## Decision

Adopt Kubernetes, specifically **Volcengine VKE** (managed Kubernetes), to stay
on the existing cloud vendor and reuse the team's Volcengine Terraform
experience. Application workload manifests stay vendor-neutral (plain
Deployments/Services/Ingress, no VKE-specific APIs) per ADR-0001's "swappable
vendors" principle — VKE is a hosting choice, not a coupling.

### Cluster topology

- One regional VKE cluster per environment (dev/staging/prod), reusing the
  existing VPC/subnet/security-group Terraform pattern from
  `deploy/volcengine/main.tf`.
- Two node pools from day one:
  - `control-plane` — general-purpose nodes for the stateless API.
  - `runtime` — reserved/tainted for run execution; this is where gVisor's
    `runsc` `RuntimeClass` gets installed in Phase 4. Provisioning the pool now
    means Phase 4 is a software change on existing nodes, not a new pool.
- Ingress via an ingress controller (nginx-ingress or Volcengine's ALB Ingress
  Controller) fronted by a Volcengine CLB. NAT gateway for egress until Phase
  4's per-org egress proxy replaces default-allow-all.

### Data plane

- **Postgres:** Volcengine RDS for PostgreSQL, managed and outside the
  cluster — directly matches ADR-0001 Phase 2's "managed Postgres with PITR"
  target. Provisioned when Phase 2 application work (repositories, migration
  tool) actually starts, not needed to stand up the cluster itself.
- **Redis:** Volcengine managed Redis, same reasoning (managed, outside the
  cluster), provisioned when Phase 4's queue work starts. Recorded now so this
  choice doesn't need revisiting later.

### App deployment shape (future work)

One Helm chart with: a Deployment for the control plane, a Service, an
Ingress, a ConfigMap for non-secret env (mirrors the env schema in
`apps/server/src/config.ts`), and a plain Kubernetes `Secret` for credentials
initially. The plain Secret is an explicit interim step — ADR-0001's
secrets-manager/KMS target (e.g. an External Secrets Operator pulling from a
managed KMS) is follow-up work, not a Phase 2 blocker.

### The sequencing risk

Control-plane replica count and run-execution scale-out are **not** the same
axis, and ADR-0001's Phase 2 exit criteria ("two control-plane replicas can run
concurrently") only requires the first:

- The **API** can go multi-replica as soon as it's stateless, which just needs
  Postgres (Phase 2).
- **Run execution** stays effectively single-instance as long as a run's
  workspace is a bind-mounted local directory — that doesn't generalize across
  pods on different nodes. It only decouples once Phase 4 moves workspaces to
  object storage with hydrate/persist.

Recommendation: don't block Phase 2 on solving run-execution scale-out. Ship a
multi-replica API with run execution still pinned to a single pod/instance,
and carry that pin as a documented limitation until Phase 4 lands.

### Migration path

Additive, not a replacement, in this pass. `deploy/volcengine/` (single ECS +
Docker Compose) stays as the documented path in `docs/DEPLOYMENT.md` for the
POC/demo use case. A new `deploy/volcengine-k8s/` Terraform module (VKE
cluster, node pools, RDS instance, container registry, IAM/RAM roles) is
future work, standing alongside the existing module, not deleting it.

### CI/CD (future work)

Build and push the existing `Dockerfile` image to Volcengine Container
Registry on merge to `main`, then `helm upgrade --install` against the cluster
from GitHub Actions (`.github/workflows/`).

### Local development

Unchanged. Docker Compose stays the primary local-dev path, per ADR-0001's
explicit non-goal of regressing the one-command POC start. An optional local
Kubernetes path (`kind`/`k3d`) is future work, not required.

## Consequences

**Positive**

- Unblocks Phase 2 infra work and matches the substrate Phase 4's gVisor plan
  assumes.
- Horizontal scaling becomes possible for the control plane once it's
  stateless.
- Managed Postgres/Redis reduce operational burden versus self-hosting either
  in-cluster.

**Negative / costs**

- New operational surface versus today's single VM: a Kubernetes cluster, RDS,
  managed Redis (once provisioned), a container registry, Helm releases.
- The sequencing risk above must stay visible in planning until Phase 4
  resolves it — it's easy to assume "Postgres landed, so we're horizontally
  scaled" and be wrong about run execution specifically.

## Open questions

Only ADR-0001 open question #1 (deployment substrate) is resolved by this
ADR. Questions #2–#6 (data residency, model providers, compliance target,
pricing unit, on-prem/self-hosted offering) remain open and are unaffected by
this decision.
