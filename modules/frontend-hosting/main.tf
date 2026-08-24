# ---------------------------------------------------------------------------
# Static hosting for the Cinderblock frontend SPA: a private S3 bucket
# fronted by CloudFront via Origin Access Control (OAC), serving
# var.domain_name (qa.cinderblock.site). Building the SPA and syncing
# dist/ into the bucket (+ invalidating the distribution) is a separate
# deploy step, not managed here -- see cinderblock-frontend/README.md.
# ---------------------------------------------------------------------------

locals {
  env = var.common_labels.env
}

resource "aws_s3_bucket" "frontend" {
  bucket = "cinderblock-frontend-${local.env}"

  tags = {
    Name = "cinderblock-frontend-${local.env}"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "cinderblock-frontend-oac-${local.env}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  price_class         = var.price_class

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "cinderblock-frontend-s3-${local.env}"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id        = "cinderblock-frontend-s3-${local.env}"
    viewer_protocol_policy  = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    # AWS managed "CachingOptimized" policy -- fine for a static S3 origin
    # with no query strings/headers to vary the cache key on.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # SPA client-side routing: a deep link like /app/sites/123 doesn't exist as
  # an S3 object and 404s at the origin (S3 returns 403 for a missing key on
  # a bucket with no public list access) -- serve index.html instead so
  # react-router can take over client-side.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.cert_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "cinderblock-frontend-${local.env}"
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })
}
