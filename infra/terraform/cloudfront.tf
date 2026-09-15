/**
 * CloudFront.
 *
 * Here for one reason: TLS. With `APP_ENV=production` the session cookie is issued
 * `Secure`, and a browser will not store a `Secure` cookie over plain HTTP — so over a
 * bare ALB link the site loads, the password is accepted, the server creates a real
 * session, and the browser throws the cookie away. Back to the login page, no error,
 * nothing in the logs. CloudFront's own certificate on its own domain makes the link
 * shareable without owning a domain (docs/INFRASTRUCTURE_PLAN.md §2).
 *
 * The distribution is a TLS terminator and an asset cache, not a page cache. Every
 * portal is authenticated and every page is per-user, so caching HTML would serve one
 * operator's request list to another. The default behaviour therefore caches nothing and
 * forwards everything; only the two immutable asset paths are cached.
 */

# Managed policies, resolved by name rather than by pasted id.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Forwards every header, cookie and query string, Host included.
#
# Host included is the whole point, and it took a broken sign-in to learn why. Next
# verifies a Server Action by comparing the request's Origin against its Host, and every
# mutation in this product is a Server Action — including the login form. With
# `AllViewerExceptHostHeader` the origin saw `Host: apron-alb-….elb.amazonaws.com` while
# the browser sent `Origin: https://d1ciksvorhzrk8.cloudfront.net`, so every action was
# rejected: pages rendered, the login form submitted, and the response was a 500 with no
# cookie set. Nobody could sign in.
#
# The ALB does not route on Host — the listener matches only the secret header — so
# forwarding the viewer's Host costs nothing there and gives the application the name the
# user actually typed, which is what it should have been seeing all along.
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

locals {
  alb_origin_id = "${var.name}-alb"
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "Apron Production"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  # Includes the South Asian and Middle Eastern edges as well as North America and
  # Europe. PriceClass_100 would still serve everywhere, just from further away.
  price_class = "PriceClass_200"

  origin {
    domain_name = aws_lb.main.dns_name
    origin_id   = local.alb_origin_id

    custom_origin_config {
      http_port  = 80
      https_port = 443
      # Plain HTTP to the origin because the ALB has no certificate and cannot have one
      # for an amazonaws.com name. The hop is protected by the security group, which
      # admits only CloudFront's prefix list, and by the secret header below.
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_keepalive_timeout = 30
      origin_read_timeout      = 30
    }

    # CloudFront overwrites this header on the way through, so a viewer cannot forge it.
    # The ALB listener forwards only requests carrying it and answers everything else 403.
    custom_header {
      name  = "X-Apron-Origin"
      value = random_password.origin_secret.result
    }
  }

  # --- the application ------------------------------------------------------
  default_cache_behavior {
    target_origin_id       = local.alb_origin_id
    viewer_protocol_policy = "redirect-to-https"

    # POST and the rest are required: every mutation in the product is a server action,
    # which is a POST to the same path as the page.
    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id

    compress = true
  }

  # --- build output ---------------------------------------------------------
  # Next fingerprints these filenames with a content hash, so a given URL's bytes never
  # change and caching them at the edge is free correctness.
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = local.alb_origin_id
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id = data.aws_cloudfront_cache_policy.caching_optimized.id
    compress        = true
  }

  # --- the asset pack -------------------------------------------------------
  # Brand marks, service imagery, icons. Not fingerprinted, but replaced rarely, and an
  # invalidation covers the case where one is.
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = local.alb_origin_id
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id = data.aws_cloudfront_cache_policy.caching_optimized.id
    compress        = true
  }

  restrictions {
    geo_restriction {
      # Open. Whoever is sent the link can open it; what they reach is a login page, and
      # every route behind it is authorised server-side (verify:rbac proves that from
      # outside the process).
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # CloudFront's own certificate for its own *.cloudfront.net name. Adding a custom
    # domain later means an ACM certificate in us-east-1, an `aliases` entry, and this
    # block gaining `acm_certificate_arn` — the `us_east_1` provider alias in versions.tf
    # is already declared for exactly that.
    cloudfront_default_certificate = true

    # No `minimum_protocol_version` here. It applies only to a custom certificate; with
    # the default one CloudFront fixes the policy itself and reports back "TLSv1"
    # regardless of what is asked for, so setting it produces a diff on every single plan
    # and changes nothing. A plan that is never empty is a plan people stop reading.
  }

  tags = { Name = "${var.name}-cdn" }
}
