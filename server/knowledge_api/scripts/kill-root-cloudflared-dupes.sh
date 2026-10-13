#!/bin/sh
# Kill only cloudflared processes running as root (duplicate replicas vs LaunchAgent).
# Install to /usr/local/sbin/ and grant NOPASSWD to this path only (see docs/sudo-nopasswd-cloudflared.txt).
set -eu
killed=0
for pid in $(pgrep -x cloudflared 2>/dev/null || true); do
  u=$(ps -p "$pid" -o user= 2>/dev/null | tr -d " \t" || true)
  if [ "$u" = "root" ]; then
    kill "$pid" 2>/dev/null || true
    killed=$((killed + 1))
  fi
done
echo "killed_root_cloudflared=$killed"
