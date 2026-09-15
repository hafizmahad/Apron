/**
 * The state bucket.
 *
 * Applied once, before anything else, and keeps its state in a local file committed
 * nowhere — something has to exist before a remote backend can point at it. Everything
 * it creates is inert: a bucket and its settings, no compute, no cost beyond storage.
 *
 *   cd infra/terraform/bootstrap
 *   terraform init
 *   terraform apply
 *
 * After this, `infra/terraform` can `terraform init` against the backend in versions.tf.
 *
 * There is no DynamoDB table. Terraform 1.10 locks S3 state natively with a `.tflock`
 * object beside the state file, and one environment does not need a second service to
 * hold a lock.
 */

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "apron"
      ManagedBy = "terraform"
      Purpose   = "tfstate"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-2"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "apron-terraform-state-${data.aws_caller_identity.current.account_id}"

  # State describes every resource in the account and holds the database password. Losing
  # it means adopting live infrastructure back into Terraform by hand.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning is the recovery path for a corrupted or truncated state write.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Old state versions are worth keeping long enough to recover from a bad apply, not
# forever.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

output "state_bucket" {
  description = "Put this in the backend block of infra/terraform/versions.tf."
  value       = aws_s3_bucket.state.bucket
}
