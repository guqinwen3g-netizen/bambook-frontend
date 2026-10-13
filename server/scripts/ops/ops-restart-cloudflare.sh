#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

log "Removing duplicate cloudflared processes for current user"
# macOS 自带 bash 3.2 无 mapfile，用 while-read 兼容写法
pids=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] && pids+=("$pid")
done < <(pgrep -f 'cloudflared tunnel' || true)
if (( ${#pids[@]} > 1 )); then
  keep="${pids[0]}"
  for pid in "${pids[@]}"; do
    if [[ "$pid" != "$keep" ]]; then
      log "Stopping duplicate cloudflared pid=$pid"
      kill "$pid" || true
    fi
  done
fi

log "Restarting $CLOUDFLARE_LABEL"
launch_kickstart "$CLOUDFLARE_LABEL"

sleep 5
log "Current cloudflared process"
pgrep -lf cloudflared || true

if ! pgrep -lf cloudflared | grep -q -- '--protocol http2'; then
  echo "cloudflared is not running with --protocol http2" >&2
  exit 1
fi

log "Checking public API through Cloudflare"
curl -fsS --max-time 15 "$PUBLIC_API_URL"
printf '\n'
log "Cloudflare tunnel is healthy"
