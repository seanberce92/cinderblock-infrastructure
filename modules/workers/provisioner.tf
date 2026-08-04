# ---------------------------------------------------------------------------
# provisioner Lambda — Step Functions task handler for post-payment provisioning
# (domain registration, ACM cert, CloudFront distribution, bucket lockdown).
# ---------------------------------------------------------------------------
resource "aws_iam_role" "provisioner" {
  name               = "cinderblock-provisioner-role-${local.env}"
  assume_role_policy = local.lambda_assume_role
}

resource "aws_iam_role_policy" "provisioner" {
  name = "cinderblock-provisioner-policy-${local.env}"
  role = aws_iam_role.provisioner.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cinderblock-provisioner-${local.env}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = [var.sites_table_arn]
      },
      {
        # Domain registration + operation polling. These actions do not support
        # resource-level scoping.
        Effect = "Allow"
        Action = [
          "route53domains:RegisterDomain",
          "route53domains:GetOperationDetail",
          "route53domains:GetDomainDetail"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = [
          "route53:ListHostedZonesByName",
          "route53:CreateHostedZone",
          "route53:GetHostedZone",
          "route53:ChangeResourceRecordSets",
          "route53:GetChange"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = [
          "acm:RequestCertificate",
          "acm:DescribeCertificate"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateOriginAccessControl",
          "cloudfront:CreateDistribution",
          "cloudfront:GetDistribution",
          "cloudfront:CreateInvalidation"
        ]
        Resource = ["*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutBucketPublicAccessBlock", "s3:PutBucketPolicy"]
        Resource = concat(local.preview_bucket_arns, local.sandbox_bucket_arns)
      },
      {
        # Download the site's stored Astro source (buildSite step) and
        # upload the freshly built dist/ output back. Also covers
        # publishSandbox mirroring a sandbox bucket onto the live preview
        # bucket, which additionally needs DeleteObject to drop stale keys.
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = concat(local.preview_bucket_arns, local.sandbox_bucket_arns)
      }
    ]
  })
}

resource "aws_lambda_function" "provisioner" {
  function_name    = "cinderblock-provisioner-${local.env}"
  filename         = var.lambda_provisioner_zip_path
  source_code_hash = filebase64sha256(var.lambda_provisioner_zip_path)
  role             = aws_iam_role.provisioner.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  # The buildSite step runs a real `npm install && npm run build` in /tmp
  # (same as site-builder), so this needs the same headroom.
  timeout     = 900
  memory_size = 2048

  ephemeral_storage {
    size = 2048 # node_modules + npm cache + the built dist/ output
  }

  environment {
    variables = {
      ENV         = local.env
      SITES_TABLE = var.sites_table_name
    }
  }
}
