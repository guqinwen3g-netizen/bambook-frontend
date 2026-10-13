#!/usr/bin/env bash
# Deprecated name kept for npm script compatibility.
# This preview runs the UI locally, but all Bambook accounts, sessions,
# Agent runtime, knowledge, orders, relations, and product data must come from
# the Bambook data center. No local backend or local business database is
# started here.

set -euo pipefail

MODE="${1:-web}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

unset ELECTRON_RUN_AS_NODE
unset BAMBOOK_AGENT_DATA_API_BASE
unset BAMBOOK_AGENT_DATA_API_KEY

export VITE_API_BASE_URL="${VITE_API_BASE_URL:-https://jiangsupanda.com/bambook/api}"
export VITE_CLOUD_ENDPOINT="${VITE_CLOUD_ENDPOINT:-https://jiangsupanda.com/bambook}"

echo ">>> [agent-preview] 本地只运行前端"
echo ">>> [agent-preview] Bambook data/account/Agent API: $VITE_API_BASE_URL"
echo ">>> [agent-preview] 不启动本地后端，不使用本地业务数据库"

if [ "$MODE" = "web" ]; then
  pkill -f "apps/Bambook/node_modules/.bin/vite" 2>/dev/null || true
fi

if [ "$MODE" = "electron" ]; then
  echo ">>> [agent-preview] 启动 Electron with data-center Agent Runtime"
  exec npm run electron:dev
fi

echo ">>> [agent-preview] 启动 Web dev with data-center Agent Runtime"
exec npm run dev
