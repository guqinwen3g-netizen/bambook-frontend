#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

require_dir "$SERVER_ROOT"
cd "$SERVER_ROOT"
load_env

log "Running DEMO seed dry-run"
npx tsx scripts/seed-demo-data.ts --dry-run
