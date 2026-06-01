output "cluster_name" {
  value = google_container_cluster.primary.name
}

output "get_credentials_command" {
  description = "Run this to point kubectl/helm at the new cluster."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.primary.name} --zone ${var.zone} --project ${var.project_id}"
}

output "sql_instance_connection_name" {
  value = google_sql_database_instance.pg.connection_name
}

output "sql_public_ip" {
  value = google_sql_database_instance.pg.public_ip_address
}

output "database_url" {
  description = "Connection string for the worker/web. Feed into the Helm values / Vercel env."
  sensitive   = true
  value = format(
    "postgres://%s:%s@%s:5432/%s?sslmode=require",
    var.db_user,
    random_password.db.result,
    google_sql_database_instance.pg.public_ip_address,
    var.db_name,
  )
}
