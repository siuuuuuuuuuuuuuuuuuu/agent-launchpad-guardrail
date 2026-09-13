variable "region" {
  description = "Volcengine region, for example cn-beijing."
  type        = string
}

variable "zone_id" {
  description = "Availability zone that has inventory for the chosen instance types."
  type        = string
}

variable "project_name" {
  description = "Volcengine project."
  type        = string
  default     = "default"
}

variable "allowed_api_cidr" {
  description = "CIDR allowed to reach the Kubernetes API server. This must be an explicit, restricted network."
  type        = string
  validation {
    condition     = var.allowed_api_cidr != "0.0.0.0/0"
    error_message = "allowed_api_cidr must not expose the Kubernetes API to the entire Internet."
  }
}

variable "key_pair_name" {
  description = "Existing ECS SSH key-pair name, used for node access."
  type        = string
}

variable "kubernetes_version" {
  description = "VKE Kubernetes version to create the cluster with, for example 1.28."
  type        = string
  default     = "1.28"
}

variable "control_plane_node_type" {
  description = "ECS instance type for the control-plane (API) node pool. 2 vCPU / 4 GiB or larger is recommended."
  type        = string
  default     = "ecs.g4i.large"
}

variable "control_plane_node_count_min" {
  description = "Minimum node count for the control-plane node pool."
  type        = number
  default     = 2
}

variable "control_plane_node_count_max" {
  description = "Maximum node count for the control-plane node pool."
  type        = number
  default     = 4
}

variable "runtime_node_type" {
  description = "ECS instance type for the runtime (Agent execution) node pool. Reserved for Phase 4's gVisor sandbox; unschedulable by default until that RuntimeClass is wired up."
  type        = string
  default     = "ecs.g4i.large"
}

variable "runtime_node_count_min" {
  description = "Minimum node count for the runtime node pool."
  type        = number
  default     = 1
}

variable "runtime_node_count_max" {
  description = "Maximum node count for the runtime node pool."
  type        = number
  default     = 3
}

variable "postgres_engine_version" {
  description = "Volcengine RDS for PostgreSQL engine version, for example PostgreSQL_14."
  type        = string
  default     = "PostgreSQL_14"
}

variable "postgres_node_spec" {
  description = <<-EOT
    Volcengine RDS for PostgreSQL node specification code (e.g. an "rds.postgres.*"
    spec ID). There is no safe default — available specs vary by region/zone.
    Look up a valid value in the Volcengine console (RDS for PostgreSQL ->
    Create Instance) or via the ListRdsPostgresqlAvailableSpec-style API before
    setting this.
  EOT
  type        = string
}

variable "postgres_storage_gb" {
  description = "RDS for PostgreSQL storage size, in GiB."
  type        = number
  default     = 20
}

variable "postgres_app_password" {
  description = "Password for the launchpad_app database account. Supplied through TF_VAR_postgres_app_password."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.postgres_app_password) >= 12
    error_message = "postgres_app_password must be at least 12 characters."
  }
}
