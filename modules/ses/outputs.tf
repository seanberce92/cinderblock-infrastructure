output "ses_identity_arn" {
  description = "SES_IDENTITY_ARN (backend) — scopes the sesv2:SendEmail IAM permission"
  value       = aws_sesv2_email_identity.mail.arn
}

output "configuration_set_name" {
  description = "SES_CONFIGURATION_SET (backend)"
  value       = aws_sesv2_configuration_set.transactional.configuration_set_name
}

output "mail_from_address" {
  description = "SES_FROM_ADDRESS (backend) — the verified sending domain; pick any local part (e.g. notifications@)"
  value       = var.mail_subdomain
}

output "email_alerts_topic_arn" {
  description = "SNS topic that receives SES bounce/complaint notifications"
  value       = aws_sns_topic.email_alerts.arn
}

# ---------------------------------------------------------------------------
# Manual DNS checklist — cinderblock.site's DNS lives at Namecheap, not
# Route 53, so Terraform cannot create these records itself. After
# `terraform apply`, run `terraform output -json namecheap_dns_checklist` and
# add each entry under Namecheap -> Domain List -> cinderblock.site ->
# Advanced DNS. `host` is already relative to the apex domain the way
# Namecheap's UI expects it (do not paste the fully-qualified name into the
# Host field).
# ---------------------------------------------------------------------------
output "namecheap_dns_checklist" {
  description = "DNS records to add manually at Namecheap to verify the SES identity and set up SPF/DKIM/DMARC"
  value = concat(
    [
      for token in aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens : {
        type  = "CNAME"
        host  = "${token}._domainkey.${local.mail_host_relative}"
        value = "${token}.dkim.amazonses.com"
        note  = "Easy DKIM signing key (also satisfies domain-identity verification — no separate TXT token needed)"
      }
    ],
    [
      {
        type  = "MX"
        host  = local.bounce_host_relative
        value = "10 feedback-smtp.${var.common_labels.aws_region}.amazonses.com"
        note  = "MAIL FROM domain — required for bounce/complaint feedback"
      },
      {
        type  = "TXT"
        host  = local.bounce_host_relative
        value = "v=spf1 include:amazonses.com ~all"
        note  = "SPF for the MAIL FROM domain"
      },
      {
        type  = "TXT"
        host  = local.dmarc_host_relative
        value = "v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${var.dmarc_report_email}; adkim=s; aspf=s"
        note  = "DMARC policy — start at p=quarantine, tighten to p=reject once reputation is established"
      },
    ]
  )
}
