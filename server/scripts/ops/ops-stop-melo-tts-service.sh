#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

log "Stopping Melo TTS service: $MELO_TTS_LABEL"
launchctl bootout "gui/$(id -u)/$MELO_TTS_LABEL" >/dev/null 2>&1 || true
printf 'MELO_TTS_LABEL=%s\n' "$MELO_TTS_LABEL"
