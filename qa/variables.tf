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
  description = "Email address subscribed to the reconciler's stuck-checkout SNS alerts"
  type        = string
}
