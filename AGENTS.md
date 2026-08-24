The AWS services account Terraform uses has limited access, if you add something new that will reqire a new IAM permission, output the JSON to be added and which policy it should be added to.

### existing policies:
* dynamo-seeder-qa
* Log-reader-policy
* terraform-bedrock
* terraform-compute
* terraform-iam-cognito-secrets
* terraform-iam-policy
* terraform-sst
