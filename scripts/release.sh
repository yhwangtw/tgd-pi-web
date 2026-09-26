#!/usr/bin/env bash
# Preflight by default; publication and deployment require explicit flags.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/release-entry.mjs" "$@"
