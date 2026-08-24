output "bucket_name" {
  description = "S3 bucket to sync dist/ into (frontend deploy target)"
  value       = aws_s3_bucket.frontend.id
}

output "distribution_id" {
  description = "CloudFront distribution id, used to invalidate the cache after a deploy"
  value       = aws_cloudfront_distribution.frontend.id
}

output "distribution_domain_name" {
  description = "CloudFront distribution domain -- point the Namecheap CNAME for the frontend domain at this"
  value       = aws_cloudfront_distribution.frontend.domain_name
}
