#!/usr/bin/env bash
set -euo pipefail

LABEL="${BAMBOOK_CLOUDFLARE_LABEL:-com.cloudflare.bambook.api}"
PUBLIC_API_URL="${BAMBOOK_PUBLIC_API_URL:-https://jiangsupanda.com/bambook/api/health}"
LOCAL_API_URL="${BAMBOOK_LOCAL_API_URL:-http://127.0.0.1:8081/api/health}"
LOG_FILE="${BAMBOOK_CLOUDFLARE_WATCHDOG_LOG:-/tmp/cloudflared-bambook-watchdog.log}"
LAST_RESTART_FILE="${BAMBOOK_CLOUDFLARE_LAST_RESTART_FILE:-/tmp/cloudflared-bambook-watchdog.last-restart}"
RESTART_COOLDOWN_SECONDS="${BAMBOOK_CLOUDFLARE_RESTART_COOLDOWN_SECONDS:-120}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"
}

if ! curl -fsS --max-time 8 "$LOCAL_API_URL" >/dev/null; then
  log "local API is not healthy; skip tunnel restart to avoid masking backend failure"
  exit 0
fi

if curl -fsS --max-time 12 "$PUBLIC_API_URL" >/dev/null; then
  exit 0
fi

now="$(date +%s)"
last_restart="0"
if [[ -f "$LAST_RESTART_FILE" ]]; then
  last_restart="$(cat "$LAST_RESTART_FILE" 2>/dev/null || echo 0)"
fi

if [[ "$last_restart" =~ ^[0-9]+$ ]] && (( now - last_restart < RESTART_COOLDOWN_SECONDS )); then
  log "public API failed but tunnel restart is cooling down (${now}-${last_restart}<${RESTART_COOLDOWN_SECONDS})"
  exit 0
fi

log "public API failed; restarting $LABEL"
printf '%s\n' "$now" >"$LAST_RESTART_FILE"
launchctl kickstart -k "gui/$(id -u)/$LABEL" >>"$LOG_FILE" 2>&1 || {
  log "kickstart failed for $LABEL"
  exit 1
}

sleep 8

if curl -fsS --max-time 12 "$PUBLIC_API_URL" >/dev/null; then
  log "public API recovered after tunnel restart"
  exit 0
fi

log "public API still failing after tunnel restart"
exit 1
