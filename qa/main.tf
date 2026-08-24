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

module "ses" {
  source = "../modules/ses"

  common_labels      = module.common-labels
  alert_email        = var.alert_email
  dmarc_report_email = var.dmarc_report_email
}

module "auth" {
  source        = "../modules/auth"
  common_labels = module.common-labels

  ses_identity_arn           = module.ses.ses_identity_arn
  ses_configuration_set_name = module.ses.configuration_set_name
  ses_from_address           = "notifications@${module.ses.mail_from_address}"
  app_url                    = var.frontend_url
}

module "data" {
  source        = "../modules/data"
  common_labels = module.common-labels
  cors_origin   = var.frontend_url
}

# ACM certs for qa.cinderblock.site (CloudFront) and api-qa.cinderblock.site
# (API Gateway custom domain). Requires a manual Namecheap DNS validation
# step after the first apply -- see modules/certs/main.tf.
module "certs" {
  source        = "../modules/certs"
  common_labels = module.common-labels
}

module "frontend-hosting" {
  source        = "../modules/frontend-hosting"
  common_labels = module.common-labels
  cert_arn      = module.certs.frontend_cert_arn
}

module "api-domain" {
  source        = "../modules/api-domain"
  common_labels = module.common-labels
  cert_arn      = module.certs.api_cert_arn
  api_id        = var.api_gateway_id
}

module "workers" {
  source        = "../modules/workers"
  common_labels = module.common-labels

  sites_table_name          = module.data.sites_table_name
  sites_table_arn           = module.data.sites_table_arn
  uploads_bucket_name       = module.data.uploads_bucket_name
  uploads_bucket_arn        = module.data.uploads_bucket_arn
  placeholder_origin_domain = module.data.placeholder_origin_domain
  bedrock_model_id          = var.bedrock_model_id
  google_maps_api_key       = var.google_maps_api_key

  stripe_secret_key_readonly = var.stripe_secret_key_readonly
  alert_email                = var.alert_email

  backend_internal_url = var.backend_internal_url
  internal_api_secret  = var.internal_api_secret
}
