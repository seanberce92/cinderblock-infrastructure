# ---------------------------------------------------------------------------
# cinderblock-users
# PK: userId (Cognito sub). Holds email + Stripe customer id.
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "users" {
  name         = "cinderblock-users-${var.common_labels.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  tags = {
    Name = "cinderblock-users-${var.common_labels.env}"
  }
}

# ---------------------------------------------------------------------------
# cinderblock-sites
# PK: siteId. GSI userId-index for listing a user's sites, GSI
# subscriptionId-index for resolving a site from a Stripe subscription
# webhook (customer.subscription.deleted only carries the subscription id,
# never siteId). Single source of truth for a site through
# building -> preview -> provisioning -> live -> offline -> (torn down).
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "sites" {
  name         = "cinderblock-sites-${var.common_labels.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "siteId"

  attribute {
    name = "siteId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "subscriptionId"
    type = "S"
  }

  global_secondary_index {
    name            = "userId-index"
    hash_key        = "userId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "subscriptionId-index"
    hash_key        = "subscriptionId"
    projection_type = "ALL"
  }

  tags = {
    Name = "cinderblock-sites-${var.common_labels.env}"
  }
}
