variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "domain_name" {
  description = "Custom domain served by this CloudFront distribution"
  type        = string
  default     = "qa.cinderblock.site"
}

variable "cert_arn" {
  description = "ACM certificate ARN (us-east-1) covering domain_name"
  type        = string
}

variable "price_class" {
  description = "CloudFront price class"
  type        = string
  default     = "PriceClass_100"
}
