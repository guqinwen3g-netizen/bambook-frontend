#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

MELO_VENV="${BAMBOOK_MELO_VENV:-$SERVER_ROOT/.venv-melo}"
MELO_PYTHON="${BAMBOOK_MELO_PYTHON:-$MELO_VENV/bin/python}"
MELO_PORT="${BAMBOOK_MELO_PORT:-8765}"
MELO_HOST="${BAMBOOK_MELO_HOST:-127.0.0.1}"
MELO_HF_ENDPOINT="${BAMBOOK_HF_ENDPOINT:-${HF_ENDPOINT:-https://hf-mirror.com}}"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENT_DIR/$MELO_TTS_LABEL.plist"
LOG_FILE="${BAMBOOK_MELO_TTS_LOG:-/tmp/bambook-melo-tts-service.log}"
ERROR_LOG_FILE="${BAMBOOK_MELO_TTS_ERROR_LOG:-/tmp/bambook-melo-tts-service.err.log}"

write_main_env() {
  local env_path="$SERVER_ROOT/.env.local"
  local tmp_path
  tmp_path="$(mktemp)"

  touch "$env_path"
  grep -vE '^(BAMBOOK_TTS_PROVIDER|BAMBOOK_MELO_PYTHON|BAMBOOK_MELO_HOST|BAMBOOK_MELO_PORT|BAMBOOK_MELO_LANGUAGE|BAMBOOK_MELO_SPEAKER|BAMBOOK_MELO_MODE|BAMBOOK_MELO_URL|BAMBOOK_MELO_PREWARM_ON_START|BAMBOOK_MELO_REQUEST_TIMEOUT_MS|BAMBOOK_HF_ENDPOINT|HF_ENDPOINT|TOKENIZERS_PARALLELISM|HF_HUB_DISABLE_XET|HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE)=' "$env_path" > "$tmp_path" || true
  {
    cat "$tmp_path"
    printf '\nBAMBOOK_TTS_PROVIDER=melo\n'
    printf 'BAMBOOK_MELO_PYTHON=%s\n' "$MELO_PYTHON"
    printf 'BAMBOOK_MELO_HOST=%s\n' "$MELO_HOST"
    printf 'BAMBOOK_MELO_PORT=%s\n' "$MELO_PORT"
    printf 'BAMBOOK_MELO_URL=http://%s:%s\n' "$MELO_HOST" "$MELO_PORT"
    printf 'BAMBOOK_MELO_PREWARM_ON_START=true\n'
    printf 'BAMBOOK_MELO_REQUEST_TIMEOUT_MS=240000\n'
    printf 'BAMBOOK_HF_ENDPOINT=%s\n' "$MELO_HF_ENDPOINT"
    printf 'HF_ENDPOINT=%s\n' "$MELO_HF_ENDPOINT"
    printf 'TOKENIZERS_PARALLELISM=false\n'
    printf 'HF_HUB_DISABLE_XET=1\n'
    printf 'HF_HUB_OFFLINE=0\n'
    printf 'TRANSFORMERS_OFFLINE=0\n'
  } > "$env_path"
  rm -f "$tmp_path"
  chmod 600 "$env_path"
}

ensure_nltk_resources() {
  log "Ensuring optional NLTK resources for Melo"
  "$MELO_PYTHON" <<'PY'
import nltk

resources = [
    ("corpora/cmudict.zip", "cmudict"),
    ("taggers/averaged_perceptron_tagger.zip", "averaged_perceptron_tagger"),
    ("taggers/averaged_perceptron_tagger_eng", "averaged_perceptron_tagger_eng"),
]

for resource_path, package_name in resources:
    try:
        nltk.data.find(resource_path)
        print(f"NLTK resource already available: {package_name}", flush=True)
    except LookupError:
        print(f"Downloading NLTK resource: {package_name}", flush=True)
        nltk.download(package_name, quiet=True)
PY
}

if [[ ! -x "$MELO_PYTHON" ]]; then
  echo "Melo python not found: $MELO_PYTHON" >&2
  echo "Run ops-setup-melo-tts.sh first." >&2
  exit 1
fi

if [[ ! -f "$SERVER_ROOT/scripts/melo_tts_service.py" ]]; then
  echo "Melo service script not found: $SERVER_ROOT/scripts/melo_tts_service.py" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENT_DIR"
ensure_nltk_resources

log "Stopping previous Melo TTS service if present"
launchctl bootout "gui/$(id -u)/$MELO_TTS_LABEL" >/dev/null 2>&1 || true
sleep 2

if command -v lsof >/dev/null 2>&1; then
  existing_pids="$(lsof -tiTCP:"$MELO_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$existing_pids" ]]; then
    log "Stopping existing listener on $MELO_HOST:$MELO_PORT: $existing_pids"
    for pid in $existing_pids; do
      command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$command_line" == *"melo_tts_service.py"* ]]; then
        kill "$pid" >/dev/null 2>&1 || true
      else
        echo "Port $MELO_PORT is used by non-Melo process: $command_line" >&2
        exit 1
      fi
    done
    sleep 1
  fi
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$MELO_TTS_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$MELO_PYTHON</string>
    <string>$SERVER_ROOT/scripts/melo_tts_service.py</string>
    <string>--host</string>
    <string>$MELO_HOST</string>
    <string>--port</string>
    <string>$MELO_PORT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SERVER_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
    <key>TOKENIZERS_PARALLELISM</key>
    <string>false</string>
    <key>HF_HUB_DISABLE_XET</key>
    <string>1</string>
    <key>HF_HUB_OFFLINE</key>
    <string>0</string>
    <key>TRANSFORMERS_OFFLINE</key>
    <string>0</string>
    <key>HF_ENDPOINT</key>
    <string>$MELO_HF_ENDPOINT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$ERROR_LOG_FILE</string>
</dict>
</plist>
PLIST

chmod 644 "$PLIST_PATH"

log "Starting Melo TTS LaunchAgent: $MELO_TTS_LABEL"
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"; then
  log "launchctl bootstrap failed; trying kickstart for existing service label"
  launchctl kickstart -k "gui/$(id -u)/$MELO_TTS_LABEL" >/dev/null 2>&1 || true
fi

deadline=$((SECONDS + ${BAMBOOK_MELO_SERVICE_STARTUP_TIMEOUT_SECONDS:-180}))
until curl -fsS "http://$MELO_HOST:$MELO_PORT/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "Melo TTS service did not become healthy in time." >&2
    echo "stdout log: $LOG_FILE" >&2
    echo "stderr log: $ERROR_LOG_FILE" >&2
    tail -80 "$LOG_FILE" 2>/dev/null || true
    tail -80 "$ERROR_LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

log "Melo TTS service healthy: http://$MELO_HOST:$MELO_PORT"
log "Writing main API Melo runtime environment"
write_main_env
log "Restarting main API to use persistent Melo service"
launch_kickstart "$MAIN_API_LABEL"
printf 'MELO_TTS_LABEL=%s\n' "$MELO_TTS_LABEL"
printf 'MELO_TTS_URL=http://%s:%s\n' "$MELO_HOST" "$MELO_PORT"
