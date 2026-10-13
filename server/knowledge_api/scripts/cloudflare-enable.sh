#!/usr/bin/env bash
set -euo pipefail

LABEL="com.cloudflare.bambook.api"
WATCHDOG_LABEL="com.cloudflare.bambook.watchdog"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="${SCRIPT_DIR}/run-cloudflared-tunnel.sh"
WATCHDOG_SCRIPT="${SCRIPT_DIR}/watch-cloudflared-tunnel.sh"
PLIST_TMPL="${SCRIPT_DIR}/com.cloudflare.bambook.api.plist"
WATCHDOG_PLIST_TMPL="${SCRIPT_DIR}/com.cloudflare.bambook.watchdog.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
WATCHDOG_PLIST_DST="${HOME}/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"

chmod +x "$RUN_SCRIPT"
chmod +x "$WATCHDOG_SCRIPT"

TOKEN_FILE="${HOME}/.cloudflared/bambook.tunnel.token"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing: $TOKEN_FILE" >&2
  echo "Paste Cloudflare tunnel token into that file (see docs/cloudflare-tunnel-setup.txt)." >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents"
sed "s|CHANGE_ME_HOME|${HOME}|g" "$PLIST_TMPL" >"$PLIST_DST"
sed "s|CHANGE_ME_HOME|${HOME}|g" "$WATCHDOG_PLIST_TMPL" >"$WATCHDOG_PLIST_DST"

if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi
if launchctl list 2>/dev/null | grep -q "$WATCHDOG_LABEL"; then
  launchctl unload "$WATCHDOG_PLIST_DST" 2>/dev/null || true
fi

launchctl load -w "$PLIST_DST"
launchctl start "$LABEL"
launchctl load -w "$WATCHDOG_PLIST_DST"
launchctl start "$WATCHDOG_LABEL"
echo "OK: LaunchAgent $LABEL"
echo "OK: LaunchAgent $WATCHDOG_LABEL"
echo "Logs: /tmp/cloudflared-bambook.log"
echo "Watchdog logs: /tmp/cloudflared-bambook-watchdog.log"
