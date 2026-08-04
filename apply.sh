#!/usr/bin/env bash

echo "Terraform Version:"
terraform version

echo "Terraform Init:"
terraform init

echo "Terraform Apply:"
terraform apply
apply_result=$?

if [ $apply_result -ne 0 ]; then
    echo "Terraform apply failed with exit code $apply_result"
    exit $apply_result
fi

echo "Terraform apply succeeded"
terraform output
exit 0
