/**
 * Security groups.
 *
 * Each tier accepts traffic only from the security group in front of it, referenced by id
 * rather than by CIDR. A rule written as a CIDR keeps working when something else is put
 * on that address range; a rule written as a group identity does not.
 *
 * The chain is: CloudFront -> ALB -> web tasks -> data. The worker has no inbound rule at
 * all — nothing ever connects *to* it.
 */

# CloudFront's origin-facing addresses, maintained by AWS. Hard-coding CloudFront's ranges
# would mean tracking a list that changes; this is the list, and it updates itself.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# --- load balancer ---------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public entry point. Reachable only from CloudFront."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-alb" }
}

# The ALB is internet-facing because CloudFront reaches it over the internet, but it is
# not open to the internet: only CloudFront's own addresses may connect. Combined with the
# shared secret header the listener checks (see alb.tf), someone who discovers the ALB's
# DNS name can neither connect to it nor bypass CloudFront if they could.
resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from CloudFront edge locations only"

  prefix_list_id = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
  ip_protocol    = "tcp"
  from_port      = 80
  to_port        = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id = aws_security_group.alb.id
  description       = "To the web tasks"

  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

# --- ECS tasks -------------------------------------------------------------

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "web and worker. Inbound from the ALB only; the worker receives none."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id = aws_security_group.tasks.id
  description       = "Application traffic from the load balancer"

  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

# Outbound is open: tasks pull images from ECR, read Secrets Manager, write CloudWatch,
# reach S3 through the gateway endpoint, and — when AI is enabled — call the OpenAI API,
# whose addresses are not a fixed range anyone should pretend to enumerate.
resource "aws_vpc_security_group_egress_rule" "tasks_egress" {
  security_group_id = aws_security_group.tasks.id
  description       = "All outbound"

  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "-1"
}

# --- data tier -------------------------------------------------------------

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "PostgreSQL. Reachable only from the tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-database" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id = aws_security_group.database.id
  description       = "PostgreSQL from web, worker, and the migration and seed tasks"

  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis. Reachable only from the tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name}-redis" }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  security_group_id = aws_security_group.redis.id
  description       = "Redis from web and worker"

  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}
