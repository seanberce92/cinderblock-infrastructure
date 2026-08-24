# ---------------------------------------------------------------------------
# Cognito User Pool — customer accounts for Cinderblock.
# Email-based sign-in with Cognito-managed verification + forgot-password.
# No passwords are stored in DynamoDB.
#
# Verification emails go out via the Custom Email Sender Lambda below
# (cognito-email-sender.tf) instead of Cognito's default mailer, so they're
# fully SES-branded. The plain-text verification_message_template stays
# configured as a harmless fallback for any trigger source the custom sender
# doesn't cover (it's superseded for SignUp/ResendCode/ForgotPassword, which
# is all this pool exercises today).
#
# sms_configuration (sms.tf) lets users add + verify an optional recovery
# phone number from the app (via Amplify's updateUserAttributes /
# sendUserAttributeVerificationCode / confirmUserAttribute — not part of the
# sign-up flow, since Cognito can't auto-verify two attributes with one
# sign-up code). The backend's /recovery/forgot-email endpoint looks up an
# account by verified phone_number and texts back the account email. Note
# phone_number is NOT declared in the schema block below — deliberately: it's
# an implicit standard Cognito attribute usable without a schema entry, and
# adding/changing a schema block here forces the whole pool to be recreated
# (destroying every existing user's credentials).
#
# mfa_configuration = "OPTIONAL" layers SMS MFA on top of that same verified
# phone (via Amplify's updateMFAPreference — see SmsMfaBanner in the
# frontend), reusing the sms_configuration block above with no extra SNS/IAM
# wiring. "OPTIONAL" (not "ON") is deliberate: it's a per-user opt-in, so
# existing users without a verified phone aren't locked out of logging in.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "cinderblock" {
  name = "cinderblock-user-pool-${var.common_labels.env}"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  mfa_configuration          = "OPTIONAL"
  sms_authentication_message = "Your Cinderblock verification code is {####}"

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Verify your Cinderblock account"
    email_message        = "Your verification code is {####}"
  }

  lambda_config {
    kms_key_id = aws_kms_key.cognito_email_sender.arn
    custom_email_sender {
      lambda_arn     = aws_lambda_function.cognito_email_sender.arn
      lambda_version = "V1_0"
    }
  }

  sms_configuration {
    external_id    = "cinderblock-user-pool-${var.common_labels.env}"
    sns_caller_arn = aws_iam_role.cognito_sms.arn
  }

  password_policy {
    minimum_length                   = var.cognito_password_minimum_length
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  tags = {
    Name = "cinderblock-user-pool-${var.common_labels.env}"
  }
}

# Public SPA client (no secret) — used by the React frontend via Amplify.
resource "aws_cognito_user_pool_client" "web" {
  name         = "cinderblock-web-${var.common_labels.env}"
  user_pool_id = aws_cognito_user_pool.cinderblock.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  access_token_validity  = 1  # hours
  id_token_validity      = 1  # hours
  refresh_token_validity = 30 # days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
}
