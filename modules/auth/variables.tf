variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "cognito_password_minimum_length" {
  description = "Minimum password length enforced by Cognito"
  type        = number
  default     = 8
}

variable "ses_identity_arn" {
  description = "SES email identity ARN (module.ses.ses_identity_arn) the Custom Email Sender Lambda is allowed to send from"
  type        = string
}

variable "ses_configuration_set_name" {
  description = "SES configuration set name (module.ses.configuration_set_name) for delivery/bounce tracking"
  type        = string
}

variable "ses_from_address" {
  description = "Verified from-address the Custom Email Sender Lambda sends verification emails from"
  type        = string
}

variable "app_url" {
  description = "Frontend URL, for any links in the branded verification email"
  type        = string
  default     = "http://localhost:5173"
}

variable "lambda_cognito_email_sender_zip_path" {
  type    = string
  default = "../lambdas/cognito-email-sender/lambda.zip"
}
