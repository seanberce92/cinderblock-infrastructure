#!/usr/bin/env bash

echo "Terraform Version:"
terraform version

echo "Terraform Init:"
terraform init

echo "Terraform Plan:"
terraform plan -out=tfplan
