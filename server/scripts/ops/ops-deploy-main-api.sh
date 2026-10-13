#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

require_dir "$SERVER_ROOT"
cd "$SERVER_ROOT"
load_env

log "Fetching GitHub updates"
git fetch --prune
current="$(git rev-parse --short HEAD)"
remote="$(git rev-parse --short '@{u}')"
log "Current commit: $current"
log "Remote commit:  $remote"

if [[ "$current" == "$remote" ]]; then
  log "Already up to date"
else
  log "Pulling with fast-forward only"
  git pull --ff-only
fi

log "Installing dependencies"
npm install --include=dev

log "Applying Prisma migrations"
npx prisma migrate deploy
npx prisma generate

log "Building server"
npm run build

log "Restarting main API"
launch_kickstart "$MAIN_API_LABEL"

log "Waiting for health"
for i in {1..45}; do
  if curl -fsS --max-time 5 "$MAIN_API_URL"; then
    printf '\n'
    log "Deploy completed"
    exit 0
  fi
  sleep 2
done

echo "Deploy finished but health check failed" >&2
exit 1
