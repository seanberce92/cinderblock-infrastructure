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
