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
    The tag the task definitions reference — the commit SHA the pipeline pushed.

    **No default, deliberately.** It used to default to "bootstrap", a tag that exists in
    no registry, so a bare `terraform apply` would quietly register task definitions
    pointing at an image that cannot be pulled. Required means a forgotten value stops the
    plan instead of producing a broken revision.

    Read the deployed one rather than guessing:

      aws ecs describe-task-definition --task-definition apron-web \
        --query 'taskDefinition.containerDefinitions[0].image' --output text

    Terraform owns the *shape* of a task definition — environment, secrets, roles, sizing,
    health check — and the pipeline owns the *image*. They meet here, which is why a plan
    run after a deploy shows the task definitions being replaced: Terraform's state still
    holds the tag it last wrote. Applying that is inert, because both services carry
    `ignore_changes = [task_definition]` and so keep running the revision the pipeline gave
    them. What is not inert is pointing a service at Terraform's revision by hand — that
    rolls the image back. Let the pipeline move services; it is the only thing that should.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", var.image_tag))
    error_message = "image_tag must be a valid container image tag."
  }
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

variable "ai_enabled" {
  description = <<-EOT
    Whether the platform calls OpenAI.

    False is a supported state rather than a degraded one: intake falls back to the manual
    structured form and matching uses the deterministic top-ranked eligible candidate
    (CLAUDE.md §22, Journey E). True requires a real key in the `apron/openai-api-key`
    secret and makes the four model names below load-bearing — the process refuses to
    start without them.

    **The key itself is not a Terraform variable.** It is written to Secrets Manager
    directly, so it never passes through a plan, an apply log, or the state file — which
    is not encrypted client-side and is read by anyone who can read the state bucket.
    Terraform creates the secret with a placeholder and never looks at the value again.

      aws secretsmanager put-secret-value --secret-id apron/openai-api-key \
        --secret-string "sk-..."
      terraform apply -var="ai_enabled=true"
  EOT
  type        = bool
  default     = false
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

variable "github_owner" {
  description = "The account name on its own, for the immutable OIDC subject."
  type        = string
  default     = "hafizmahad"
}

variable "github_repository_name" {
  description = "The repository name on its own, for the immutable OIDC subject."
  type        = string
  default     = "Apron"
}

variable "github_owner_id" {
  description = <<-EOT
    GitHub's numeric account id. Part of the immutable OIDC subject claim, which is what
    GitHub actually issues:

      repo:hafizmahad@132822998/Apron@1371862777:ref:refs/heads/main

    Read it with: gh api repos/<owner>/<repo> --jq .owner.id
  EOT
  type        = number
  default     = 132822998
}

variable "github_repository_id" {
  description = <<-EOT
    GitHub's numeric repository id. See `github_owner_id`.

    Read it with: gh api repos/<owner>/<repo> --jq .id
  EOT
  type        = number
  default     = 1371862777
}

variable "github_deploy_branch" {
  description = "The only branch allowed to assume the deploy role."
  type        = string
  default     = "main"
}
