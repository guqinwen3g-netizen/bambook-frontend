#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

if ! launchctl list | grep -q "$MELO_TTS_LABEL"; then
  exec /bin/bash "$SCRIPT_DIR/ops-install-melo-tts-service.sh"
fi

log "Restarting Melo TTS service: $MELO_TTS_LABEL"
launchctl kickstart -k "gui/$(id -u)/$MELO_TTS_LABEL"

MELO_HOST="${BAMBOOK_MELO_HOST:-127.0.0.1}"
MELO_PORT="${BAMBOOK_MELO_PORT:-8765}"
deadline=$((SECONDS + ${BAMBOOK_MELO_SERVICE_STARTUP_TIMEOUT_SECONDS:-180}))
until curl -fsS "http://$MELO_HOST:$MELO_PORT/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "Melo TTS service did not become healthy in time." >&2
    exit 1
  fi
  sleep 2
done

log "Melo TTS service healthy: http://$MELO_HOST:$MELO_PORT"
