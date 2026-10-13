#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

log "Restarting $MAIN_API_LABEL"
launch_kickstart "$MAIN_API_LABEL"

log "Waiting for main API health"
for i in {1..45}; do
  if curl -fsS --max-time 5 "$MAIN_API_URL"; then
    printf '\n'
    log "Main API is healthy"
    exit 0
  fi
  sleep 2
done

echo "Main API did not become healthy in time" >&2
exit 1
