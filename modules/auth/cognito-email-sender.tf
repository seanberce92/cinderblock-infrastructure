# ---------------------------------------------------------------------------
# Cognito Custom Email Sender — replaces Cognito's default plain-text mailer
# for SignUp/ResendCode with a branded SES send. Cognito invokes this Lambda
# synchronously and expects it to fully deliver the email itself; see
# lambdas/cognito-email-sender/index.mjs for the decrypt + send flow.
# ---------------------------------------------------------------------------
resource "aws_iam_role_policy" "cognito_email_sender" {
  name = "cinderblock-cognito-email-sender-policy-${var.common_labels.env}"
  role = aws_iam_role.cognito_email_sender.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${var.common_labels.aws_region}:${local.account_id}:log-group:/aws/lambda/cinderblock-cognito-email-sender-${var.common_labels.env}:*"]
      },
      {
        # Resource = "*" is intentional, not an oversight: while the account
        # is in the SES sandbox, ses:SendEmail is authorized against BOTH the
        # sender's identity ARN and the recipient's identity ARN (every
        # sandbox recipient has to be individually verified, and IAM checks
        # that verification the same way it checks the sender's). Recipients
        # are dynamic/unknowable ahead of time, so a Resource scoped to just
        # the sending identity denies every send in sandbox mode regardless
        # of the sender being correct. This role is already dedicated to a
        # single-purpose Lambda, so narrowing this further buys little real
        # protection anyway.
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = ["*"]
      },
      {
        # Belt-and-suspenders alongside the key's own resource policy
        # (kms.tf's EmailSenderLambdaDecrypt statement) — AWS recommends
        # granting on both sides. kms:DescribeKey is needed by the AWS
        # Encryption SDK's KmsKeyringNode to validate the key before use.
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey"]
        Resource = [aws_kms_key.cognito_email_sender.arn]
      }
    ]
  })
}

resource "aws_lambda_function" "cognito_email_sender" {
  function_name    = "cinderblock-cognito-email-sender-${var.common_labels.env}"
  filename         = var.lambda_cognito_email_sender_zip_path
  source_code_hash = filebase64sha256(var.lambda_cognito_email_sender_zip_path)
  role             = aws_iam_role.cognito_email_sender.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      SES_CONFIGURATION_SET = var.ses_configuration_set_name
      SES_FROM_ADDRESS      = var.ses_from_address
      APP_URL               = var.app_url
      # AWS Encryption SDK keyring needs both — generatorKeyId takes the key
      # id, keyIds takes the ARN. See index.mjs's header comment for why a
      # plain kms:Decrypt call doesn't work here.
      KMS_KEY_ID  = aws_kms_key.cognito_email_sender.key_id
      KMS_KEY_ARN = aws_kms_key.cognito_email_sender.arn
    }
  }
}

resource "aws_lambda_permission" "cognito_invoke_email_sender" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_email_sender.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.cinderblock.arn
}
