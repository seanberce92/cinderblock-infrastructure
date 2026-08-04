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
    allowed_origins = [var.cors_origin]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
