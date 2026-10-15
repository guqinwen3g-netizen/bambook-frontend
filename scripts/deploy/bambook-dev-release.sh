#!/bin/bash
set -euo pipefail
release=${1:?release directory required}
root=/srv/bambook-dev
[[ "$release" =~ ^/srv/bambook-dev/releases/[0-9a-f]{40}$ ]]
test -f "$release/.delivery.json"
environment=/etc/bambook-dev/backend.env
if [[ ! -r "$environment" ]]; then
  echo 'Bundle received. Application owner must configure /etc/bambook-dev/backend.env and the bambook-dev.service unit before activation.' >&2
  exit 2
fi
# Root-owned application configuration must contain shell-compatible KEY=value lines.
set -a
source "$environment"
set +a
: "${DATABASE_URL:?dedicated development database required}"
: "${JWT_SECRET:?development authentication secret required}"
[[ "${MIST_LOCAL_WORKSPACE:-0}" != 1 ]]
[[ "${MIST_HOST:-127.0.0.1}" == 127.0.0.1 ]]
export NODE_ENV=production
cd "$release/server"
npm ci --include=dev --no-audit --no-fund
npm exec -- prisma generate
npm run typecheck:mist
# Schema changes remain an explicit application-owner action; delivery never pushes or resets a database.
previous=$(readlink "$root/current" || true)
ln -s "$release" "$root/.current-next"
mv -Tf "$root/.current-next" "$root/current"
rollback() {
  if [[ -n "$previous" ]]; then
    ln -s "$previous" "$root/.current-rollback"
    mv -Tf "$root/.current-rollback" "$root/current"
    sudo -n /usr/bin/systemctl restart bambook-dev.service || true
  else
    rm -f "$root/current"
    sudo -n /usr/bin/systemctl stop bambook-dev.service || true
  fi
}
if ! sudo -n /usr/bin/systemctl restart bambook-dev.service; then
  rollback
  exit 1
fi
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8082/api/health > "$root/.health.json" && \
      /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("status")=="ok" and d.get("database")=="ok" and d.get("mode")!="local"' "$root/.health.json"; then
    echo "Activated $(basename "$release")"
    exit 0
  fi
  sleep 2
done
rollback
echo 'Health verification failed; previous release restored when available.' >&2
exit 1
