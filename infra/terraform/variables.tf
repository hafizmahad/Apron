/**
 * One environment (CLAUDE.md §3), so these are knobs for sizing and for the two things
 * that genuinely vary between applies — the image tag and whether AI is switched on.
 *
 * There is deliberately no `environment` variable. Nothing is parameterised across
 * environments that will not exist, because every such variable is a place for the
 * deployed stack to differ from the one that was tested.
 */

variable "region" {
  description = "The single region everything is deployed into."
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Prefix for every resource name, so the account reads unambiguously."
  type        = string
  default     = "apron"
}

# --- network ---------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the Apron VPC. Deliberately not 172.31/16, which is the default VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zone_count" {
  description = <<-EOT
    Two. Both the ALB and an RDS subnet group require subnets in at least two zones.
    Raising it costs a NAT gateway per zone for no benefit this stack can use.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count == 2
    error_message = "Two availability zones. See the description; three buys nothing here."
  }
}

# --- application -----------------------------------------------------------

variable "image_tag" {
  description = <<-EOT
    The tag both services run, normally the commit SHA the pipeline pushed.

    On the very first apply nothing has been pushed yet, so the ECR repositories are
    created and the images pushed before the services are. See README §2.
  EOT
  type        = string
  default     = "bootstrap"
}

variable "web_desired_count" {
  description = "Two, so a deployment rolls rather than interrupting."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = <<-EOT
    One. The worker owns acknowledgement-SLA expiry, re-matching, notification delivery
    and document generation. Jobs are idempotent, but nothing about them was written to
    be raced between two workers, and one environment has no need of a second.

    It is never zero. Without a worker, offers sit unacknowledged forever.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.worker_desired_count >= 1
    error_message = "At least one worker, or acknowledgement SLAs never expire."
  }
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  type    = number
  default = 512
}

variable "worker_memory" {
  type    = number
  default = 1024
}

variable "log_retention_days" {
  description = "CloudWatch retention. Long enough to investigate, short enough to be cheap."
  type        = number
  default     = 30
}

# --- data ------------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  description = <<-EOT
    Seven days of automated backups. Single-AZ is the deliberate choice for one
    environment — Multi-AZ doubles the largest line on the bill — so backups plus the
    documented restore in docs/OPERATIONS.md are the recovery story, not a standby.
  EOT
  type        = number
  default     = 7
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

# --- AI --------------------------------------------------------------------

variable "openai_api_key" {
  description = <<-EOT
    Optional. Leave empty and the platform runs with AI off, which is a supported state
    rather than a degraded one: intake falls back to the manual structured form and
    matching uses the deterministic top-ranked eligible candidate (CLAUDE.md §22,
    Journey E). Supply it and the four model names below become required.

    Prefer setting it in Secrets Manager afterwards over putting it in a tfvars file.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_intake_model" {
  type    = string
  default = "gpt-4.1-mini"
}

variable "openai_reasoning_model" {
  type    = string
  default = "gpt-4.1"
}

variable "openai_research_model" {
  type    = string
  default = "gpt-4.1"
}

variable "openai_summary_model" {
  type    = string
  default = "gpt-4.1-mini"
}

# --- pipeline --------------------------------------------------------------

variable "github_repository" {
  description = "owner/name. Scopes the OIDC trust policy to exactly this repository."
  type        = string
  default     = "hafizmahad/Apron"
}

variable "github_deploy_branch" {
  description = "The only branch allowed to assume the deploy role."
  type        = string
  default     = "main"
}
