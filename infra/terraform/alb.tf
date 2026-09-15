/**
 * The load balancer.
 *
 * It listens on plain HTTP, which is correct here and only here: TLS is terminated at
 * CloudFront, and an ALB cannot hold a public certificate for its own amazonaws.com name
 * because no certificate authority will issue one. Two things keep that from being an
 * open door:
 *
 *  1. the security group admits only CloudFront's origin-facing prefix list, and
 *  2. the listener forwards a request only when it carries a shared secret header that
 *     CloudFront adds and a viewer cannot set — CloudFront overwrites it on the way
 *     through, so a client sending its own is ignored.
 *
 * Anything without that header gets 403 from the balancer, never the application.
 */

resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

resource "aws_lb" "main" {
  name               = "${var.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # A signed-in operator loading a request detail should not be cut off mid-response.
  idle_timeout = 60

  # Protects against removing the balancer while it is the only route to the product.
  enable_deletion_protection = true

  drop_invalid_header_fields = true

  tags = { Name = "${var.name}-alb" }
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # The real probe, not a static 200. /api/health returns 503 when Postgres or Redis is
  # degraded, so an instance that cannot serve is taken out of rotation rather than being
  # sent traffic it will fail (DEPLOYMENT_HANDOFF §4).
  health_check {
    enabled             = true
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight response to finish, short enough that a deployment is not
  # slowed by draining.
  deregistration_delay = 30

  # No stickiness: every portal reads its session from a cookie resolved against the
  # database, so any task can serve any request. Pinning a user to one task would only
  # make a deployment more visible to them.
  stickiness {
    type    = "lb_cookie"
    enabled = false
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.name}-web" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # The default action is refusal. Only the rule below, matching the shared secret, sends
  # anything to the application — so a request that reached the balancer some other way
  # gets a flat 403 and touches nothing.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Direct access is not permitted."
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  condition {
    http_header {
      http_header_name = "X-Apron-Origin"
      values           = [random_password.origin_secret.result]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
