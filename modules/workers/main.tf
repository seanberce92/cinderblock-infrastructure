data "aws_caller_identity" "current" {}

locals {
  env        = var.common_labels.env
  region     = var.common_labels.aws_region
  account_id = data.aws_caller_identity.current.account_id

  # Preview buckets are created dynamically by the site-builder Lambda:
  #   cinderblock-preview-{siteId}-{env}
  preview_bucket_arns = [
    "arn:aws:s3:::cinderblock-preview-*-${local.env}",
    "arn:aws:s3:::cinderblock-preview-*-${local.env}/*",
  ]

  # Sandbox buckets — same pattern, used to revise an already-live site
  # without touching its production preview bucket. Created dynamically by
  # the site-builder Lambda: cinderblock-sandbox-{siteId}-{env}.
  sandbox_bucket_arns = [
    "arn:aws:s3:::cinderblock-sandbox-*-${local.env}",
    "arn:aws:s3:::cinderblock-sandbox-*-${local.env}/*",
  ]

  lambda_assume_role = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}
