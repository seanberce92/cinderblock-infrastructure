variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "sites_table_name" {
  type = string
}

variable "sites_table_arn" {
  type = string
}

variable "uploads_bucket_name" {
  type = string
}

variable "uploads_bucket_arn" {
  type = string
}

variable "bedrock_model_id" {
  description = "Bedrock model id the site-builder invokes"
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

# First genuinely secret value (vs. bedrock_model_id, which is just a model
# name) handled via plain tfvars in this repo. Fine for qa; a real prod env
# should source this from Secrets Manager (aws_secretsmanager_secret +
# a data source here) rather than a tfvars file that could get committed.
variable "google_maps_api_key" {
  description = "Google Cloud API key with Maps Grounding Lite + Places API (New) enabled, used by the site-builder Lambda to resolve googleProfile URLs"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cleanup_schedule_expression" {
  description = "EventBridge schedule for the abandoned-preview cleanup Lambda"
  type        = string
  default     = "rate(1 hour)"
}

variable "reconciler_schedule_expression" {
  description = "EventBridge schedule for the stuck-checkout reconciler Lambda"
  type        = string
  default     = "rate(15 minutes)"
}

# A Stripe API key restricted to read-only access on Checkout Sessions,
# separate from the backend's full secret key — mint via Stripe Dashboard ->
# API keys -> Create restricted key. Same plain-tfvars convention as
# google_maps_api_key above; fine for qa, source from Secrets Manager for prod.
variable "stripe_secret_key_readonly" {
  description = "Restricted (read-only, Checkout Sessions) Stripe API key used by the reconciler Lambda"
  type        = string
  sensitive   = true
  default     = ""
}

variable "alert_email" {
  description = "Email address subscribed to the reconciler's stuck-checkout SNS alerts"
  type        = string
}

variable "lambda_site_builder_zip_path" {
  type    = string
  default = "../lambdas/site-builder/lambda.zip"
}

variable "lambda_cleanup_zip_path" {
  type    = string
  default = "../lambdas/cleanup/lambda.zip"
}

variable "lambda_provisioner_zip_path" {
  type    = string
  default = "../lambdas/provisioner/lambda.zip"
}

variable "lambda_reconciler_zip_path" {
  type    = string
  default = "../lambdas/reconciler/lambda.zip"
}
