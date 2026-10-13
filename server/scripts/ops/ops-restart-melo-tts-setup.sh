#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

PID_FILE="/tmp/bambook-melo-setup.pid"

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "Stopping existing Melo setup: pid=$existing_pid"
    kill "$existing_pid" 2>/dev/null || true
    sleep 2
    if kill -0 "$existing_pid" 2>/dev/null; then
      kill -9 "$existing_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

exec /bin/bash "$SCRIPT_DIR/ops-start-melo-tts-setup.sh"
