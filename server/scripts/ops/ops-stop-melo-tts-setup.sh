#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/bambook-melo-setup.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No Melo setup pid file."
  exit 0
fi

existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$existing_pid" ]]; then
  rm -f "$PID_FILE"
  echo "Empty Melo setup pid file removed."
  exit 0
fi

if kill -0 "$existing_pid" 2>/dev/null; then
  echo "Stopping Melo setup: pid=$existing_pid"
  kill "$existing_pid" 2>/dev/null || true
  sleep 2
  if kill -0 "$existing_pid" 2>/dev/null; then
    kill -9 "$existing_pid" 2>/dev/null || true
  fi
else
  echo "Melo setup pid is not running: pid=$existing_pid"
fi

rm -f "$PID_FILE"
