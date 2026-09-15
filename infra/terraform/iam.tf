/**
 * Identities.
 *
 * Three of them, deliberately separate:
 *
 *  - the **execution role** is what ECS itself uses to start a task: pull the image,
 *    resolve the secrets, open the log stream. The application never holds it.
 *  - the **task role** is what the running application uses. Its only permission is the
 *    document bucket.
 *  - the **deploy role** is what GitHub Actions assumes through OIDC. No long-lived
 *    access key exists anywhere.
 */

# --- ECS execution ---------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Named secrets, not a wildcard. The execution role reads exactly the four this stack
# defines and nothing else that may later live under the same prefix.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid     = "ReadTaskSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.session_secret.arn,
      aws_secretsmanager_secret.seed_password.arn,
      aws_secretsmanager_secret.openai_api_key.arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name}-read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# --- the running application ----------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# The application reads and writes documents. It does not list buckets, does not touch
# any other bucket, and cannot delete the bucket itself.
data "aws_iam_policy_document" "task_documents" {
  statement {
    sid       = "ObjectAccess"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]
  }

  statement {
    sid       = "ListOwnBucketOnly"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.documents.arn]
  }
}

resource "aws_iam_role_policy" "task_documents" {
  name   = "${var.name}-documents"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_documents.json
}

# --- GitHub Actions --------------------------------------------------------

# One OIDC provider for the account. GitHub's tokens are verified against it, so no AWS
# access key ever has to exist in a GitHub secret.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# Scoped to one repository and one branch. A fork, a pull request from a fork, or any
# other branch produces a token whose `sub` does not match and cannot assume this role.
data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Two exact subjects, not a wildcard.
    #
    # GitHub now issues the immutable form, which carries the numeric owner and repository
    # ids alongside the names:
    #
    #   repo:hafizmahad@132822998/Apron@1371862777:ref:refs/heads/main
    #
    # The names in it are a convenience; the ids are the identity, and they survive the
    # repository or the account being renamed — which is the whole reason GitHub added
    # them, and the reason this is the better thing to trust.
    #
    # The legacy name-only form is listed as well because GitHub has issued both and a
    # deployment should not stop because a claim format was rolled forward or back.
    # StringEquals over a list is an OR of exact matches, so neither entry widens the
    # other: a different repository, a different account or a different branch matches
    # nothing here.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repository}:ref:refs/heads/${var.github_deploy_branch}",
        "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repository_name}@${var.github_repository_id}:ref:refs/heads/${var.github_deploy_branch}",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${var.name}-github-deploy"
  description          = "Assumed by GitHub Actions on ${var.github_repository}@${var.github_deploy_branch}."
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [for repo in aws_ecr_repository.app : repo.arn]
  }

  statement {
    sid = "DeployServices"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTasks",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
      "ecs:UpdateService",
      "ecs:RunTask",
    ]
    resources = ["*"]
  }

  # The pipeline looks the subnets and the security group up by tag rather than being
  # handed their ids, so that renumbering the network does not mean editing a workflow.
  # EC2 Describe calls do not support resource-level permissions, hence "*"; they are
  # read-only and reveal nothing the account's own tags do not.
  statement {
    sid       = "FindTheNetwork"
    actions   = ["ec2:DescribeSubnets", "ec2:DescribeSecurityGroups"]
    resources = ["*"]
  }

  # A one-off task's report is in its log stream, and a verification that failed is
  # exactly when someone needs to read it without opening the console.
  statement {
    sid = "ReadTaskLogs"
    actions = [
      "logs:GetLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.tasks.arn}:*"]
  }

  # RegisterTaskDefinition and RunTask both hand a role to ECS, which needs explicit
  # permission to pass it. Narrowed to the two roles this stack defines, so the deploy
  # role cannot attach a more privileged one to a task it starts.
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${var.name}-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
