# Volcengine VKE substrate for the Agent Launchpad control plane (ADR-0002).
#
# Additive alongside ../volcengine (the single-VM POC path) — a separate
# Terraform state, distinctly named so both can coexist in the same account
# and region during a migration.
#
# A few enum-shaped string values below were confirmed from the provider's
# own attribute descriptions (via `terraform providers schema -json` against
# volcenginecc 0.0.58), which is reliable, but the provider schema does not
# encode *allowed values* for plain string fields, only types. Anything not
# directly quoted from a schema description is flagged inline with "VERIFY:"
# and should be checked against the Volcengine console/API before the first
# real `apply`.

locals {
  name = "agent-launchpad-k8s"
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

resource "volcenginecc_vpc_vpc" "this" {
  vpc_name              = local.name
  description           = "VPC for the Agent Launchpad Kubernetes substrate"
  cidr_block            = "10.60.0.0/16"
  support_ipv_4_gateway = true
  enable_ipv_6          = false
  project_name          = var.project_name
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

# Control-plane ENIs and both node pools. Kept in one subnet for this first
# slice; splitting node pools across subnets/zones is future work once real
# capacity/AZ requirements are known.
resource "volcenginecc_vpc_subnet" "nodes" {
  vpc_id      = volcenginecc_vpc_vpc.this.id
  zone_id     = var.zone_id
  subnet_name = "${local.name}-nodes"
  description = "Cluster control plane and node pools"
  cidr_block  = "10.60.0.0/20"
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

# VPC-CNI pod network needs its own, larger subnet distinct from the node
# subnet (one ENI/IP per Pod).
resource "volcenginecc_vpc_subnet" "pods" {
  vpc_id      = volcenginecc_vpc_vpc.this.id
  zone_id     = var.zone_id
  subnet_name = "${local.name}-pods"
  description = "VPC-CNI Pod network"
  cidr_block  = "10.60.16.0/20"
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_vpc_subnet" "data" {
  vpc_id      = volcenginecc_vpc_vpc.this.id
  zone_id     = var.zone_id
  subnet_name = "${local.name}-data"
  description = "Managed data services (RDS for PostgreSQL)"
  cidr_block  = "10.60.32.0/24"
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_vpc_security_group" "this" {
  vpc_id              = volcenginecc_vpc_vpc.this.id
  security_group_name = local.name
  description         = "Kubernetes API access for Agent Launchpad"
  project_name        = var.project_name
  ingress_permissions = [
    {
      description     = "Kubernetes API server"
      direction       = "ingress"
      policy          = "accept"
      port_start      = 6443
      port_end        = 6443
      priority        = 1
      protocol        = "tcp"
      cidr_ip         = var.allowed_api_cidr
      prefix_list_id  = ""
      source_group_id = ""
    }
  ]
  # Ingress-controller ports (80/443) and any add-on-specific rules are
  # deferred to the Helm chart / ingress-controller install, not this module.
  egress_permissions = [
    {
      description     = "Outbound access for image pulls, Ark, and package registries"
      direction       = "egress"
      policy          = "accept"
      port_start      = -1
      port_end        = -1
      priority        = 1
      protocol        = "all"
      cidr_ip         = "0.0.0.0/0"
      prefix_list_id  = ""
      source_group_id = ""
    }
  ]
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

# ---------------------------------------------------------------------------
# VKE cluster
# ---------------------------------------------------------------------------

resource "volcenginecc_vke_cluster" "this" {
  name                      = local.name
  description               = "Agent Launchpad control plane cluster"
  project_name              = var.project_name
  kubernetes_version_create = var.kubernetes_version
  delete_protection_enabled = false

  cluster_config = {
    # security_group_ids is computed-only on this resource (VKE manages its
    # own control-plane security group); node-level access is controlled via
    # each node pool's node_config.security.security_group_ids instead.
    subnet_ids                             = [volcenginecc_vpc_subnet.nodes.id]
    api_server_public_access_enabled       = true
    resource_public_access_default_enabled = false
    api_server_public_access_config = {
      public_access_network_config = {
        # billing_type: 2 = pay-as-you-go by bandwidth cap, 3 = pay-as-you-go
        # by actual traffic (confirmed from the schema description).
        billing_type = 3
        isp          = "BGP"
      }
    }
  }

  # VPC-CNI: ENI-backed Pod networking, one IP per Pod — chosen over Flannel
  # so future per-org network policy / egress-proxy work (ADR-0001 Phase 4)
  # has real Pod-level addressability to work with.
  pods_config = {
    pod_network_mode = "VpcCniShared"
    vpc_cni_config = {
      subnet_ids = [volcenginecc_vpc_subnet.pods.id]
    }
  }

  services_config = {
    service_cidrsv_4 = ["172.30.0.0/18"]
  }

  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

# ---------------------------------------------------------------------------
# Node pools
# ---------------------------------------------------------------------------

resource "volcenginecc_vke_node_pool" "control_plane" {
  cluster_id = volcenginecc_vke_cluster.this.cluster_id
  name       = "${local.name}-control-plane"

  auto_scaling = {
    enabled          = true
    min_replicas     = var.control_plane_node_count_min
    max_replicas     = var.control_plane_node_count_max
    desired_replicas = var.control_plane_node_count_min
    subnet_policy    = "ZoneBalance"
  }

  node_config = {
    instance_type_ids    = [var.control_plane_node_type]
    subnet_ids           = [volcenginecc_vpc_subnet.nodes.id]
    instance_charge_type = "PostPaid"
    spot_strategy        = "NoSpot"
    security = {
      security_group_ids = [volcenginecc_vpc_security_group.this.id]
      login = {
        ssh_key_pair_name = var.key_pair_name
      }
    }
    system_volume = {
      type = "ESSD_PL0"
      size = 40
    }
  }

  kubernetes_config = {
    labels = [
      {
        key   = "launchpad.io/role"
        value = "control-plane"
      }
    ]
  }

  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

# Reserved for Agent run execution. Tainted so nothing schedules here until
# Phase 4 installs the gVisor `runsc` RuntimeClass and the workload targets
# this pool explicitly via toleration + nodeSelector.
resource "volcenginecc_vke_node_pool" "runtime" {
  cluster_id = volcenginecc_vke_cluster.this.cluster_id
  name       = "${local.name}-runtime"

  auto_scaling = {
    enabled          = true
    min_replicas     = var.runtime_node_count_min
    max_replicas     = var.runtime_node_count_max
    desired_replicas = var.runtime_node_count_min
    subnet_policy    = "ZoneBalance"
  }

  node_config = {
    instance_type_ids    = [var.runtime_node_type]
    subnet_ids           = [volcenginecc_vpc_subnet.nodes.id]
    instance_charge_type = "PostPaid"
    spot_strategy        = "NoSpot"
    security = {
      security_group_ids = [volcenginecc_vpc_security_group.this.id]
      login = {
        ssh_key_pair_name = var.key_pair_name
      }
    }
    system_volume = {
      type = "ESSD_PL0"
      size = 40
    }
  }

  kubernetes_config = {
    labels = [
      {
        key   = "launchpad.io/role"
        value = "runtime"
      }
    ]
    taints = [
      {
        key    = "launchpad.io/runtime"
        value  = "agent"
        effect = "NoSchedule"
      }
    ]
  }

  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

# Admin kubeconfig for CI/CD and operator access. Treat the output as a
# secret (it grants cluster-admin) — see docs/DEPLOYMENT.md once the
# Helm/CI follow-up lands for how it should actually be stored/rotated.
resource "volcenginecc_vke_kubeconfig" "admin" {
  cluster_id = volcenginecc_vke_cluster.this.cluster_id
  # VERIFY: "Public" routes over the public API endpoint enabled above via
  # api_server_public_access_enabled; confirm this is the exact accepted
  # enum value (vs. e.g. "Internet") before relying on it.
  type = "Public"
}

# ---------------------------------------------------------------------------
# Container Registry
# ---------------------------------------------------------------------------

resource "volcenginecc_cr_registry" "this" {
  name    = local.name
  project = var.project_name
  # VERIFY: confirmed as a real optional field (Enterprise vs Micro edition)
  # from the provider's own markdown docs, but the exact accepted string is
  # not encoded in the machine-readable schema — check before first apply.
  type = "Enterprise"
  endpoint = {
    enabled = true
  }
  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_cr_name_space" "launchpad" {
  registry = volcenginecc_cr_registry.this.name
  name     = "launchpad"
  project  = var.project_name
}

# ---------------------------------------------------------------------------
# RDS for PostgreSQL (ADR-0001 Phase 2 system of record)
# ---------------------------------------------------------------------------

resource "volcenginecc_rdspostgresql_instance" "this" {
  instance_name     = "${local.name}-postgres"
  project_name      = var.project_name
  vpc_id            = volcenginecc_vpc_vpc.this.id
  subnet_id         = volcenginecc_vpc_subnet.data.id
  db_engine_version = var.postgres_engine_version
  # Confirmed from the provider's markdown docs: "LocalSSD" is a valid value.
  storage_type  = "LocalSSD"
  storage_space = var.postgres_storage_gb

  charge_detail = {
    charge_type = "PostPaid"
  }

  node_info = [
    {
      node_spec = var.postgres_node_spec
      # VERIFY: node_type is a required enum (schema confirms the field,
      # not its accepted values). "Primary" is the expected value for a
      # single-node instance — confirm before apply, especially if an HA
      # (Primary+Secondary) topology is wanted instead.
      node_type = "Primary"
      zone_id   = var.zone_id
    }
  ]

  tags = [
    {
      key   = "application"
      value = local.name
    }
  ]
}

resource "volcenginecc_rdspostgresql_database" "app" {
  instance_id = volcenginecc_rdspostgresql_instance.this.id
  db_name     = "launchpad"
}

resource "volcenginecc_rdspostgresql_db_account" "app" {
  instance_id      = volcenginecc_rdspostgresql_instance.this.id
  account_name     = "launchpad_app"
  account_password = var.postgres_app_password
  # VERIFY: exact accepted enum for a non-superuser application account
  # (schema confirms the field is required, not its accepted values).
  account_type = "Normal"
}
