#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

require_dir "$SERVER_ROOT"
require_dir "$PANEL_ROOT"

download_tarball_update() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local url="${BAMBOOK_REPO_TARBALL_URL:-https://github.com/guqinwen3g-netizen/bambook/archive/refs/heads/main.tar.gz}"

  log "SERVER_ROOT is not a git repository; downloading GitHub tarball"
  curl -fL "$url" -o "$tmp_dir/bambook.tar.gz"
  tar -xzf "$tmp_dir/bambook.tar.gz" -C "$tmp_dir"

  local src_dir
  src_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name '*bambook*' | head -1)"
  if [[ -z "$src_dir" || ! -d "$src_dir/server/ops-panel" ]]; then
    echo "Downloaded archive does not contain server/ops-panel" >&2
    exit 1
  fi

  log "Replacing ops panel files from tarball"
  rm -rf "$PANEL_ROOT" "$SERVER_ROOT/scripts/ops"
  mkdir -p "$SERVER_ROOT/scripts" "$SERVER_ROOT/docs"
  cp -R "$src_dir/server/ops-panel" "$PANEL_ROOT"
  cp "$src_dir/server/scripts/run-ops-panel.sh" "$SERVER_ROOT/scripts/"
  cp "$src_dir/server/scripts/com.bambook.ops-panel.plist" "$SERVER_ROOT/scripts/"
  cp -R "$src_dir/server/scripts/ops" "$SERVER_ROOT/scripts/ops"
  cp "$src_dir/server/docs/ops-panel-runbook.md" "$SERVER_ROOT/docs/" 2>/dev/null || true
  chmod +x "$SERVER_ROOT/scripts/run-ops-panel.sh" "$SERVER_ROOT/scripts/ops/"*.sh
}

cd "$SERVER_ROOT"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "Fetching GitHub updates for ops panel"
  git fetch --prune
  current="$(git rev-parse --short HEAD)"
  remote="$(git rev-parse --short '@{u}')"
  log "Current commit: $current"
  log "Remote commit:  $remote"

  if [[ "$current" != "$remote" ]]; then
    git pull --ff-only
  fi
else
  download_tarball_update
fi

cd "$PANEL_ROOT"
log "Installing panel dependencies"
npm install --include=dev

log "Building panel"
npm run build

log "Scheduling ops panel restart after response flush"
(
  sleep 2
  launch_kickstart "$OPS_PANEL_LABEL"
) >/tmp/bambook-ops-panel-delayed-restart.log 2>&1 &

log "Panel deploy completed. Restart has been scheduled."
