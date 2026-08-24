# ---------------------------------------------------------------------------
# cinderblock-placeholder — public-read bucket holding a single static,
# Cinderblock-branded HTML page, used as a second CloudFront origin on every
# site's distribution (see the provisioner Lambda's createDistribution /
# switchToPlaceholderOrigin). Shown in place of the customer's real site while
# a domain's DNS/distribution exist but the site isn't live (subscription
# ended, or a provisioning failure after DNS was already wired). Public for
# the same reason as cinderblock-email-assets: content is non-sensitive
# branding, so a plain public bucket policy is simpler than an OAC grant that
# would need a statement per site distribution.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "placeholder" {
  bucket = "cinderblock-placeholder-${var.common_labels.env}"

  tags = {
    Name = "cinderblock-placeholder-${var.common_labels.env}"
  }
}

resource "aws_s3_bucket_public_access_block" "placeholder" {
  bucket = aws_s3_bucket.placeholder.id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "placeholder_public_read" {
  bucket = aws_s3_bucket.placeholder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadOnly"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.placeholder.arn}/*"
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.placeholder]
}

# Key matches DefaultRootObject ("dist/index.html") on every site distribution,
# so the distributions' existing 403->200 CustomErrorResponses fallback serves
# this page correctly with no per-distribution config needed.
resource "aws_s3_object" "placeholder_index" {
  bucket       = aws_s3_bucket.placeholder.id
  key          = "dist/index.html"
  content      = templatefile("${path.module}/placeholder-site/index.html.tftpl", { app_url = var.cors_origin })
  content_type = "text/html; charset=utf-8"
  etag         = md5(templatefile("${path.module}/placeholder-site/index.html.tftpl", { app_url = var.cors_origin }))
}
