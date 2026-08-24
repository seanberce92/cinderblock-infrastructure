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

variable "placeholder_origin_domain" {
  description = "Regional REST-endpoint domain of the shared public placeholder bucket, used as a second CloudFront origin on every site's distribution (swapped in while offline or after a failure that leaves DNS already pointed at Cinderblock)"
  type        = string
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

variable "teardown_schedule_expression" {
  description = "EventBridge schedule for the subscription-teardown sweep Lambda"
  type        = string
  # Weekly is plenty against a 90-day grace period, and this only environment
  # today (qa) has negligible real subscriber volume — no need for daily
  # compute/DynamoDB Scan cost here. Pinned to a fixed UTC cron time (9:00
  # UTC Sunday = ~1-2am Pacific, depending on daylight saving) rather than
  # rate(7 days), which just repeats every 168h from whenever it was enabled
  # and drifts unpredictably relative to wall-clock time.
  #
  # TODO(prod): override to nightly — cron(0 9 * * ? *) — once a prod
  # environment exists and this actually gates real customers' data.
  default = "cron(0 9 ? * SUN *)"
}

variable "grace_period_days" {
  description = "Days a site stays offline (subscription ended) before it's eligible for permanent teardown"
  type        = number
  default     = 90
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

variable "domain_renewal_schedule_expression" {
  description = "EventBridge schedule for the domain-renewal reminder/charge Lambda"
  type        = string
  default     = "rate(1 day)"
}

variable "domain_renewal_heads_up_days" {
  description = "Comma-separated days-before-expiration thresholds that trigger an informational heads-up email"
  type        = string
  default     = "14,7"
}

variable "domain_renewal_charge_attempt_days" {
  description = "Comma-separated days-before-expiration thresholds that trigger an off-session Stripe charge attempt"
  type        = string
  default     = "3"
}

variable "backend_internal_url" {
  description = "Base URL of the backend API (e.g. https://api.cinderblock.site), used by the domain-renewal, cleanup, and subscription-teardown Lambdas to call /internal/* routes"
  type        = string
}

# Shared secret the domain-renewal/cleanup/subscription-teardown Lambdas send
# as X-Internal-Secret and the backend's InternalSecretGuard checks against
# INTERNAL_API_SECRET (cinderblock-backend, set via
# `sst secret set InternalApiSecret <value>`). Same plain-tfvars convention as
# stripe_secret_key_readonly/google_maps_api_key.
variable "internal_api_secret" {
  description = "Shared secret authenticating internal-caller Lambdas to the backend's /internal/* routes"
  type        = string
  sensitive   = true
  default     = ""
}

variable "preview_heads_up_minutes" {
  description = "Minutes before a preview site's 12h expiry that the cleanup Lambda sends a 'preview expiring soon' email"
  type        = number
  default     = 60
}

variable "warning_days_before_teardown" {
  description = "Days before the end of the offline grace period that the subscription-teardown Lambda sends a permanent-deletion warning email"
  type        = number
  default     = 7
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

variable "lambda_subscription_teardown_zip_path" {
  type    = string
  default = "../lambdas/subscription-teardown/lambda.zip"
}

variable "lambda_domain_renewal_zip_path" {
  type    = string
  default = "../lambdas/domain-renewal/lambda.zip"
}
