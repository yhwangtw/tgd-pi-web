#!/usr/bin/env bash
# Read-only preflight by default; --dispatch opts into the canonical workflow.
# Never build or version a live checkout.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for arg in "$@"; do
  if [[ "$arg" == "--deploy" ]]; then
    exec node "$SCRIPT_DIR/release-pipeline.mjs" "$@"
  fi
done
exec node "$SCRIPT_DIR/release.mjs" "$@"
