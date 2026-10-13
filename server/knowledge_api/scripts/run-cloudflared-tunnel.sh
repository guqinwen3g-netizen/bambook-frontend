#!/usr/bin/env bash
set -euo pipefail

TOKEN_FILE="${HOME}/.cloudflared/bambook.tunnel.token"
CF_BIN="$(command -v cloudflared || true)"
if [[ -z "$CF_BIN" ]]; then
  if [[ -x "/opt/homebrew/bin/cloudflared" ]]; then
    CF_BIN="/opt/homebrew/bin/cloudflared"
  elif [[ -x "/opt/homebrew/opt/cloudflared/bin/cloudflared" ]]; then
    CF_BIN="/opt/homebrew/opt/cloudflared/bin/cloudflared"
  else
    echo "cloudflared not found. Install: brew install cloudflared" >&2
    exit 1
  fi
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing token file: $TOKEN_FILE" >&2
  echo "Create it with your Cloudflare tunnel token (see docs/cloudflare-tunnel-setup.txt)." >&2
  exit 1
fi

TOKEN="$(tr -d ' \n\r\t' <"$TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "Token file is empty: $TOKEN_FILE" >&2
  exit 1
fi

exec "$CF_BIN" tunnel --no-autoupdate --protocol http2 run --token "$TOKEN"
