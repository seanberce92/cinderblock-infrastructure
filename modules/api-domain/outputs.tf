output "target_domain_name" {
  description = "Regional API Gateway target -- point the Namecheap CNAME for the api domain at this"
  value       = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
}

output "domain_name" {
  value = aws_apigatewayv2_domain_name.api.domain_name
}
