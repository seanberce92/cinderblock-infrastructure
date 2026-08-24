variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "domain_name" {
  description = "Custom domain for the API Gateway custom domain mapping"
  type        = string
  default     = "api-qa.cinderblock.site"
}

variable "cert_arn" {
  description = "ACM certificate ARN (same region as the API) covering domain_name"
  type        = string
}

variable "api_id" {
  description = "API Gateway v2 HTTP API id to map this domain onto (created by SST in cinderblock-backend, not by Terraform)"
  type        = string
}

variable "stage" {
  description = "API Gateway stage to map the domain onto"
  type        = string
  default     = "$default"
}
