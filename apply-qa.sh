#!/usr/bin/env bash
"$(dirname "${BASH_SOURCE[0]}")/build-lambda.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/qa"
sh ./apply.sh
