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
