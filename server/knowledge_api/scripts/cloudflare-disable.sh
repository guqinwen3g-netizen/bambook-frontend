#!/usr/bin/env bash
set -euo pipefail

LABEL="com.cloudflare.bambook.api"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ -f "$PLIST_DST" ]]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm -f "$PLIST_DST"
fi

echo "Stopped and removed LaunchAgent (if it existed): $LABEL"
