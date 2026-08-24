# ---------------------------------------------------------------------------
# Custom domain for the backend's API Gateway v2 HTTP API. The API itself is
# created by SST (cinderblock-backend/sst.config.ts), not Terraform -- this
# module only attaches api-qa.cinderblock.site to its existing $default
# stage via var.api_id. sst.config.ts stays untouched, so this mapping
# survives future `sst deploy`s without SST needing to know about the domain.
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = var.cert_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = {
    Name = "cinderblock-api-domain-${var.common_labels.env}"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = var.api_id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = var.stage
}
