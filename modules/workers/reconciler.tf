# ---------------------------------------------------------------------------
# reconciler Lambda — 15-min EventBridge sweep that cross-checks Stripe
# completed checkout sessions against site status, to catch a broken
# post-payment webhook early (the site never advances past building/preview).
# Alerts via a single SNS topic + CloudWatch alarm on the StuckCheckouts
# metric it emits.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "reconciler" {
  name               = "cinderblock-reconciler-role-${local.env}"
  assume_role_policy = local.lambda_assume_role
}

resource "aws_iam_role_policy" "reconciler" {
  name = "cinderblock-reconciler-policy-${local.env}"
  role = aws_iam_role.reconciler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cinderblock-reconciler-${local.env}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = [var.sites_table_arn]
      },
      {
        # PutMetricData does not support resource-level scoping.
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
      }
    ]
  })
}

resource "aws_lambda_function" "reconciler" {
  function_name    = "cinderblock-reconciler-${local.env}"
  filename         = var.lambda_reconciler_zip_path
  source_code_hash = filebase64sha256(var.lambda_reconciler_zip_path)
  role             = aws_iam_role.reconciler.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      ENV               = local.env
      SITES_TABLE       = var.sites_table_name
      STRIPE_SECRET_KEY = var.stripe_secret_key_readonly
    }
  }
}

resource "aws_cloudwatch_event_rule" "reconciler" {
  name                = "cinderblock-reconciler-${local.env}"
  description         = "Triggers the Cinderblock stuck-checkout reconciler Lambda"
  schedule_expression = var.reconciler_schedule_expression
}

resource "aws_cloudwatch_event_target" "reconciler" {
  rule      = aws_cloudwatch_event_rule.reconciler.name
  target_id = "cinderblock-reconciler-${local.env}"
  arn       = aws_lambda_function.reconciler.arn
}

resource "aws_lambda_permission" "reconciler_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reconciler.arn
}

# --- Alerting -----------------------------------------------------------
# First alerting primitive in this codebase (no other SNS topic/alarm exists
# yet). Kept to the minimum that's actually useful: one topic, one email
# subscription, one alarm on the metric the reconciler always emits (so it
# never sits at INSUFFICIENT_DATA and silently stops alerting).

resource "aws_sns_topic" "reconciler_alerts" {
  name = "cinderblock-reconciler-alerts-${local.env}"
}

resource "aws_sns_topic_subscription" "reconciler_alerts_email" {
  topic_arn = aws_sns_topic.reconciler_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "stuck_checkouts" {
  alarm_name          = "cinderblock-stuck-checkouts-${local.env}"
  alarm_description   = "A Stripe checkout completed but its site never advanced past building/preview — likely a broken post-payment webhook."
  namespace           = "Cinderblock/Reconciler"
  metric_name         = "StuckCheckouts"
  dimensions          = { env = local.env }
  statistic           = "Maximum"
  period              = 900 # matches the reconciler's default 15-min schedule
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.reconciler_alerts.arn]
  ok_actions          = [aws_sns_topic.reconciler_alerts.arn]
}
