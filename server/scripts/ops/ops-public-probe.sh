#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

LOG_FILE="${BAMBOOK_OPS_PUBLIC_PROBE_LOG:-/tmp/bambook-public-probe.log}"
TMP_BODY="$(mktemp -t bambook-public-probe.XXXXXX)"
trap 'rm -f "$TMP_BODY"' EXIT

probe_url() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local status elapsed ok

  status="$(curl -sS --max-time 15 -o "$TMP_BODY" -w '%{http_code} %{time_total}' "$url" 2>/dev/null || printf '000 0')"
  elapsed="${status#* }"
  status="${status%% *}"
  ok=false
  if [[ "$status" == "$expected" ]]; then
    ok=true
  fi

  printf '{"at":"%s","name":"%s","url":"%s","status":%s,"expected":%s,"elapsedSeconds":%s,"ok":%s}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$name" \
    "$url" \
    "$status" \
    "$expected" \
    "$elapsed" \
    "$ok" | tee -a "$LOG_FILE"

  [[ "$ok" == true ]]
}

failures=0
probe_url "public_api" "$PUBLIC_API_URL" 200 || failures=$((failures + 1))
probe_url "public_knowledge" "$PUBLIC_KNOWLEDGE_URL" 200 || failures=$((failures + 1))
probe_url "public_ops" "$PUBLIC_OPS_URL" 200 || failures=$((failures + 1))
probe_url "retired_ops" "$RETIRED_OPS_URL" 404 || failures=$((failures + 1))
probe_url "retired_webapp" "$RETIRED_WEBAPP_URL" 404 || failures=$((failures + 1))

if (( failures > 0 )); then
  log "Bambook public probe failed: ${failures} check(s) mismatched"
  exit 1
fi

log "Bambook public probe completed"
