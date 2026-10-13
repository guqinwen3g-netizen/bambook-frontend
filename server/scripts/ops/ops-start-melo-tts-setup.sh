#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

LOG_FILE="/tmp/bambook-melo-setup.log"
PID_FILE="/tmp/bambook-melo-setup.pid"

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Melo setup already running: pid=$existing_pid"
    echo "Log: $LOG_FILE"
    exit 0
  fi
fi

{
  printf '\n===== Melo setup started %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')"
} >> "$LOG_FILE"

nohup /bin/bash "$SCRIPT_DIR/ops-setup-melo-tts.sh" >> "$LOG_FILE" 2>&1 &
pid="$!"
echo "$pid" > "$PID_FILE"

echo "Melo setup started: pid=$pid"
echo "Log: $LOG_FILE"
