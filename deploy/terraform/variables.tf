variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "GCP region for the cluster and Cloud SQL."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the (zonal) GKE cluster — cheaper than regional."
  type        = string
  default     = "us-central1-a"
}

variable "cluster_name" {
  description = "GKE cluster name."
  type        = string
  default     = "uptime-slo"
}

variable "node_machine_type" {
  description = "Machine type for GKE nodes."
  type        = string
  default     = "e2-small"
}

variable "node_count" {
  description = "Number of nodes in the primary node pool."
  type        = number
  default     = 2
}

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "db_name" {
  description = "Application database name."
  type        = string
  default     = "uptime"
}

variable "db_user" {
  description = "Application database user."
  type        = string
  default     = "uptime_app"
}

variable "authorized_networks" {
  description = "CIDRs allowed to reach Cloud SQL public IP (e.g. your IP/32). Empty = none."
  type        = list(string)
  default     = []
}
