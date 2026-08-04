# ---------------------------------------------------------------------------
# Cognito User Pool — customer accounts for Cinderblock.
# Email-based sign-in with Cognito-managed verification + forgot-password.
# Cognito uses its default email sender (no SES identity required), which is
# fine for QA volumes. No passwords are stored in DynamoDB.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "cinderblock" {
  name = "cinderblock-user-pool-${var.common_labels.env}"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Verify your Cinderblock account"
    email_message        = "Your verification code is {####}"
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
