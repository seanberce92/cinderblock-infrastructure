#!/usr/bin/env bash
set -euo pipefail

# Package each Cinderblock worker Lambda into lambda.zip. The functions use the
# AWS SDK v3 that ships in the Node.js Lambda runtime, so there are no Lambda
# *code* dependencies to install — we just zip the source (.mjs + package.json
# + templates). site-builder and provisioner additionally shell out to the
# runtime's bundled npm at invocation time to build the generated Astro
# project (its own package.json is installed fresh into /tmp on each run, not
# bundled into the zip).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDAS_DIR="$ROOT_DIR/lambdas"

package() {
  local name="$1"; shift
  local dir="$LAMBDAS_DIR/$name"
  echo "Packaging $name..."
  rm -f "$dir/lambda.zip"
  ( cd "$dir" && zip -r lambda.zip "$@" > /dev/null )
  echo "  -> lambdas/$name/lambda.zip"
}

package site-builder index.mjs bedrock.mjs fetchContext.mjs googleBusinessData.mjs reviews.mjs validateLinks.mjs buildAstro.mjs prompts templates package.json
package cleanup     index.mjs package.json
package provisioner index.mjs buildAstro.mjs package.json
package reconciler  index.mjs package.json

echo "Done."
