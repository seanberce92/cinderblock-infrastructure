# ---------------------------------------------------------------------------
# IAM role Cognito assumes to publish SMS via SNS — used for phone number
# verification (add/confirm a recovery phone from the app, see
# cinderblock-frontend's useAddPhone/useConfirmPhone) and, in the future, SMS
# MFA if that's ever enabled. Wired onto the pool via the sms_configuration
# block in cognito.tf.
#
# NOTE: a brand-new AWS account starts in the SNS SMS sandbox, which can only
# deliver to phone numbers verified ahead of time in the SNS console. Moving
# to production SMS volume requires an AWS Support request to exit the
# sandbox — a one-time, non-Terraform step.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "cognito_sms" {
  name = "cinderblock-cognito-sms-role-${var.common_labels.env}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "cognito-idp.amazonaws.com" }
      # Confused-deputy guard AWS recommends for this role: Cognito sends its
      # own pool "name" back as the external id when it assumes this role.
      # Using the same deterministic name the pool resource sets below (not a
      # reference to the pool's id/arn output) avoids a dependency cycle
      # between this role and the pool resource in cognito.tf.
      Condition = {
        StringEquals = { "sts:ExternalId" = "cinderblock-user-pool-${var.common_labels.env}" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "cognito_sms" {
  name = "cinderblock-cognito-sms-policy-${var.common_labels.env}"
  role = aws_iam_role.cognito_sms.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # SNS Publish targets a destination phone number at send time, not a
        # provisioned resource — there's no ARN to scope this to.
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = ["*"]
      }
    ]
  })
}
