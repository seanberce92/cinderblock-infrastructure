variable "common_labels" {
  description = "Common labels from the root module (must include env + aws_region)"
  type        = any
}

variable "mail_subdomain" {
  description = "Dedicated subdomain SES sends from (isolates DKIM/reputation from the apex domain)"
  type        = string
  default     = "mail.cinderblock.site"
}

variable "apex_domain" {
  description = "The registrar-level domain (Namecheap), used only to compute DNS-checklist host values relative to it"
  type        = string
  default     = "cinderblock.site"
}

variable "alert_email" {
  description = "Email address subscribed to the bounce/complaint SNS alerts"
  type        = string
}

variable "dmarc_report_email" {
  description = "Address DMARC aggregate reports (rua) are sent to"
  type        = string
}

variable "dmarc_policy" {
  description = "DMARC enforcement policy (p= tag). Start at quarantine while sending reputation is unproven; tighten to reject later."
  type        = string
  default     = "quarantine"
}
