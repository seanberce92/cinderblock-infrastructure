# Local dev environment. Applies the *same* modules/dynamodb module used by
# ../qa, just pointed at a DynamoDB Local container (see ./docker-compose.yml)
# instead of real AWS — one schema, no drift between local and qa.
#
# Deliberately does NOT include modules/data's S3 buckets, or any other qa
# module (auth, workers, certs, ...) — those have no local equivalent here.
# Backend local dev (cinderblock-backend `npm run local`) talks to real AWS
# for everything except DynamoDB.

module "common-labels" {
  source     = "../modules/common-labels"
  env        = "local"
  aws_region = "us-east-1"
}

module "dynamodb" {
  source        = "../modules/dynamodb"
  common_labels = module.common-labels
}
