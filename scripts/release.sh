#!/usr/bin/env bash
# Read-only preflight by default; --dispatch opts into the canonical workflow.
# Never build or version a live checkout.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/release.mjs" "$@"
