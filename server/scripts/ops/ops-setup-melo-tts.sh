#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

MELO_VENV="${BAMBOOK_MELO_VENV:-$SERVER_ROOT/.venv-melo}"
MELO_PYTHON="$MELO_VENV/bin/python"
MELO_HF_ENDPOINT="${BAMBOOK_HF_ENDPOINT:-${HF_ENDPOINT:-https://hf-mirror.com}}"
PREWARM_WAV="/tmp/bambook-melo-prewarm.wav"
MELOTTS_PACKAGE="${BAMBOOK_MELOTTS_PACKAGE:-git+https://github.com/myshell-ai/MeloTTS.git@209145371cff8fc3bd60d7be902ea69cbdb7965a}"

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    return
  fi

  log "uv not found; installing uv for current user"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"

  if ! command -v uv >/dev/null 2>&1; then
    echo "uv install failed; uv is still not on PATH" >&2
    exit 1
  fi
}

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
    printf 'BAMBOOK_MELO_HOST=127.0.0.1\n'
    printf 'BAMBOOK_MELO_PORT=8765\n'
    printf 'BAMBOOK_MELO_URL=http://127.0.0.1:8765\n'
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

prewarm_melo_with_timeout() {
  local timeout_seconds="${BAMBOOK_MELO_SETUP_PREWARM_TIMEOUT_SECONDS:-240}"
  local prewarm_pid

  "$MELO_PYTHON" "$SERVER_ROOT/scripts/melo_tts.py" <<JSON &
{"input":"Melo 语音预热完成。","outputPath":"$PREWARM_WAV","speed":1.0}
JSON
  prewarm_pid=$!

  for _ in $(seq 1 "$timeout_seconds"); do
    if ! kill -0 "$prewarm_pid" >/dev/null 2>&1; then
      wait "$prewarm_pid"
      return $?
    fi
    sleep 1
  done

  kill "$prewarm_pid" >/dev/null 2>&1 || true
  wait "$prewarm_pid" >/dev/null 2>&1 || true
  return 124
}

log "Installing Melo TTS into $MELO_VENV"
ensure_uv

uv venv --clear --python 3.11 "$MELO_VENV"

log "Installing Melo dependencies"
git config --global http.version HTTP/1.1
git config --global http.postBuffer 524288000

for attempt in 1 2 3; do
  if uv pip install --python "$MELO_PYTHON" \
    "torch==2.12.0" \
    "torchaudio==2.11.0" \
    "unidic-lite==1.0.8" \
    "$MELOTTS_PACKAGE"; then
    break
  fi

  if [[ "$attempt" == "3" ]]; then
    echo "Melo dependency install failed after 3 attempts" >&2
    exit 1
  fi

  log "Melo dependency install failed; clearing uv git cache and retrying ($attempt/3)"
  rm -rf "$HOME/.cache/uv/git-v0" || true
  sleep $((attempt * 10))
done

log "Ensuring MeCab dictionary"
"$MELO_PYTHON" <<'PY'
from pathlib import Path
import shutil

import unidic
import unidic_lite

target = Path(unidic.DICDIR)
source = Path(unidic_lite.DICDIR)

if not (target / "mecabrc").exists():
    if target.exists() or target.is_symlink():
        if target.is_symlink() or target.is_file():
            target.unlink()
        else:
            shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    print(f"Copied unidic_lite dictionary to {target}", flush=True)
else:
    print(f"MeCab dictionary already available at {target}", flush=True)
PY

ensure_nltk_resources
write_main_env

if [[ "${BAMBOOK_MELO_INSTALL_SERVICE:-1}" == "1" ]]; then
  log "Installing Melo TTS LaunchAgent"
  /bin/bash "$SCRIPT_DIR/ops-install-melo-tts-service.sh"
else
  log "Skipping Melo TTS LaunchAgent install"
fi

log "Restarting main API"
launch_kickstart "$MAIN_API_LABEL"

if [[ "${BAMBOOK_MELO_SETUP_PREWARM:-0}" == "1" ]]; then
  log "Prewarming Melo model"
  export HF_HUB_DISABLE_XET=1
  export HF_ENDPOINT="$MELO_HF_ENDPOINT"
  unset HF_HUB_OFFLINE
  unset TRANSFORMERS_OFFLINE
  if prewarm_melo_with_timeout; then
    if [[ -s "$PREWARM_WAV" ]]; then
      log "Melo prewarm generated $PREWARM_WAV"
    else
      log "Melo prewarm finished without audio; main API remains configured"
    fi
  else
    log "Melo prewarm timed out or failed; main API remains configured and runtime will retry on request"
  fi
else
  log "Skipping standalone Melo prewarm; main API is configured to use the persistent Melo service"
fi

log "Melo TTS setup complete"
printf 'MELO_PYTHON=%s\n' "$MELO_PYTHON"
printf 'PREWARM_WAV=%s\n' "$PREWARM_WAV"
