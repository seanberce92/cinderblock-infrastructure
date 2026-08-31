output "users_table_name" {
  value = aws_dynamodb_table.users.name
}

output "users_table_arn" {
  value = aws_dynamodb_table.users.arn
}

output "sites_table_name" {
  value = aws_dynamodb_table.sites.name
}

output "sites_table_arn" {
  value = aws_dynamodb_table.sites.arn
}

output "ratelimits_table_name" {
  value = aws_dynamodb_table.ratelimits.name
}

output "ratelimits_table_arn" {
  value = aws_dynamodb_table.ratelimits.arn
}
