#!/usr/bin/env bash
# Seed RBAC tables (Role, Permission, RolePermission, Department, owner UserAccount).
# Idempotent — safe to re-run.
set -euo pipefail
source "$(dirname "$0")/_common.sh"
load_env

cd "$SERVER_ROOT"

log "Seeding RBAC tables..."
npx tsx scripts/seed-rbac.ts

log "Restarting main API..."
launch_kickstart "$MAIN_API_LABEL"

log "Done."
