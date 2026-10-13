#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

require_dir "$SERVER_ROOT"
cd "$SERVER_ROOT"
load_env

log "Rolling back DEMO seed data"
npx tsx scripts/seed-demo-data.ts --rollback
