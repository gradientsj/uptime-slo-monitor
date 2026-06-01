# Cloud SQL for PostgreSQL — backing store for probe results and SLO state.
resource "random_password" "db" {
  length  = 24
  special = false
}

resource "google_sql_database_instance" "pg" {
  name             = "${var.cluster_name}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      ipv4_enabled = true
      dynamic "authorized_networks" {
        for_each = var.authorized_networks
        content {
          name  = "net-${authorized_networks.key}"
          value = authorized_networks.value
        }
      }
    }
  }

  deletion_protection = false
  depends_on          = [google_project_service.services]
}

resource "google_sql_database" "app" {
  name     = var.db_name
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "app" {
  name     = var.db_user
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}
