/**
 * The cluster, the task definitions, and the two services.
 *
 * `web` and `worker` are two entrypoints of one image (ADR-001), so they share
 * everything but their command and their placement. A third task definition exists for
 * the one-off migration and seed runs, which use the worker image with an overridden
 * command; it is registered here so that running one is `aws ecs run-task` with a task
 * definition that already exists, rather than an ad-hoc definition assembled by hand at
 * the moment it is needed.
 */

locals {
  ai_enabled = var.openai_api_key != ""

  web_image    = "${aws_ecr_repository.app["web"].repository_url}:${var.image_tag}"
  worker_image = "${aws_ecr_repository.app["worker"].repository_url}:${var.image_tag}"

  # The public origin. Absolute links in notifications and generated documents are built
  # from this, so it has to be what a person actually opens — the CloudFront domain, not
  # the load balancer's.
  app_url = "https://${aws_cloudfront_distribution.main.domain_name}"

  # Shared by every task. `src/lib/config/env.ts` validates all of it at boot and refuses
  # to start on a bad value, which is why this list is written from that schema.
  base_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "APP_ENV", value = "production" },
    { name = "APP_URL", value = local.app_url },
    { name = "PORT", value = "3000" },

    { name = "REDIS_URL", value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:${aws_elasticache_cluster.main.cache_nodes[0].port}" },
    { name = "DATABASE_SSL", value = "true" },
    { name = "DATABASE_POOL_MAX", value = "10" },

    { name = "QUEUE_ENABLED", value = "true" },
    { name = "WORKER_CONCURRENCY", value = "4" },
    { name = "RATE_LIMIT_ENABLED", value = "true" },

    # ADR-020: nothing is sent. The adapter records what would have been, and the
    # notification row, the notifications centre and the request timeline are where a
    # person actually learns of it.
    { name = "MAIL_TRANSPORT", value = "log" },
    { name = "MAIL_FROM", value = "Apron Operations <ops@apron.local>" },
    { name = "SMS_ENABLED", value = "false" },

    { name = "DOCUMENT_STORAGE_DRIVER", value = "s3" },
    { name = "S3_BUCKET", value = aws_s3_bucket.documents.bucket },
    { name = "S3_REGION", value = var.region },

    { name = "LOG_LEVEL", value = "info" },
    # LOG_PRETTY is deliberately absent. pino-pretty is a devDependency and is not in the
    # image; setting it produces a warning on every boot and JSON anyway.

    { name = "AI_ENABLED", value = local.ai_enabled ? "true" : "false" },
    { name = "AI_STORE_PROMPT_BODIES", value = "false" },
    { name = "NEXT_PUBLIC_MAP_PROVIDER", value = "static" },
  ]

  ai_environment = local.ai_enabled ? [
    { name = "OPENAI_INTAKE_MODEL", value = var.openai_intake_model },
    { name = "OPENAI_REASONING_MODEL", value = var.openai_reasoning_model },
    { name = "OPENAI_RESEARCH_MODEL", value = var.openai_research_model },
    { name = "OPENAI_SUMMARY_MODEL", value = var.openai_summary_model },
  ] : []

  environment = concat(local.base_environment, local.ai_environment)

  base_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session_secret.arn },
  ]

  secrets = concat(
    local.base_secrets,
    local.ai_enabled ? [{ name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.openai_api_key.arn }] : [],
  )
}

resource "aws_ecs_cluster" "main" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${var.name}-cluster" }
}

# --- logs ------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}-web"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name}-worker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "tasks" {
  name              = "/ecs/${var.name}-tasks"
  retention_in_days = var.log_retention_days
}

# --- web -------------------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = local.web_image
      essential = true

      portMappings = [{ containerPort = 3000, protocol = "tcp" }]

      # HOSTNAME is set here and not left to the Dockerfile, because ECS injects its own
      # into the container environment and that wins. Next reads it as the address to
      # bind, so the server came up listening on the task's ENI address alone —
      # `Local: http://ip-10-20-59-250.us-east-2.compute.internal:3000` in the logs.
      #
      # The failure that caused is nasty precisely because the product looked fine. The
      # load balancer reaches the task by that same ENI address, so its health check
      # passed, traffic flowed and every page worked. The *container* health check goes to
      # 127.0.0.1, which nothing was listening on, so ECS marked every task UNHEALTHY and
      # killed it a few minutes in — replacing tasks forever, on a service that appeared
      # to be serving perfectly.
      environment = concat(local.environment, [{ name = "HOSTNAME", value = "0.0.0.0" }])
      secrets     = local.secrets

      # The same probe the load balancer uses, so a task that cannot reach Postgres or
      # Redis is replaced rather than sitting in the cluster answering 503.
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:3000/api/health || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 5
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "web"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  # Long enough for migrations to have been applied and the app to boot before the
  # balancer starts failing it.
  health_check_grace_period_seconds = 60

  # A deployment that fails rolls back on its own rather than leaving the service in a
  # half-updated state waiting for someone to notice.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  # The pipeline registers a new task definition on each deploy, so Terraform must not
  # drag the service back to the revision it last knew about.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.http]

  tags = { Name = "${var.name}-web" }
}

# --- worker ----------------------------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name        = "worker"
      image       = local.worker_image
      essential   = true
      environment = local.environment
      secrets     = local.secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  # One worker at a time. 100/0 stops the old task before starting the new one, which is
  # a few seconds of no worker rather than two workers briefly racing the same queue.
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = { Name = "${var.name}-worker" }
}

# --- migrations and seed ---------------------------------------------------

# Registered, never run as a service. `aws ecs run-task` overrides the command with
# `node dist-worker/migrate.js` or `node dist-worker/seed.js`; both entrypoints are in the
# worker image. SEED_PASSWORD is attached here and nowhere else — web and worker have no
# reason to hold it.
resource "aws_ecs_task_definition" "admin" {
  family                   = "${var.name}-admin"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name        = "admin"
      image       = local.worker_image
      essential   = true
      command     = ["node", "dist-worker/migrate.js"]
      environment = local.environment
      secrets = concat(local.secrets, [
        { name = "SEED_PASSWORD", valueFrom = aws_secretsmanager_secret.seed_password.arn },
      ])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.tasks.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "admin"
        }
      }
    }
  ])
}
