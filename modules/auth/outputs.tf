output "user_pool_id" {
  description = "Cognito User Pool ID — COGNITO_USER_POOL_ID (backend) / VITE_COGNITO_USER_POOL_ID (frontend)"
  value       = aws_cognito_user_pool.cinderblock.id
}

output "user_pool_client_id" {
  description = "Cognito App Client ID — COGNITO_CLIENT_ID (backend) / VITE_COGNITO_CLIENT_ID (frontend)"
  value       = aws_cognito_user_pool_client.web.id
}
