variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "cognito_password_minimum_length" {
  description = "Minimum password length enforced by Cognito"
  type        = number
  default     = 8
}
