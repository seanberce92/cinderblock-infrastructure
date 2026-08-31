# ---------------------------------------------------------------------------
# cinderblock-uploads — private bucket for user-submitted images/logos.
# The browser PUTs directly here via presigned URLs from the API; the
# site-builder Lambda reads from here when assembling a preview.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "uploads" {
  bucket = "cinderblock-uploads-${var.common_labels.env}"

  tags = {
    Name = "cinderblock-uploads-${var.common_labels.env}"
  }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "GET"]
    # var.cors_origin is the deployed frontend (qa.cinderblock.site). This
    # bucket is also shared by every developer's personal `sst dev` stage
    # (see cinderblock-backend/sst.config.ts UPLOADS_BUCKET fallback), whose
    # browser origin is always localhost:5173 — hardcoded here rather than
    # threaded through as another variable since it never varies per env.
    allowed_origins = [var.cors_origin, "http://localhost:5173"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# ---------------------------------------------------------------------------
# cinderblock-email-assets — public-read bucket for static assets referenced
# by branded HTML emails (the white logo PNG, etc). Email clients fetch
# images over plain HTTPS with no auth, so this is a plain public bucket URL
# rather than a signed/private one — no CloudFront/ACM/custom domain for this
# pass (see plan's explicit non-goals). Objects are uploaded manually (there's
# no build pipeline for a handful of static images).
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "email_assets" {
  bucket = "cinderblock-email-assets-${var.common_labels.env}"

  tags = {
    Name = "cinderblock-email-assets-${var.common_labels.env}"
  }
}

resource "aws_s3_bucket_public_access_block" "email_assets" {
  bucket = aws_s3_bucket.email_assets.id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "email_assets_public_read" {
  bucket = aws_s3_bucket.email_assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadOnly"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.email_assets.arn}/*"
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.email_assets]
}
