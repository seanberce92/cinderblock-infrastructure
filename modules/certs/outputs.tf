output "frontend_cert_arn" {
  description = "ACM cert ARN for the frontend CloudFront distribution (validated)"
  value       = aws_acm_certificate_validation.frontend.certificate_arn
}

output "api_cert_arn" {
  description = "ACM cert ARN for the API Gateway custom domain (validated)"
  value       = aws_acm_certificate_validation.api.certificate_arn
}

# Run `terraform output -json certs_namecheap_dns_checklist` after the first
# apply and add each record under Namecheap -> Domain List ->
# cinderblock.site -> Advanced DNS. `host` is already relative to the apex
# domain the way Namecheap's UI expects it. Same convention as the `ses`
# module's `namecheap_dns_checklist` output.
output "namecheap_dns_checklist" {
  description = "ACM DNS validation records to add manually at Namecheap"
  value = concat(
    [
      for o in aws_acm_certificate.frontend.domain_validation_options : {
        type  = o.resource_record_type
        host  = trimsuffix(o.resource_record_name, "${local.apex_suffix}.")
        value = o.resource_record_value
        note  = "ACM DNS validation for ${var.frontend_domain}"
      }
    ],
    [
      for o in aws_acm_certificate.api.domain_validation_options : {
        type  = o.resource_record_type
        host  = trimsuffix(o.resource_record_name, "${local.apex_suffix}.")
        value = o.resource_record_value
        note  = "ACM DNS validation for ${var.api_domain}"
      }
    ]
  )
}
