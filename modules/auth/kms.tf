# ---------------------------------------------------------------------------
# KMS key Cognito uses to encrypt the verification code it hands to the
# Custom Email Sender Lambda (cognito-email-sender.tf). Cognito never sends
# the code itself once a custom sender is configured — it encrypts it with
# this key and the Lambda decrypts it with a matching encryption context.
# ---------------------------------------------------------------------------
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

resource "aws_iam_role" "cognito_email_sender" {
  name = "cinderblock-cognito-email-sender-role-${var.common_labels.env}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_kms_key" "cognito_email_sender" {
  description             = "Encrypts verification codes Cognito hands to the cinderblock-cognito-email-sender Lambda (${var.common_labels.env})"
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountRootFullAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CognitoEncryptDecrypt"
        Effect    = "Allow"
        Principal = { Service = "cognito-idp.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
        }
      },
      {
        Sid       = "EmailSenderLambdaDecrypt"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.cognito_email_sender.arn }
        Action    = ["kms:Decrypt"]
        Resource  = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "cognito_email_sender" {
  name          = "alias/cinderblock-cognito-email-sender-${var.common_labels.env}"
  target_key_id = aws_kms_key.cognito_email_sender.key_id
}
