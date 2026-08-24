# ---------------------------------------------------------------------------
# Provisioning pipeline — a Step Functions state machine that drives the
# provisioner Lambda through the long/async post-payment steps (domain, ACM,
# CloudFront, bucket lockdown). The Wait + Choice loops handle eventual
# consistency for domain registration, cert validation, and distribution deploy.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "provisioning_sfn" {
  name = "cinderblock-provisioning-sfn-role-${local.env}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "provisioning_sfn" {
  name = "cinderblock-provisioning-sfn-policy-${local.env}"
  role = aws_iam_role.provisioning_sfn.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.provisioner.arn]
    }]
  })
}

locals {
  provisioner_arn = aws_lambda_function.provisioner.arn

  # Helper-shaped task: invoke the provisioner with a fixed step, retry transient
  # Lambda errors, and route any failure to MarkFailed.
  retry_block = [{
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 5
    MaxAttempts     = 3
    BackoffRate     = 2.0
  }]
  catch_block = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "MarkFailed"
  }]
  sandbox_catch_block = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "MarkSandboxFailed"
  }]
  offline_catch_block = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "SiteOfflineFailed"
  }]
  reactivate_catch_block = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "MarkReactivateFailed"
  }]
  teardown_catch_block = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "MarkTeardownFailed"
  }]
}

