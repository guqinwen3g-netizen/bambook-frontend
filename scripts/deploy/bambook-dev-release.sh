#!/bin/bash
set -euo pipefail
release=${1:?release directory required}
root=/srv/bambook-dev
keep_releases=4
[[ "$release" =~ ^/srv/bambook-dev/releases/[0-9a-f]{40}$ ]]
test -f "$release/.delivery.json"
environment=/etc/bambook-dev/backend.env
if [[ ! -r "$environment" ]]; then
  echo 'Bundle received. Application owner must configure /etc/bambook-dev/backend.env and the bambook-dev.service unit before activation.' >&2
  exit 2
fi
# The release pins the major Node version used by CI (.nvmrc); refuse to build with a different runtime.
expected_node=$(tr -d '[:space:]' < "$release/.nvmrc")
actual_node=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
if [[ ! "$expected_node" =~ ^[0-9]+$ || "$actual_node" != "$expected_node" ]]; then
  echo "Node $expected_node required by .nvmrc; server runtime is $(node --version)." >&2
  exit 1
fi
export NODE_ENV=production
cd "$release/server"
# Install and build before loading application secrets, so dependency install scripts never see them.
npm ci --include=dev --no-audit --no-fund
npm exec -- prisma generate
npm exec -- tsc --noEmit -p tsconfig.json
# The service runs with a read-only release tree; paths the API writes relative to server/ live in shared/ across releases.
for dir in logs storage data; do
  install -d -m 0750 "$root/shared/$dir"
  rm -rf "${release:?}/server/$dir"
  ln -sfn "$root/shared/$dir" "$release/server/$dir"
done
# index.ts writes generated files to <release>/output.
install -d -m 0750 "$root/shared/output"
rm -rf "${release:?}/output"
ln -sfn "$root/shared/output" "$release/output"
# Root-owned application configuration must contain shell-compatible KEY=value lines.
set -a
source "$environment"
set +a
: "${DATABASE_URL:?dedicated development database required}"
: "${JWT_SECRET:?development authentication secret required}"
: "${SYSTEM_CONFIG_ENCRYPTION_KEY:?configuration encryption key required}"
[[ "${MIST_LOCAL_WORKSPACE:-0}" != 1 ]]
[[ "${MIST_HOST:-127.0.0.1}" == 127.0.0.1 ]]
[[ "${BAMBOOK_HOST:-}" == 127.0.0.1 ]]
[[ "${PDML_SYNC_DISABLED:-}" == true ]]
# Schema changes remain an explicit application-owner action; delivery never pushes or resets a database.
previous=$(readlink "$root/current" || true)
ln -sfn "$release" "$root/.current-next"
mv -Tf "$root/.current-next" "$root/current"
rollback() {
  if [[ -n "$previous" ]]; then
    ln -sfn "$previous" "$root/.current-rollback"
    mv -Tf "$root/.current-rollback" "$root/current"
    sudo -n /usr/bin/systemctl restart bambook-dev.service || true
    sudo -n /usr/bin/systemctl restart bambook-dev-mist.service || true
  else
    rm -f "$root/current"
    sudo -n /usr/bin/systemctl stop bambook-dev.service || true
    sudo -n /usr/bin/systemctl stop bambook-dev-mist.service || true
  fi
}
# Keep the active and previous releases plus the newest few; each release carries its own node_modules.
prune() {
  local kept=0 candidate
  while IFS= read -r candidate; do
    [[ "$candidate" =~ ^$root/releases/[0-9a-f]{40}$ ]] || continue
    if [[ "$candidate" == "$release" || "$candidate" == "$previous" ]]; then continue; fi
    kept=$((kept + 1))
    if (( kept > keep_releases - 2 )); then rm -rf -- "$candidate"; fi
  done < <(ls -1dt "$root"/releases/*/ 2>/dev/null | sed 's#/$##')
}
if ! sudo -n /usr/bin/systemctl restart bambook-dev.service || ! sudo -n /usr/bin/systemctl restart bambook-dev-mist.service; then
  rollback
  exit 1
fi
# Main API (business, admin) and Mist workspace API must both report a healthy database connection.
healthy() {
  curl --fail --silent --max-time 3 "http://127.0.0.1:$1/api/health" > "$root/.health.json" && \
    /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("status")=="ok" and d.get("database")=="ok" and d.get("mode")!="local"' "$root/.health.json"
}
for attempt in $(seq 1 45); do
  if healthy "${PORT:-8081}" && healthy "${MIST_PORT:-8082}"; then
    echo "Activated $(basename "$release")"
    prune || echo 'Old release cleanup failed; activation is unaffected.' >&2
    exit 0
  fi
  sleep 2
done
rollback
echo 'Health verification failed; previous release restored when available.' >&2
exit 1
