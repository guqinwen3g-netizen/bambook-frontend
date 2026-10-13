#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

COMMON_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "$COMMON_SCRIPT_DIR/../../.." && pwd)"
SERVER_ROOT="${SERVER_ROOT:-$HOME/bambook-main-api}"
if [[ -d "$SERVER_ROOT/.." ]]; then
  REPO_ROOT="${REPO_ROOT:-$(cd "$SERVER_ROOT/.." && pwd)}"
else
  REPO_ROOT="${REPO_ROOT:-$DEFAULT_REPO_ROOT}"
fi
PANEL_ROOT="${PANEL_ROOT:-$SERVER_ROOT/ops-panel}"
MAIN_API_LABEL="${BAMBOOK_MAIN_API_LABEL:-com.bambook.main-data-api}"
MELO_TTS_LABEL="${BAMBOOK_MELO_TTS_LABEL:-com.bambook.melo-tts}"
CLOUDFLARE_LABEL="${BAMBOOK_CLOUDFLARE_LABEL:-com.cloudflare.bambook.api}"
OPS_PANEL_LABEL="${BAMBOOK_OPS_PANEL_LABEL:-com.bambook.ops-panel}"
MAIN_API_URL="${BAMBOOK_OPS_MAIN_API_URL:-http://127.0.0.1:8081/api/health}"
KNOWLEDGE_API_URL="${BAMBOOK_OPS_KNOWLEDGE_API_URL:-http://127.0.0.1:8091/bambook/kb/health}"
LOCAL_PUBLIC_API_URL="${BAMBOOK_OPS_LOCAL_PUBLIC_API_URL:-http://127.0.0.1:8091/bambook/kb/health}"
PUBLIC_API_URL="${BAMBOOK_OPS_PUBLIC_API_URL:-https://jiangsupanda.com/bambook/api/health}"
PUBLIC_KNOWLEDGE_URL="${BAMBOOK_OPS_PUBLIC_KNOWLEDGE_URL:-https://jiangsupanda.com/bambook/kb/health}"
PUBLIC_OPS_URL="${BAMBOOK_OPS_PUBLIC_OPS_URL:-https://ops.jiangsupanda.com/ops/}"
RETIRED_OPS_URL="${BAMBOOK_OPS_RETIRED_OPS_URL:-https://jiangsupanda.com/bambook/ops/}"
RETIRED_WEBAPP_URL="${BAMBOOK_OPS_RETIRED_WEBAPP_URL:-https://jiangsupanda.com/bambookos/}"
BACKUP_DIR="${BAMBOOK_BACKUP_DIR:-/Users/Shared/BambookBackups}"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

load_env() {
  set -a
  [[ -f "$SERVER_ROOT/.env.local" ]] && source "$SERVER_ROOT/.env.local"
  [[ -f "$SERVER_ROOT/.env" ]] && source "$SERVER_ROOT/.env"
  [[ -f "$PANEL_ROOT/.env.local" ]] && source "$PANEL_ROOT/.env.local"
  [[ -f "$PANEL_ROOT/.env" ]] && source "$PANEL_ROOT/.env"
  set +a
}

launch_kickstart() {
  local label="$1"
  launchctl kickstart -k "gui/$(id -u)/$label"
}

require_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "Missing directory: $dir" >&2
    exit 1
  fi
}
