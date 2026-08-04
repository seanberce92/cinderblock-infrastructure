variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "cors_origin" {
  description = "Allowed origin for browser PUTs to the uploads bucket (the frontend URL)"
  type        = string
  default     = "*"
}
