output "cluster_id" {
  description = "VKE cluster ID."
  value       = volcenginecc_vke_cluster.this.cluster_id
}

output "control_plane_node_pool_id" {
  description = "Node pool ID for the control-plane (API) node pool."
  value       = volcenginecc_vke_node_pool.control_plane.node_pool_id
}

output "runtime_node_pool_id" {
  description = "Node pool ID for the runtime (Agent execution) node pool. Tainted; nothing schedules here until Phase 4 wires up the gVisor RuntimeClass."
  value       = volcenginecc_vke_node_pool.runtime.node_pool_id
}

output "registry_name" {
  description = "Container Registry instance name. The exact pull/push endpoint hostname is not exposed as a resource attribute by this provider version — read it from the Volcengine console."
  value       = volcenginecc_cr_registry.this.name
}

output "registry_namespace" {
  description = "Container Registry namespace for the app image, e.g. <endpoint>/launchpad/<repo>:<tag>."
  value       = volcenginecc_cr_name_space.launchpad.name
}

output "postgres_instance_id" {
  description = "RDS for PostgreSQL instance ID."
  value       = volcenginecc_rdspostgresql_instance.this.id
}

output "postgres_database" {
  description = "Application database name."
  value       = volcenginecc_rdspostgresql_database.app.db_name
}

output "postgres_app_account" {
  description = "Application database account name (password supplied via TF_VAR_postgres_app_password, not exposed here)."
  value       = volcenginecc_rdspostgresql_db_account.app.account_name
}

output "kubeconfig" {
  description = "Admin kubeconfig for the cluster. Grants cluster-admin — handle as a secret."
  value       = volcenginecc_vke_kubeconfig.admin.kubeconfig
  sensitive   = true
}
