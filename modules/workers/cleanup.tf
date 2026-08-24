# ---------------------------------------------------------------------------
# cleanup Lambda — hourly EventBridge sweep of abandoned (unpaid) preview buckets.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "cleanup" {
  name               = "cinderblock-cleanup-role-${local.env}"
  assume_role_policy = local.lambda_assume_role
}

resource "aws_iam_role_policy" "cleanup" {
  name = "cinderblock-cleanup-policy-${local.env}"
  role = aws_iam_role.cleanup.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cinderblock-cleanup-${local.env}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:UpdateItem"]
        Resource = [var.sites_table_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:DeleteObject", "s3:DeleteBucket"]
        Resource = local.preview_bucket_arns
      }
    ]
  })
}

resource "aws_lambda_function" "cleanup" {
  function_name    = "cinderblock-cleanup-${local.env}"
  filename         = var.lambda_cleanup_zip_path
  source_code_hash = filebase64sha256(var.lambda_cleanup_zip_path)
  role             = aws_iam_role.cleanup.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      ENV                      = local.env
      SITES_TABLE              = var.sites_table_name
      BACKEND_INTERNAL_URL     = var.backend_internal_url
      INTERNAL_API_SECRET      = var.internal_api_secret
      PREVIEW_HEADS_UP_MINUTES = var.preview_heads_up_minutes
    }
  }
}

resource "aws_cloudwatch_event_rule" "cleanup" {
  name                = "cinderblock-cleanup-${local.env}"
  description         = "Triggers the Cinderblock abandoned-preview cleanup Lambda"
  schedule_expression = var.cleanup_schedule_expression
}

resource "aws_cloudwatch_event_target" "cleanup" {
  rule      = aws_cloudwatch_event_rule.cleanup.name
  target_id = "cinderblock-cleanup-${local.env}"
  arn       = aws_lambda_function.cleanup.arn
}

resource "aws_lambda_permission" "cleanup_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cleanup.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cleanup.arn
}
