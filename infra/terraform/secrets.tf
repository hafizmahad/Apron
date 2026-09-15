/**
 * Secrets.
 *
 * Everything here is injected into a task as an ECS `secrets` entry, which resolves at
 * container start and never appears in the task definition, in `terraform show`, or in
 * the console's environment listing.
 *
 * `recovery_window_in_days = 7` rather than 0: a deleted secret that turns out to have
 * been in use is recoverable for a week.
 */

data "aws_caller_identity" "current" {}

# --- session signing key ---------------------------------------------------

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "session_secret" {
  name                    = "${var.name}/session-secret"
  description             = "Signs session cookies. Rotating it signs every user out."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "session_secret" {
  secret_id     = aws_secretsmanager_secret.session_secret.id
  secret_string = random_password.session_secret.result
}

# --- database connection ---------------------------------------------------

# Assembled here rather than composed in the task definition, so the password exists in
# exactly one place that is not state: this secret.
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name}/database-url"
  description             = "postgres:// connection string for the RDS instance."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgres://%s:%s@%s:%d/%s",
    aws_db_instance.main.username,
    random_password.database.result,
    aws_db_instance.main.address,
    aws_db_instance.main.port,
    aws_db_instance.main.db_name,
  )
}

# --- seeded accounts -------------------------------------------------------

# One password for every seeded account, so nothing has to be rotated per user
# (CLAUDE.md §27). The seed refuses a non-local APP_ENV while the *published* development
# password is still in use; what it needs is a value of its own, which this is.
#
# Generated rather than left for the owner to place, because an empty secret means a seed
# task that cannot start, and the point of the guard is not to make deployment manual.
# `ignore_changes` means the owner can replace the value in the console — which is the
# right way to set a password a person will actually type — and Terraform will not put its
# generated one back on the next apply.
resource "random_password" "seed_password" {
  length           = 24
  override_special = "!#%*-_"
  special          = true
}

resource "aws_secretsmanager_secret" "seed_password" {
  name                    = "${var.name}/seed-password"
  description             = "The single password every seeded account signs in with."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "seed_password" {
  secret_id     = aws_secretsmanager_secret.seed_password.id
  secret_string = random_password.seed_password.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# --- OpenAI ----------------------------------------------------------------

# Created whether or not a key was supplied, so switching AI on later is a console edit
# and a service redeploy rather than a Terraform change. The task definition only
# references it when `local.ai_enabled`.
resource "aws_secretsmanager_secret" "openai_api_key" {
  name                    = "${var.name}/openai-api-key"
  description             = "Optional. With no key the platform runs with AI off (Journey E)."
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "openai_api_key" {
  secret_id = aws_secretsmanager_secret.openai_api_key.id

  # A placeholder, and only ever a placeholder. The real key is written straight to
  # Secrets Manager with `put-secret-value`, so it never passes through a plan, an apply
  # log or the state file — state is not encrypted client-side and holds every value
  # Terraform has seen. `ignore_changes` is what keeps the real key from being replaced
  # by this string on the next apply.
  #
  # An empty string is not an option: Secrets Manager will not store one, and the task
  # only reads this secret when AI is switched on.
  secret_string = "unset"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
