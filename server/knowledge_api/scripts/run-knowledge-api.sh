#!/usr/bin/env bash
# Bootstrap the Python Knowledge API (FastAPI + uvicorn) on the Mac mini.
# Invoked by the com.bambook.knowledge-api LaunchAgent.
# Port and host are overridable via BAMBOOK_KNOWLEDGE_API_PORT / BAMBOOK_KNOWLEDGE_API_HOST
# (the LaunchAgent sets both). Defaults match the documented canonical port 8091.
set -euo pipefail

APP_DIR="${BAMBOOK_KNOWLEDGE_API_DIR:-$HOME/bambook-knowledge-api}"

# Homebrew + user-local bins must precede system PATH so python/uvicorn resolve correctly.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Offline model hub — prevents HuggingFace from phoning home on every boot.
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_ENDPOINT=https://hf-mirror.com

cd "$APP_DIR"

# Activate the project venv if present (created by `python3 -m venv .venv`).
if [ -d "$APP_DIR/.venv" ]; then
  # shellcheck disable=SC1091
  source "$APP_DIR/.venv/bin/activate"
fi

# Layered env loading: .env.local overrides .env (secrets live in .env.local).
# This populates PORT/HOST from the on-disk config; the operator override
# (BAMBOOK_KNOWLEDGE_API_PORT / BAMBOOK_KNOWLEDGE_API_HOST from the LaunchAgent)
# is applied AFTER, so the plist takes precedence over .env.
if [ -f "$APP_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$APP_DIR/.env.local"
  set +a
fi
if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$APP_DIR/.env"
  set +a
fi

# Resolve final bind port/host with precedence:
#   1. BAMBOOK_KNOWLEDGE_API_PORT (operator override via LaunchAgent)
#   2. PORT (from .env config)
#   3. 8091 (canonical default)
PORT="${BAMBOOK_KNOWLEDGE_API_PORT:-${PORT:-8091}}"
HOST="${BAMBOOK_KNOWLEDGE_API_HOST:-${HOST:-127.0.0.1}}"

echo "[$(date '+%F %T')] [knowledge-api] starting uvicorn on $HOST:$PORT (HF_HUB_OFFLINE=$HF_HUB_OFFLINE, app dir=$APP_DIR)"

exec python -m uvicorn app.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers 1 \
  --proxy-headers \
  --log-level info
