variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "frontend_domain" {
  description = "Custom domain for the frontend CloudFront distribution"
  type        = string
  default     = "qa.cinderblock.site"
}

variable "api_domain" {
  description = "Custom domain for the API Gateway custom domain mapping"
  type        = string
  default     = "api-qa.cinderblock.site"
}

variable "apex_domain" {
  description = "The registrar-level domain (Namecheap), used only to compute DNS-checklist host values relative to it"
  type        = string
  default     = "cinderblock.site"
}
