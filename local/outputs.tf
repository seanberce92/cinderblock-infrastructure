# These feed cinderblock-backend's .env.local (USERS_TABLE / SITES_TABLE /
# RATELIMIT_TABLE). Run `terraform output` after apply.

output "users_table_name" {
  value = module.dynamodb.users_table_name
}

output "sites_table_name" {
  value = module.dynamodb.sites_table_name
}

output "ratelimits_table_name" {
  value = module.dynamodb.ratelimits_table_name
}
