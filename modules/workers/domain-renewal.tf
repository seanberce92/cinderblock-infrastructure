# ---------------------------------------------------------------------------
# domain-renewal Lambda — daily EventBridge sweep that decides *when* a site's
# domain-renewal reminder/charge is due and calls into the backend to decide
# *what* to do about it (render + send the branded email, attempt the Stripe
# charge). This Lambda holds no Stripe write access and no SES permissions —
# it only reads Route 53/DynamoDB and calls a shared-secret-authenticated
# backend endpoint, so the full-write STRIPE_SECRET_KEY stays backend-only.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "domain_renewal" {
  name               = "cinderblock-domain-renewal-role-${local.env}"
  assume_role_policy = local.lambda_assume_role
}

resource "aws_iam_role_policy" "domain_renewal" {
  name = "cinderblock-domain-renewal-policy-${local.env}"
  role = aws_iam_role.domain_renewal.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cinderblock-domain-renewal-${local.env}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:UpdateItem"]
        Resource = [var.sites_table_arn]
      },
      {
        # Route 53 Domains actions do not support resource-level scoping
        # (same as provisioner.tf / the backend's route53.service.ts).
        Effect   = "Allow"
        Action   = ["route53domains:GetDomainDetail", "route53domains:ListDomains"]
        Resource = ["*"]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
      }
    ]
  })
}

resource "aws_lambda_function" "domain_renewal" {
  function_name    = "cinderblock-domain-renewal-${local.env}"
  filename         = var.lambda_domain_renewal_zip_path
  source_code_hash = filebase64sha256(var.lambda_domain_renewal_zip_path)
  role             = aws_iam_role.domain_renewal.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      ENV                  = local.env
      SITES_TABLE          = var.sites_table_name
      HEADS_UP_DAYS        = var.domain_renewal_heads_up_days
      CHARGE_ATTEMPT_DAYS  = var.domain_renewal_charge_attempt_days
      BACKEND_INTERNAL_URL = var.backend_internal_url
      INTERNAL_API_SECRET  = var.internal_api_secret
    }
  }
}

resource "aws_cloudwatch_event_rule" "domain_renewal" {
  name                = "cinderblock-domain-renewal-${local.env}"
  description         = "Triggers the Cinderblock domain-renewal reminder/charge Lambda"
  schedule_expression = var.domain_renewal_schedule_expression
}

resource "aws_cloudwatch_event_target" "domain_renewal" {
  rule      = aws_cloudwatch_event_rule.domain_renewal.name
  target_id = "cinderblock-domain-renewal-${local.env}"
  arn       = aws_lambda_function.domain_renewal.arn
}

resource "aws_lambda_permission" "domain_renewal_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.domain_renewal.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.domain_renewal.arn
}
