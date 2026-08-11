output "site_builder_function_name" {
  value = aws_lambda_function.site_builder.function_name
}

output "site_builder_function_arn" {
  value = aws_lambda_function.site_builder.arn
}

output "cleanup_function_name" {
  value = aws_lambda_function.cleanup.function_name
}

output "provisioner_function_name" {
  value = aws_lambda_function.provisioner.function_name
}

output "reconciler_function_name" {
  value = aws_lambda_function.reconciler.function_name
}

output "subscription_teardown_function_name" {
  value = aws_lambda_function.subscription_teardown.function_name
}

output "provisioning_state_machine_arn" {
  value = aws_sfn_state_machine.provisioning.arn
}

output "sandbox_provisioning_state_machine_arn" {
  value = aws_sfn_state_machine.sandbox_provisioning.arn
}

output "site_offline_state_machine_arn" {
  value = aws_sfn_state_machine.site_offline.arn
}

output "site_reactivate_state_machine_arn" {
  value = aws_sfn_state_machine.site_reactivate.arn
}

output "site_teardown_state_machine_arn" {
  value = aws_sfn_state_machine.site_teardown.arn
}

output "site_builder_guardrail_id" {
  value = aws_bedrock_guardrail.site_builder.guardrail_id
}

output "site_builder_guardrail_arn" {
  value = aws_bedrock_guardrail.site_builder.guardrail_arn
}
