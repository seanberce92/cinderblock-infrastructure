# ---------------------------------------------------------------------------
# subscription-teardown Lambda — EventBridge sweep (weekly in qa, nightly
# once prod exists — see teardown_schedule_expression) that finds sites
# offline past the grace period, re-verifies against Stripe that there's
# still no active subscription, and starts the site_teardown Step Functions
# execution. Reuses the reconciler_alerts SNS topic (already has the
# alert_email subscription) for its own "needs a human" alarm.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "subscription_teardown" {
  name               = "cinderblock-subscription-teardown-role-${local.env}"
  assume_role_policy = local.lambda_assume_role
}

resource "aws_iam_role_policy" "subscription_teardown" {
  name = "cinderblock-subscription-teardown-policy-${local.env}"
  role = aws_iam_role.subscription_teardown.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cinderblock-subscription-teardown-${local.env}:*"]
      },
      {
        # Scan for grace-period-expired offline sites + conditional UpdateItem
        # for the teardownStartedAt lock. No DeleteItem here — the actual hard
        # delete happens inside the provisioner Lambda via site_teardown.
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:UpdateItem"]
        Resource = [var.sites_table_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = [aws_sfn_state_machine.site_teardown.arn]
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

resource "aws_lambda_function" "subscription_teardown" {
  function_name    = "cinderblock-subscription-teardown-${local.env}"
  filename         = var.lambda_subscription_teardown_zip_path
  source_code_hash = filebase64sha256(var.lambda_subscription_teardown_zip_path)
  role             = aws_iam_role.subscription_teardown.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      ENV                             = local.env
      SITES_TABLE                     = var.sites_table_name
      STRIPE_SECRET_KEY               = var.stripe_secret_key_readonly
      SITE_TEARDOWN_STATE_MACHINE_ARN = aws_sfn_state_machine.site_teardown.arn
      GRACE_PERIOD_DAYS               = var.grace_period_days
    }
  }
}

resource "aws_cloudwatch_event_rule" "subscription_teardown" {
  name                = "cinderblock-subscription-teardown-${local.env}"
  description         = "Triggers the Cinderblock subscription-teardown sweep Lambda"
  schedule_expression = var.teardown_schedule_expression
}

resource "aws_cloudwatch_event_target" "subscription_teardown" {
  rule      = aws_cloudwatch_event_rule.subscription_teardown.name
  target_id = "cinderblock-subscription-teardown-${local.env}"
  arn       = aws_lambda_function.subscription_teardown.arn
}

resource "aws_lambda_permission" "subscription_teardown_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.subscription_teardown.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subscription_teardown.arn
}

resource "aws_cloudwatch_metric_alarm" "unexpected_active_subscription" {
  alarm_name        = "cinderblock-unexpected-active-subscription-${local.env}"
  alarm_description = "A site sat offline past the grace period, but Stripe shows an active subscription for its customer — likely a missed reactivation webhook. Investigate before it gets torn down on a later sweep."
  namespace         = "Cinderblock/SubscriptionTeardown"
  metric_name       = "UnexpectedActiveSubscription"
  dimensions        = { env = local.env }
  statistic         = "Maximum"
  # 86400s (1 day) is the max period CloudWatch alarms support — can't set a
  # literal weekly window. With the sweep running weekly (qa default), this
  # just evaluates the most recent datapoint whenever one lands;
  # treat_missing_data = notBreaching keeps it quiet on the days in between.
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.reconciler_alerts.arn]
  ok_actions          = [aws_sns_topic.reconciler_alerts.arn]
}
