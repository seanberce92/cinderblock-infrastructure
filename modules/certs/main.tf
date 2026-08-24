# ---------------------------------------------------------------------------
# ACM certificates for the frontend (CloudFront) and API (API Gateway v2
# custom domain) hostnames. Both need DNS validation; cinderblock.site's DNS
# lives at Namecheap, not Route 53, so Terraform can request the certs but a
# human has to add the validation CNAMEs by hand (see the
# `namecheap_dns_checklist` output) before the aws_acm_certificate_validation
# resources below can complete — same manual-DNS pattern as the `ses` module.
#
# CloudFront requires its cert in us-east-1; API Gateway v2 custom domains
# require the cert in the same region as the API. Both are already us-east-1
# here, so no provider alias is needed.
# ---------------------------------------------------------------------------

locals {
  env = var.common_labels.env

  apex_suffix = ".${var.apex_domain}"
}

resource "aws_acm_certificate" "frontend" {
  domain_name       = var.frontend_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "cinderblock-frontend-cert-${local.env}"
  }
}

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "cinderblock-api-cert-${local.env}"
  }
}

# Blocks until ACM sees the manually-added Namecheap CNAME records (default
# 45m timeout). If the records aren't in place yet, re-run
# `terraform apply -target=module.certs` once they've been added and
# propagated instead of leaving this blocking a full qa apply.
resource "aws_acm_certificate_validation" "frontend" {
  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for o in aws_acm_certificate.frontend.domain_validation_options : o.resource_record_name]
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for o in aws_acm_certificate.api.domain_validation_options : o.resource_record_name]
}
