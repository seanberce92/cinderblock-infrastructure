# ---------------------------------------------------------------------------
# Cinderblock QA environment.
# Naming convention for every resource: cinderblock-{resource}-{env}.
# Only the qa environment exists today; everything is parameterized on `env`
# so a prod/ dir would be a near-copy.
# ---------------------------------------------------------------------------

module "common-labels" {
  source     = "../modules/common-labels"
  env        = "qa"
  aws_region = var.aws_region
}

module "auth" {
  source        = "../modules/auth"
  common_labels = module.common-labels
}

module "data" {
  source        = "../modules/data"
  common_labels = module.common-labels
  cors_origin   = var.frontend_url
}

module "workers" {
  source        = "../modules/workers"
  common_labels = module.common-labels

  sites_table_name    = module.data.sites_table_name
  sites_table_arn     = module.data.sites_table_arn
  uploads_bucket_name = module.data.uploads_bucket_name
  uploads_bucket_arn  = module.data.uploads_bucket_arn
  bedrock_model_id    = var.bedrock_model_id
  google_maps_api_key = var.google_maps_api_key

  stripe_secret_key_readonly = var.stripe_secret_key_readonly
  alert_email                = var.alert_email
}
