# Table definitions live in ../dynamodb so the same HCL can be applied
# against real AWS (here) or a local DynamoDB Local endpoint (see ../../local),
# without maintaining the schema in two places.
module "dynamodb" {
  source        = "../dynamodb"
  common_labels = var.common_labels
}
