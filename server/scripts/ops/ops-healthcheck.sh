#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

LOG_FILE="/tmp/bambook-ops-healthcheck.log"
exec > >(tee -a "$LOG_FILE") 2>&1

check_url() {
  local name="$1"
  local url="$2"
  log "Checking $name: $url"
  curl -fsS --max-time 10 "$url"
  printf '\n'
}

log "Bambook ops healthcheck started"
check_url "main api" "$MAIN_API_URL"
check_url "knowledge api" "$KNOWLEDGE_API_URL"
check_url "local public api origin" "$LOCAL_PUBLIC_API_URL"
check_url "public api" "$PUBLIC_API_URL"

log "Checking cloudflared process"
pgrep -lf cloudflared || true
if ! pgrep -lf cloudflared | grep -q -- '--protocol http2'; then
  echo "WARN: cloudflared is not running with --protocol http2" >&2
fi

log "Checking launch agents"
launchctl list | grep -E 'com\.bambook|com\.cloudflare\.bambook' || true

log "Checking disk"
df -h /

log "Checking recent backups"
ls -lt "$BACKUP_DIR" 2>/dev/null | head -10 || true

log "Bambook ops healthcheck completed"
