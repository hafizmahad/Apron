/**
 * The data tier: PostgreSQL, Redis, and the document bucket.
 *
 * All three are private. None has a public endpoint, and none is reachable from outside
 * the VPC at all.
 */

# --- PostgreSQL ------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "${var.name}-db"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${var.name}-db" }
}

# `logical_replication` is off and `force_ssl` on. The application sets DATABASE_SSL=true
# and the driver verifies, so a connection that somehow arrived unencrypted is refused by
# the server rather than quietly accepted.
resource "aws_db_parameter_group" "main" {
  name_prefix = "${var.name}-pg16-"
  family      = "postgres16"

  # `apply_method` is explicit because this one is static: it cannot take effect until the
  # instance reboots, and leaving it to the provider's "immediate" default makes every
  # future plan show a change that is not one.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Slow queries are the first thing anyone asks for when a page feels wrong. Dynamic, so
  # it applies without waiting for anything.
  parameter {
    name         = "log_min_duration_statement"
    value        = "1000"
    apply_method = "immediate"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "random_password" "database" {
  length = 40
  # RDS rejects '/', '@', '"' and space in a master password, and the value is embedded in
  # a URL, so the set is narrowed further to what survives one without escaping.
  override_special = "-_.~"
  special          = true
}

resource "aws_db_instance" "main" {
  identifier = "${var.name}-postgres"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "apron"
  username = "apron"
  password = random_password.database.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  # Single-AZ is deliberate for one environment: Multi-AZ doubles the largest line on the
  # bill. Backups plus the documented restore in docs/OPERATIONS.md are the recovery
  # story. Deletion protection is on because the alternative is a typo costing the data.
  multi_az                  = false
  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "06:00-07:00"
  maintenance_window        = "sun:07:30-sun:08:30"
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-postgres-final"

  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  performance_insights_enabled = true
  # Seven days is the free tier for Performance Insights; longer is billed.
  performance_insights_retention_period = 7

  tags = { Name = "${var.name}-postgres" }
}

# --- Redis -----------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name}-redis"
  subnet_ids = aws_subnet.private[*].id
}

# BullMQ needs keys to survive memory pressure rather than be evicted mid-job, so the
# policy is noeviction: a full Redis should fail loudly, not silently drop a queued
# acknowledgement timeout.
#
# A fixed name, unlike the RDS group above: ElastiCache has no `name_prefix`, and these
# parameters apply in place rather than needing the group replaced.
resource "aws_elasticache_parameter_group" "main" {
  name   = "${var.name}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

# A single node. Losing it loses in-flight jobs, which are idempotent and retry; the
# durable state is all in PostgreSQL. Replication would protect a queue whose contents are
# reconstructible, at the price of another node.
resource "aws_elasticache_cluster" "main" {
  cluster_id = "${var.name}-redis"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.main.name

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  snapshot_retention_limit = 1
  maintenance_window       = "sun:08:30-sun:09:30"

  tags = { Name = "${var.name}-redis" }
}

# --- documents -------------------------------------------------------------

resource "aws_s3_bucket" "documents" {
  bucket = "${var.name}-documents-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "${var.name}-documents" }
}

# These hold client manifests and provider work orders. Nothing about them is public, and
# the route that serves them decides access from the document record rather than from
# possession of a URL — so the bucket itself is never a distribution channel.
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# A regenerated document overwrites its predecessor. Versioning means the one that was
# sent to a client is still retrievable after it was replaced.
resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.documents]
}
