variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "frontend_url" {
  description = "Frontend origin allowed to PUT to the uploads bucket (CORS)"
  type        = string
  default     = "http://localhost:5173"
}

variable "bedrock_model_id" {
  description = "Bedrock model id the site-builder invokes"
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "google_maps_api_key" {
  description = "Google Cloud API key with Maps Grounding Lite + Places API (New) enabled, used by the site-builder Lambda to resolve googleProfile URLs"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_secret_key_readonly" {
  description = "Restricted (read-only, Checkout Sessions) Stripe API key used by the reconciler Lambda"
  type        = string
  sensitive   = true
  default     = ""
}

variable "alert_email" {
  description = "Email address subscribed to the reconciler's stuck-checkout SNS alerts and the SES bounce/complaint SNS alerts"
  type        = string
  default     = "seanberce@gmail.com"
}

variable "dmarc_report_email" {
  description = "Address DMARC aggregate reports (rua) for mail.cinderblock.site are sent to"
  type        = string
  default     = "seanberce@gmail.com"
}

variable "backend_internal_url" {
  description = "Base URL of the deployed backend API (SST ApiGatewayV2 url output), used by the domain-renewal Lambda to call /internal/* routes. Known only after the first `sst deploy` — leave blank until then."
  type        = string
  default     = ""
}

# Shared secret authenticating the domain-renewal Lambda to the backend's
# /internal/* routes. Same plain-tfvars convention as
# stripe_secret_key_readonly/google_maps_api_key. Must match the value set on
# the backend via `npx sst secret set InternalApiSecret <value> --stage qa`.
variable "api_gateway_id" {
  description = "API Gateway v2 HTTP API id backing api-qa.cinderblock.site -- the subdomain segment of the SST `apiUrl` output (also stored in backend_internal_url below, e.g. \"v9zc7u2c9k\" from https://v9zc7u2c9k.execute-api.us-east-1.amazonaws.com). Known only after the first `sst deploy`."
  type        = string
  default     = ""
}

variable "internal_api_secret" {
  description = "Shared secret authenticating the domain-renewal Lambda to the backend's /internal/* routes"
  type        = string
  sensitive   = true
  default     = ""
}