resource "aws_sfn_state_machine" "provisioning" {
  name     = "cinderblock-provisioning-${local.env}"
  role_arn = aws_iam_role.provisioning_sfn.arn

  definition = jsonencode({
    Comment = "Cinderblock post-payment provisioning"
    StartAt = "Init"
    States = {
      Init = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "init" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "DomainOwned"
      }
      DomainOwned = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.domainOwned"
          BooleanEquals = true
          Next          = "EnsureHostedZone"
        }]
        Default = "RegisterDomain"
      }
      RegisterDomain = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "registerDomain" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "WaitDomain"
      }
      WaitDomain = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckDomain"
      }
      CheckDomain = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkDomain" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "DomainReady"
      }
      DomainReady = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.domainReady"
          BooleanEquals = true
          Next          = "EnsureHostedZone"
        }]
        Default = "WaitDomain"
      }
      EnsureHostedZone = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "ensureHostedZone" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "RequestCert"
      }
      RequestCert = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "requestCert" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "WaitCert"
      }
      WaitCert = {
        Type    = "Wait"
        Seconds = 30
        Next    = "CheckCert"
      }
      CheckCert = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkCert" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "CertReady"
      }
      CertReady = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.certReady"
          BooleanEquals = true
          Next          = "BuildSite"
        }]
        Default = "WaitCert"
      }
      BuildSite = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "buildSite" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "CreateDistribution"
      }
      CreateDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "createDistribution" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "WaitDist"
      }
      WaitDist = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckDist"
      }
      CheckDist = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkDist" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "DistReady"
      }
      DistReady = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.distReady"
          BooleanEquals = true
          Next          = "WriteAlias"
        }]
        Default = "WaitDist"
      }
      WriteAlias = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "writeAlias" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "LockBucket"
      }
      LockBucket = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "lockBucket" }
        Retry      = local.retry_block
        Catch      = local.catch_block
        Next       = "MarkLive"
      }
      MarkLive = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markLive" }
        Retry      = local.retry_block
        End        = true
      }
      MarkFailed = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markFailed", "error.$" = "$.error" }
        Next       = "ProvisioningFailed"
      }
      ProvisioningFailed = {
        Type  = "Fail"
        Error = "ProvisioningFailed"
        Cause = "See the site record's error field."
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Sandbox provisioning pipeline — a much shorter state machine that stands up
# a CloudFront distribution in front of an already-live site's sandbox bucket
# so a customer can preview post-launch revisions before publishing them.
# No domain registration, ACM cert, or Route 53 wiring: sandboxes are only
# ever reached at their CloudFront default (*.cloudfront.net) domain, which
# already has valid TLS. Reuses the same provisioner Lambda + IAM role as the
# main pipeline above (it dispatches on `step` too).
# ---------------------------------------------------------------------------
resource "aws_sfn_state_machine" "sandbox_provisioning" {
  name     = "cinderblock-sandbox-provisioning-${local.env}"
  role_arn = aws_iam_role.provisioning_sfn.arn

  definition = jsonencode({
    Comment = "Cinderblock sandbox provisioning"
    StartAt = "CreateSandboxDistribution"
    States = {
      CreateSandboxDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "createSandboxDistribution" }
        Retry      = local.retry_block
        Catch      = local.sandbox_catch_block
        Next       = "WaitSandboxDist"
      }
      WaitSandboxDist = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckSandboxDist"
      }
      CheckSandboxDist = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkSandboxDist" }
        Retry      = local.retry_block
        Catch      = local.sandbox_catch_block
        Next       = "SandboxDistReady"
      }
      SandboxDistReady = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.sandboxDistReady"
          BooleanEquals = true
          Next          = "LockSandboxBucket"
        }]
        Default = "WaitSandboxDist"
      }
      LockSandboxBucket = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "lockSandboxBucket" }
        Retry      = local.retry_block
        Catch      = local.sandbox_catch_block
        Next       = "MarkSandboxReady"
      }
      MarkSandboxReady = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markSandboxReady" }
        Retry      = local.retry_block
        Catch      = local.sandbox_catch_block
        End        = true
      }
      MarkSandboxFailed = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markSandboxFailed", "error.$" = "$.error" }
        Next       = "SandboxProvisioningFailed"
      }
      SandboxProvisioningFailed = {
        Type  = "Fail"
        Error = "SandboxProvisioningFailed"
        Cause = "See the site record's sandboxError field."
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Site offline pipeline — triggered by the customer.subscription.deleted
# webhook once the site's DB status has already been flipped to "offline"
# synchronously. Swaps the CloudFront distribution's origin to the shared
# branded placeholder (see the data module's cinderblock-placeholder bucket);
# nothing is disabled or destroyed. Reuses the same provisioner Lambda + IAM role.
# ---------------------------------------------------------------------------
resource "aws_sfn_state_machine" "site_offline" {
  name     = "cinderblock-site-offline-${local.env}"
  role_arn = aws_iam_role.provisioning_sfn.arn

  definition = jsonencode({
    Comment = "Cinderblock site offline (subscription ended)"
    StartAt = "DisableDomainAutoRenew"
    States = {
      DisableDomainAutoRenew = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "disableDomainAutoRenew" }
        Retry      = local.retry_block
        Catch      = local.offline_catch_block
        Next       = "DisableDistribution"
      }
      DisableDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "switchToPlaceholderOrigin" }
        Retry      = local.retry_block
        Catch      = local.offline_catch_block
        Next       = "WaitDisable"
      }
      WaitDisable = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckDistDisabled"
      }
      CheckDistDisabled = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkPlaceholderOriginActive" }
        Retry      = local.retry_block
        Catch      = local.offline_catch_block
        Next       = "DistDisabled"
      }
      DistDisabled = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.distDisabled"
          BooleanEquals = true
          Next          = "SiteOfflineDone"
        }]
        Default = "WaitDisable"
      }
      SiteOfflineDone = {
        Type = "Succeed"
      }
      SiteOfflineFailed = {
        Type  = "Fail"
        Error = "SiteOfflineFailed"
        Cause = "Distribution may still be publicly accessible; see execution error."
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Site reactivate pipeline — triggered when a new checkout.session.completed
# arrives for a site that was "offline" (i.e. the customer resubscribed
# during the grace period). Swaps the existing CloudFront distribution's
# origin back to the site's own bucket rather than provisioning a new one.
# ---------------------------------------------------------------------------
resource "aws_sfn_state_machine" "site_reactivate" {
  name     = "cinderblock-site-reactivate-${local.env}"
  role_arn = aws_iam_role.provisioning_sfn.arn

  definition = jsonencode({
    Comment = "Cinderblock site reactivate (resubscribed during grace period)"
    StartAt = "EnableDistribution"
    States = {
      EnableDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "switchToLiveOrigin" }
        Retry      = local.retry_block
        Catch      = local.reactivate_catch_block
        Next       = "WaitEnable"
      }
      WaitEnable = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckDistEnabled"
      }
      CheckDistEnabled = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkLiveOriginActive" }
        Retry      = local.retry_block
        Catch      = local.reactivate_catch_block
        Next       = "DistEnabled"
      }
      DistEnabled = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.distEnabled"
          BooleanEquals = true
          Next          = "MarkLive"
        }]
        Default = "WaitEnable"
      }
      MarkLive = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markLive" }
        Retry      = local.retry_block
        End        = true
      }
      MarkReactivateFailed = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markReactivateFailed", "error.$" = "$.error" }
        Next       = "ReactivateFailed"
      }
      ReactivateFailed = {
        Type  = "Fail"
        Error = "ReactivateFailed"
        Cause = "See the site record's error field."
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Site teardown pipeline — permanently destroys a site's hosting resources.
# Started either by the backend (owner-triggered "delete now") or by the
# subscription-teardown sweep Lambda (automatic, after the grace period),
# both coordinated through the site record's teardownStartedAt lock so they
# can't race each other. Disables both distributions before deleting them
# (CloudFront requires Enabled=false + fully deployed before DeleteDistribution
# succeeds), then DNS, then domain auto-renew, then buckets, then the DB item.
# ---------------------------------------------------------------------------
resource "aws_sfn_state_machine" "site_teardown" {
  name     = "cinderblock-site-teardown-${local.env}"
  role_arn = aws_iam_role.provisioning_sfn.arn

  definition = jsonencode({
    Comment = "Cinderblock site teardown (permanent deletion)"
    StartAt = "DisableDistribution"
    States = {
      DisableDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "disableDistribution" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "WaitDisable"
      }
      WaitDisable = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckDistDisabled"
      }
      CheckDistDisabled = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkDistDisabled" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "DistDisabledChoice"
      }
      DistDisabledChoice = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.distDisabled"
          BooleanEquals = true
          Next          = "DisableSandboxDistribution"
        }]
        Default = "WaitDisable"
      }
      DisableSandboxDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "disableSandboxDistribution" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "WaitSandboxDisable"
      }
      WaitSandboxDisable = {
        Type    = "Wait"
        Seconds = 60
        Next    = "CheckSandboxDistDisabled"
      }
      CheckSandboxDistDisabled = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "checkSandboxDistDisabled" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "SandboxDistDisabledChoice"
      }
      SandboxDistDisabledChoice = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.sandboxDistDisabled"
          BooleanEquals = true
          Next          = "DeleteDistribution"
        }]
        Default = "WaitSandboxDisable"
      }
      DeleteDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "deleteDistribution" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "DeleteSandboxDistribution"
      }
      DeleteSandboxDistribution = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "deleteSandboxDistribution" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "DeleteHostedZone"
      }
      DeleteHostedZone = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "deleteHostedZone" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "DisableDomainAutoRenew"
      }
      DisableDomainAutoRenew = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "disableDomainAutoRenew" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "DeleteBuckets"
      }
      DeleteBuckets = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "deleteBuckets" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        Next       = "HardDeleteSiteRecord"
      }
      HardDeleteSiteRecord = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "hardDeleteSiteRecord" }
        Retry      = local.retry_block
        Catch      = local.teardown_catch_block
        End        = true
      }
      MarkTeardownFailed = {
        Type       = "Task"
        Resource   = local.provisioner_arn
        Parameters = { "siteId.$" = "$.siteId", step = "markTeardownFailed", "error.$" = "$.error" }
        Next       = "TeardownFailed"
      }
      TeardownFailed = {
        Type  = "Fail"
        Error = "TeardownFailed"
        Cause = "See the site record's teardownError field."
      }
    }
  })
}

resource "aws_cloudwatch_metric_alarm" "site_offline_failed" {
  alarm_name          = "cinderblock-site-offline-failed-${local.env}"
  alarm_description   = "A site-offline Step Functions execution failed — the site's DB status may say offline while CloudFront is still serving it publicly."
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.site_offline.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.reconciler_alerts.arn]
  ok_actions          = [aws_sns_topic.reconciler_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "site_teardown_failed" {
  alarm_name          = "cinderblock-site-teardown-failed-${local.env}"
  alarm_description   = "A site-teardown Step Functions execution failed — the site is stuck mid-deletion; see teardownError on the site record."
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.site_teardown.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.reconciler_alerts.arn]
  ok_actions          = [aws_sns_topic.reconciler_alerts.arn]
}
