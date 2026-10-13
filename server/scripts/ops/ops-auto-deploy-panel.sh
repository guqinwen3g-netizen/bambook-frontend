#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

STATE_FILE="${BAMBOOK_OPS_PANEL_AUTO_STATE:-/tmp/bambook-ops-panel-main.sha}"
LOCK_DIR="${BAMBOOK_OPS_PANEL_AUTO_LOCK:-/tmp/bambook-ops-panel-auto.lock}"
LOG_FILE="${BAMBOOK_OPS_PANEL_AUTO_LOG:-/tmp/bambook-ops-panel-auto.log}"
REPO_API="${BAMBOOK_REPO_COMMITS_API:-https://api.github.com/repos/guqinwen3g-netizen/bambook/commits/main}"

exec >>"$LOG_FILE" 2>&1

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "Auto deploy already running; skip"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

latest_sha="$(curl -fsSL "$REPO_API" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')"
current_sha="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [[ -z "$latest_sha" ]]; then
  echo "Could not resolve latest GitHub sha" >&2
  exit 1
fi

if [[ "$latest_sha" == "$current_sha" ]]; then
  log "Ops panel already current: ${latest_sha:0:12}"
  exit 0
fi

log "New ops panel version detected: ${current_sha:-none} -> $latest_sha"
bash "$SCRIPT_DIR/ops-deploy-panel.sh"
printf '%s\n' "$latest_sha" > "$STATE_FILE"
log "Auto deploy completed: ${latest_sha:0:12}"
