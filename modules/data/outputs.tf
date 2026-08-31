output "users_table_name" {
  value = module.dynamodb.users_table_name
}

output "users_table_arn" {
  value = module.dynamodb.users_table_arn
}

output "sites_table_name" {
  value = module.dynamodb.sites_table_name
}

output "sites_table_arn" {
  value = module.dynamodb.sites_table_arn
}

output "ratelimits_table_name" {
  value = module.dynamodb.ratelimits_table_name
}

output "ratelimits_table_arn" {
  value = module.dynamodb.ratelimits_table_arn
}

output "uploads_bucket_name" {
  value = aws_s3_bucket.uploads.bucket
}

output "uploads_bucket_arn" {
  value = aws_s3_bucket.uploads.arn
}

output "email_assets_bucket_name" {
  value = aws_s3_bucket.email_assets.bucket
}

output "email_assets_bucket_url" {
  description = "Base HTTPS URL for public email assets, e.g. {this}/logo-white.png"
  value       = "https://${aws_s3_bucket.email_assets.bucket}.s3.${var.common_labels.aws_region}.amazonaws.com"
}

output "placeholder_bucket_name" {
  value = aws_s3_bucket.placeholder.bucket
}

output "placeholder_origin_domain" {
  description = "Regional REST-endpoint domain used as a CloudFront CustomOriginConfig origin, e.g. cinderblock-placeholder-qa.s3.us-east-1.amazonaws.com"
  value       = aws_s3_bucket.placeholder.bucket_regional_domain_name
}
