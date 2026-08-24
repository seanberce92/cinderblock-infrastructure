# These outputs feed the backend .env (cinderblock-backend) and the frontend
# .env (cinderblock-frontend). Run `terraform output` after apply.

output "cognito_user_pool_id" {
  description = "COGNITO_USER_POOL_ID (backend) / VITE_COGNITO_USER_POOL_ID (frontend)"
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "COGNITO_CLIENT_ID (backend) / VITE_COGNITO_CLIENT_ID (frontend)"
  value       = module.auth.user_pool_client_id
}

output "users_table_name" {
  value = module.data.users_table_name
}

output "sites_table_name" {
  value = module.data.sites_table_name
}

output "ratelimits_table_name" {
  description = "RATELIMIT_TABLE (backend)"
  value       = module.data.ratelimits_table_name
}

output "uploads_bucket_name" {
  description = "UPLOADS_BUCKET"
  value       = module.data.uploads_bucket_name
}

output "site_builder_function_name" {
  description = "SITE_BUILDER_FUNCTION_NAME"
  value       = module.workers.site_builder_function_name
}

output "provisioning_state_machine_arn" {
  description = "PROVISIONING_STATE_MACHINE_ARN"
  value       = module.workers.provisioning_state_machine_arn
}

output "sandbox_provisioning_state_machine_arn" {
  description = "SANDBOX_PROVISIONING_STATE_MACHINE_ARN"
  value       = module.workers.sandbox_provisioning_state_machine_arn
}

output "site_offline_state_machine_arn" {
  description = "SITE_OFFLINE_STATE_MACHINE_ARN"
  value       = module.workers.site_offline_state_machine_arn
}

output "site_reactivate_state_machine_arn" {
  description = "SITE_REACTIVATE_STATE_MACHINE_ARN"
  value       = module.workers.site_reactivate_state_machine_arn
}

output "site_teardown_state_machine_arn" {
  description = "SITE_TEARDOWN_STATE_MACHINE_ARN"
  value       = module.workers.site_teardown_state_machine_arn
}

output "provisioner_function_name" {
  description = "PROVISIONER_FUNCTION_NAME"
  value       = module.workers.provisioner_function_name
}

# Not consumed by the backend or frontend — the site-builder Lambda already
# gets this wired as an env var inside the workers module. Surfaced here only
# for manual `aws bedrock-runtime apply-guardrail` testing during QA.
output "site_builder_guardrail_id" {
  value = module.workers.site_builder_guardrail_id
}

# --- Email (SES) -----------------------------------------------------------

output "ses_identity_arn" {
  description = "SES_IDENTITY_ARN (backend)"
  value       = module.ses.ses_identity_arn
}

output "ses_configuration_set_name" {
  description = "SES_CONFIGURATION_SET (backend)"
  value       = module.ses.configuration_set_name
}

output "ses_from_address" {
  description = "SES_FROM_ADDRESS (backend) — pick any local part @ this verified domain"
  value       = module.ses.mail_from_address
}

output "domain_renewal_function_name" {
  value = module.workers.domain_renewal_function_name
}

# Run `terraform output -json namecheap_dns_checklist` after apply and add
# each record under Namecheap -> Domain List -> cinderblock.site -> Advanced
# DNS. See modules/ses/outputs.tf for details on each record.
output "namecheap_dns_checklist" {
  value = module.ses.namecheap_dns_checklist
}

# --- Custom domains (frontend + API) ----------------------------------------

# Run `terraform output -json certs_namecheap_dns_checklist` after apply and
# add each record under Namecheap -> Domain List -> cinderblock.site ->
# Advanced DNS. See modules/certs/outputs.tf for details.
output "certs_namecheap_dns_checklist" {
  value = module.certs.namecheap_dns_checklist
}

output "frontend_bucket_name" {
  description = "S3 bucket to sync cinderblock-frontend's dist/ into"
  value       = module.frontend-hosting.bucket_name
}

output "frontend_distribution_id" {
  description = "CloudFront distribution id, for cache invalidation after a frontend deploy"
  value       = module.frontend-hosting.distribution_id
}

output "frontend_distribution_domain_name" {
  description = "CloudFront distribution domain -- point the Namecheap CNAME for qa.cinderblock.site at this"
  value       = module.frontend-hosting.distribution_domain_name
}

output "api_domain_target" {
  description = "Regional API Gateway target -- point the Namecheap CNAME for api-qa.cinderblock.site at this"
  value       = module.api-domain.target_domain_name
}
