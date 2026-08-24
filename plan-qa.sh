#!/usr/bin/env bash
# Build the lambda zips first so filebase64sha256() has something to hash.
# "$(dirname "${BASH_SOURCE[0]}")/build-lambda.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/qa"
sh ./plan.sh
