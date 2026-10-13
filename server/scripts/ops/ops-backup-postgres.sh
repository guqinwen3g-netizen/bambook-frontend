#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"
load_env

require_dir "$SERVER_ROOT"
mkdir -p "$BACKUP_DIR"

if [[ -x "$SERVER_ROOT/scripts/backup-postgres.sh" ]]; then
  log "Running existing backup script"
  cd "$SERVER_ROOT"
  BAMBOOK_BACKUP_DIR="$BACKUP_DIR" bash "$SERVER_ROOT/scripts/backup-postgres.sh"
else
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required for backup" >&2
    exit 1
  fi
  stamp="$(date '+%Y%m%d-%H%M%S')"
  file="$BACKUP_DIR/bambook-postgres-$stamp.dump"
  log "Running pg_dump to $file"
  pg_dump "$DATABASE_URL" --format=custom --file="$file"
fi

log "Recent backups"
ls -lh "$BACKUP_DIR" | tail -10
