# Points the AWS provider at DynamoDB Local instead of real AWS. Dummy
# credentials + the skip_* flags stop the provider from trying to validate
# them or resolve an account id, since there's no real AWS behind this
# endpoint. Only the dynamodb service is overridden — this root only ever
# applies modules/dynamodb.
provider "aws" {
  region = "us-east-1"

  access_key                  = "local"
  secret_key                  = "local"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true

  endpoints {
    dynamodb = "http://localhost:8000"
  }
}
