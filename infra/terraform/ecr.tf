/**
 * Image registries.
 *
 * Two repositories rather than one with two tag prefixes, so a lifecycle policy can age
 * them independently and so `apron/worker` reads as what it is in the console.
 */

locals {
  ecr_repositories = toset(["web", "worker"])
}

resource "aws_ecr_repository" "app" {
  for_each = local.ecr_repositories

  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  # Tags are commit SHAs, so a tag must never move. IMMUTABLE makes "which code is
  # running" answerable from the tag alone — the single most useful property during an
  # incident.
  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${var.name}-${each.key}" }
}

# Twenty images is roughly a month of deployments, which is further back than anyone
# rolls. Untagged images are build layers nothing references.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each = aws_ecr_repository.app

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last 20 tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 20
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
    ]
  })
}
