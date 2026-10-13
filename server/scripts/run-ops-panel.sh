#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${BAMBOOK_OPS_PANEL_DIR:-$HOME/bambook-main-api/ops-panel}"
SERVER_DIR="${BAMBOOK_MAIN_API_DIR:-$HOME/bambook-main-api}"
LOG_PREFIX="[bambook-ops-panel]"

export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$APP_DIR"

if [[ ! -f "$APP_DIR/.env.local" && ! -f "$SERVER_DIR/.env.local" && ! -f "$SERVER_DIR/.env" ]]; then
  echo "$LOG_PREFIX missing .env.local/.env with BAMBOOK_OPS_ADMIN_TOKEN" >&2
  exit 1
fi

set -a
[[ -f "$SERVER_DIR/.env.local" ]] && source "$SERVER_DIR/.env.local"
[[ -f "$SERVER_DIR/.env" ]] && source "$SERVER_DIR/.env"
[[ -f "$APP_DIR/.env.local" ]] && source "$APP_DIR/.env.local"
[[ -f "$APP_DIR/.env" ]] && source "$APP_DIR/.env"
set +a

if [[ -z "${BAMBOOK_OPS_ADMIN_TOKEN:-}" ]]; then
  echo "$LOG_PREFIX BAMBOOK_OPS_ADMIN_TOKEN is required" >&2
  exit 1
fi

npm install --include=dev
npm run build

export NODE_ENV="${NODE_ENV:-production}"
export BAMBOOK_OPS_PORT="${BAMBOOK_OPS_PORT:-8088}"

exec npm start
