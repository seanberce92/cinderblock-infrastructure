# ---------------------------------------------------------------------------
# SES — branded transactional email sending identity for Cinderblock.
#
# Sends from a dedicated subdomain (mail.cinderblock.site), not the apex, so a
# sending-reputation problem can never affect the main domain or any future
# marketing email. cinderblock.site's DNS is hosted at Namecheap, not Route 53
# — this module only creates the SES/SNS/CloudWatch resources; the DNS records
# it requires are surfaced via the `namecheap_dns_checklist` output below
# (run `terraform output -json namecheap_dns_checklist` after apply) for a
# human to add by hand.
# ---------------------------------------------------------------------------

locals {
  env              = var.common_labels.env
  bounce_subdomain = "bounce.${var.mail_subdomain}"
  dmarc_subdomain  = "_dmarc.${var.mail_subdomain}"

  # Namecheap's "Host" field in Advanced DNS is relative to the registered
  # apex domain, not a FQDN — e.g. for mail_subdomain="mail.cinderblock.site"
  # and apex_domain="cinderblock.site", the relative host for the mail
  # subdomain itself is "mail". Strips ".{apex_domain}" off each FQDN.
  apex_suffix          = ".${var.apex_domain}"
  mail_host_relative   = trimsuffix(var.mail_subdomain, local.apex_suffix)
  bounce_host_relative = trimsuffix(local.bounce_subdomain, local.apex_suffix)
  dmarc_host_relative  = trimsuffix(local.dmarc_subdomain, local.apex_suffix)
}

resource "aws_sesv2_email_identity" "mail" {
  email_identity = var.mail_subdomain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  tags = {
    Name = "cinderblock-ses-${local.env}"
  }
}

# MAIL FROM domain — required for SPF to align (SES's shared sending domain
# fails SPF alignment on its own). Produces an MX + SPF TXT record on
# bounce.mail.cinderblock.site, not the identity itself.
resource "aws_ses_domain_mail_from" "mail" {
  domain           = aws_sesv2_email_identity.mail.email_identity
  mail_from_domain = local.bounce_subdomain
}

resource "aws_sesv2_configuration_set" "transactional" {
  configuration_set_name = "cinderblock-transactional-${local.env}"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

# --- Bounce/complaint alerting --------------------------------------------
# Separate from modules/workers/reconciler.tf's `reconciler_alerts` topic on
# purpose: deliverability issues are a different failure domain (and a
# different on-call action) than a stuck Stripe webhook, and bounce/complaint
# volume could otherwise drown out the checkout-stuck alarm.

resource "aws_sns_topic" "email_alerts" {
  name = "cinderblock-email-alerts-${local.env}"
}

resource "aws_sns_topic_subscription" "email_alerts_email" {
  topic_arn = aws_sns_topic.email_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sesv2_configuration_set_event_destination" "bounce_complaint" {
  configuration_set_name = aws_sesv2_configuration_set.transactional.configuration_set_name
  event_destination_name = "sns-bounce-complaint"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.email_alerts.arn
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "bounce_rate" {
  alarm_name          = "cinderblock-ses-bounce-rate-${local.env}"
  alarm_description   = "SES bounce rate for the transactional configuration set exceeded 5% over an hour — sending domain reputation at risk."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  dimensions          = { "ses:configuration-set" = aws_sesv2_configuration_set.transactional.configuration_set_name }
  statistic           = "Average"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0.05
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.email_alerts.arn]
  ok_actions          = [aws_sns_topic.email_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "complaint_rate" {
  alarm_name          = "cinderblock-ses-complaint-rate-${local.env}"
  alarm_description   = "SES complaint rate for the transactional configuration set exceeded 0.1% over an hour — sending domain reputation at risk."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.ComplaintRate"
  dimensions          = { "ses:configuration-set" = aws_sesv2_configuration_set.transactional.configuration_set_name }
  statistic           = "Average"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0.001
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.email_alerts.arn]
  ok_actions          = [aws_sns_topic.email_alerts.arn]
}
