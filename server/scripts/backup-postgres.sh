#!/usr/bin/env bash
# Bambook PostgreSQL 定时备份（launchd 每日 02:00 调用，也可手动执行）
# - pg_dump custom format（-Fc），输出 bambook-YYYYMMDD-HHmmss.dump
# - 备份目录 /Users/Shared/BambookBackups（BAMBOOK_BACKUP_DIR 可覆盖），不存在时自动创建
# - 保留 7 天（BAMBOOK_BACKUP_RETENTION_DAYS 可覆盖），到期自动清理
# - 日志带时间戳，同时写 stdout 与 $BACKUP_DIR/backup.log
#
# 连接方式（二选一）：
#   1. DATABASE_URL 已设置（如经 OPS Panel 手动触发，env 已从 server .env 加载）：
#      直接使用，自动剥掉 Prisma 专有 ?schema= 参数
#   2. 未设置（launchd 定时触发场景）：从脚本上一级目录的 .env 提取 DATABASE_URL
#      （grep 单行提取而非 source 全文件，避免 .env 其他行的副作用）；
#      再回退 localhost:5432，用户 postgres，库名 pandahub
#      （BAMBOOK_BACKUP_DB 可覆盖；PGHOST/PGPORT/PGUSER 同 libpq 惯例）
#      若 postgres 用户设了密码，从环境变量 PGPASSWORD 读（勿写进脚本/plist，
#      生产建议用 ~/.pgpass，权限 600）
set -euo pipefail

# launchd 环境 PATH 极简，补齐 nvm node 与 homebrew（pg_dump/pg_restore）路径
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# launchd 场景补齐 DATABASE_URL：仅从 .env 提取该行（去首尾引号）
if [[ -z "${DATABASE_URL:-}" ]]; then
  ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
  if [[ -f "$ENV_FILE" ]]; then
    EXTRACTED="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    if [[ -n "$EXTRACTED" ]]; then
      DATABASE_URL="$EXTRACTED"
      export DATABASE_URL
    fi
  fi
fi

BACKUP_DIR="${BAMBOOK_BACKUP_DIR:-/Users/Shared/BambookBackups}"
LOG_FILE="$BACKUP_DIR/backup.log"
RETENTION_DAYS="${BAMBOOK_BACKUP_RETENTION_DAYS:-7}"
DB_NAME="${BAMBOOK_BACKUP_DB:-pandahub}"

mkdir -p "$BACKUP_DIR"
touch "$LOG_FILE"

# launchd 会把 stdout 重定向到 backup.log：此时不再重复 append。
# macOS 的 /dev/stdout 设备号是 fd 合成值，-ef 不可用；stat -L 解析后的 inode 与目标文件一致，按 inode 判定。
# 注意：命令替换内 fd 1 是替换管道，须先把真实 stdout 复制到 fd 9 再取 inode。
LOG_TO_FILE=1
exec 9>&1
if [[ "$(stat -L -f '%i' /dev/fd/9 2>/dev/null || echo '')" == "$(stat -f '%i' "$LOG_FILE")" ]]; then
  LOG_TO_FILE=0
fi
exec 9>&-

log() {
  local line
  line="$(printf '[%s] %s' "$(date '+%Y-%m-%d %H:%M:%S')" "$*")"
  printf '%s\n' "$line"
  if [[ "$LOG_TO_FILE" == "1" ]]; then
    printf '%s\n' "$line" >>"$LOG_FILE"
  fi
}

fail() {
  log "ERROR: $*"
  exit 1
}

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/bambook-$STAMP.dump"

if [[ -n "${DATABASE_URL:-}" ]]; then
  # 连接串含密码，日志只标记来源不打印内容
  TARGET="DATABASE_URL"
else
  TARGET="${PGUSER:-postgres}@${PGHOST:-localhost}:${PGPORT:-5432}/$DB_NAME"
fi
log "backup start: target=$TARGET out=$OUT"

if [[ -n "${DATABASE_URL:-}" ]]; then
  # Prisma 接受 ?schema=public，pg_dump 不认；只剥掉这个参数，保留其余 libpq 参数
  DUMP_DATABASE_URL="$(node -e '
const raw = process.env.DATABASE_URL;
const url = new URL(raw);
url.searchParams.delete("schema");
process.stdout.write(url.toString());
')"
  pg_dump "$DUMP_DATABASE_URL" --format=custom --no-owner --no-acl --file="$OUT" || fail "pg_dump failed"
else
  pg_dump --host="${PGHOST:-localhost}" --port="${PGPORT:-5432}" \
    --username="${PGUSER:-postgres}" --dbname="$DB_NAME" \
    --format=custom --no-owner --no-acl --file="$OUT" || fail "pg_dump failed"
fi

pg_restore --list "$OUT" >/dev/null || fail "dump verification failed: $OUT"

SIZE="$(du -h "$OUT" | cut -f1 | tr -d ' ')"
log "backup ok: $OUT ($SIZE)"

# 清理过期备份（bambook*.dump 同时覆盖历史命名 bambook-panda-hub-* / bambook-postgres-*）
DELETED="$(find "$BACKUP_DIR" -name 'bambook*.dump' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
log "retention cleanup: removed $DELETED file(s) older than $RETENTION_DAYS days"

log "backup done"
