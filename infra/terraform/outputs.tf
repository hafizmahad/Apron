output "app_url" {
  description = "The public address. This is the link to send someone."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "For invalidating /assets/* after replacing an image."
  value       = aws_cloudfront_distribution.main.id
}

output "alb_dns_name" {
  description = <<-EOT
    The origin. Opening it directly returns 403 by design — the listener forwards only
    requests carrying the secret header CloudFront adds, and the security group admits
    only CloudFront. Useful for reading target health, not for reaching the product.
  EOT
  value       = aws_lb.main.dns_name
}

output "ecr_web_repository_url" {
  value = aws_ecr_repository.app["web"].repository_url
}

output "ecr_worker_repository_url" {
  value = aws_ecr_repository.app["worker"].repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_web_service_name" {
  value = aws_ecs_service.web.name
}

output "ecs_worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "admin_task_definition" {
  description = "Run migrations and the seed by overriding this task definition's command."
  value       = aws_ecs_task_definition.admin.family
}

output "private_subnet_ids" {
  description = "Needed by `aws ecs run-task` for the migration and seed runs."
  value       = aws_subnet.private[*].id
}

output "tasks_security_group_id" {
  description = "Needed by `aws ecs run-task` for the migration and seed runs."
  value       = aws_security_group.tasks.id
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE variable in the GitHub repository."
  value       = aws_iam_role.github_deploy.arn
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "database_endpoint" {
  description = "Private. Reachable only from the tasks security group."
  value       = aws_db_instance.main.address
}

output "seed_password_secret" {
  description = <<-EOT
    Where the password every seeded account signs in with lives. Read it with:

      aws secretsmanager get-secret-value --secret-id apron/seed-password \
        --query SecretString --output text

    Replacing the value in the console is expected and will not be reverted; the seed
    only refuses to run while the *published* development password is still in use.
  EOT
  value       = aws_secretsmanager_secret.seed_password.name
}
