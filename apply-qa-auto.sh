#!/usr/bin/env bash
set -euo pipefail
# Refuse to auto-apply from a laptop. CI sets $CI=true; humans pass --yes.
if [[ "${CI:-}" != "true" && "${1:-}" != "--yes" ]]; then
  echo "Refusing to auto-apply: set CI=true or pass --yes to confirm." >&2
  exit 1
fi
"$(dirname "${BASH_SOURCE[0]}")/build-lambda.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/qa"
terraform init
terraform apply -auto-approve
terraform output
