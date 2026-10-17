#!/usr/bin/env bash
# 备份可恢复核验（可重复运行）：只用于开发库或本地 / 临时隔离 PostgreSQL，禁止指向正式库。
#
# 流程：
#   1. 用现有 backup-postgres.sh 对源库做一次备份（输出到本次独立的工作目录）；
#   2. 新建带时间戳的临时库 bambook_restore_verify_YYYYMMDD_HHMMSS_<pid>，用 pg_restore 恢复；
#   3. 在临时库上跑当前检出代码（main）的 schema 迁移检查：prisma migrate status + migrate diff（与 schema.prisma 无差异）；
#   4. 逐项比对原库与恢复库：表数量、逐表行数（含关键表）、每个工作空间的 revision / 事件数 / 回执数；
#   5. 用恢复库启动一次 Mist 服务：健康检查通过，并读取一个工作空间，与原库启动的同一服务读取结果一致；
#   6. 只删除本脚本自己创建、且名称通过前缀校验的临时库（不删其他库，不删除文件目录）。
#
# 用法：
#   BACKUP_VERIFY_SOURCE_URL=postgresql://postgres@127.0.0.1:55432/bambook_local_verify \
#     bash server/scripts/verify-backup-restore.sh
# 可选：
#   BACKUP_VERIFY_WORK_DIR        备份与报告目录（默认 mktemp 新建；脚本不删除该目录，便于留证）
#   BACKUP_VERIFY_WORKSPACE_ID    指定服务读取比对的工作空间（默认取第一个未归档工作空间）
#   BACKUP_VERIFY_ALLOW_REMOTE_DEV=1  源库不在本机时显式确认它是开发库（默认只接受回环地址）
#   BACKUP_VERIFY_KEEP_DB=1       保留临时库供排查（默认删除）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFIX="bambook_restore_verify_"
NAME_PATTERN="^${PREFIX}[0-9]{8}_[0-9]{6}_[0-9]+$"

say() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
for tool in pg_dump pg_restore psql node npx; do command -v "$tool" >/dev/null || die "缺少命令：$tool"; done

SOURCE_URL="${BACKUP_VERIFY_SOURCE_URL:-}"
[[ -n "$SOURCE_URL" ]] || die "需要 BACKUP_VERIFY_SOURCE_URL（开发库或本地隔离库）；本脚本不读取 .env，避免误连正式库"

# 解析连接串：主机、库名，以及把库名换成临时库后的连接串（去掉 Prisma 专有 ?schema=）。
url_part() { node -e '
const u = new URL(process.argv[1]); u.searchParams.delete("schema");
const part = process.argv[2];
if (part === "host") process.stdout.write(u.hostname);
else if (part === "db") process.stdout.write(decodeURIComponent(u.pathname.slice(1)));
else if (part === "clean") process.stdout.write(u.toString());
else { u.pathname = "/" + encodeURIComponent(part); process.stdout.write(u.toString()); }
' "$SOURCE_URL" "$1"; }
SOURCE_HOST="$(url_part host)"; SOURCE_DB="$(url_part db)"; SOURCE_CLEAN="$(url_part clean)"
[[ -n "$SOURCE_DB" ]] || die "连接串缺少库名"
case "$SOURCE_HOST" in
  127.0.0.1|localhost|::1|\[::1\]) ;;
  *) [[ "${BACKUP_VERIFY_ALLOW_REMOTE_DEV:-}" == "1" ]] || die "源库主机 $SOURCE_HOST 不是本机；确认是开发库后设置 BACKUP_VERIFY_ALLOW_REMOTE_DEV=1" ;;
esac
[[ "$SOURCE_DB" =~ (dev|test|verify|local|sandbox|tmp) ]] || die "源库名 $SOURCE_DB 不含 dev/test/verify/local/sandbox/tmp，拒绝运行（防止指向正式库）"
[[ "$SOURCE_DB" =~ ^${PREFIX} ]] && die "源库不能是本脚本的临时库"

WORK_DIR="${BACKUP_VERIFY_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/bambook-backup-verify.XXXXXX")}"
mkdir -p "$WORK_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
TEMP_DB="${PREFIX}${STAMP}_$$"
[[ "$TEMP_DB" =~ $NAME_PATTERN ]] || die "临时库名 $TEMP_DB 未通过前缀校验"
TEMP_URL="$(url_part "$TEMP_DB")"
CREATED_DB=""

cleanup() {
  local status=$?
  if [[ -n "$CREATED_DB" ]]; then
    if [[ "${BACKUP_VERIFY_KEEP_DB:-}" == "1" ]]; then
      say "保留临时库 $CREATED_DB（BACKUP_VERIFY_KEEP_DB=1）"
    elif [[ "$CREATED_DB" == "$TEMP_DB" && "$CREATED_DB" =~ $NAME_PATTERN ]]; then
      # 只删本次创建、名称通过前缀校验的库
      psql "$SOURCE_CLEAN" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"$CREATED_DB\" WITH (FORCE)" \
        && say "已删除临时库 $CREATED_DB" || say "WARNING: 临时库 $CREATED_DB 删除失败，请人工处理"
    else
      say "WARNING: 临时库名 $CREATED_DB 未通过校验，未删除"
    fi
  fi
  exit $status
}
trap cleanup EXIT

say "源库：$SOURCE_HOST/$SOURCE_DB；工作目录：$WORK_DIR；代码：$(git -C "$SERVER_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# 1. 备份（复用现有脚本；BAMBOOK_BACKUP_DIR 指向本次工作目录，保留策略只作用于该目录）
say "1/6 备份：backup-postgres.sh"
DATABASE_URL="$SOURCE_URL" BAMBOOK_BACKUP_DIR="$WORK_DIR" bash "$SCRIPT_DIR/backup-postgres.sh"
DUMP="$(ls -1t "$WORK_DIR"/bambook-*.dump 2>/dev/null | head -1)"
[[ -n "$DUMP" && -s "$DUMP" ]] || die "没有找到备份文件"
say "备份文件：$DUMP（$(du -h "$DUMP" | cut -f1)）"

# 2. 新建临时库并恢复
say "2/6 新建临时库 $TEMP_DB 并 pg_restore"
psql "$SOURCE_CLEAN" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$TEMP_DB\""
CREATED_DB="$TEMP_DB"
pg_restore --no-owner --no-acl --exit-on-error --dbname="$TEMP_URL" "$DUMP"

# 3. 迁移检查（当前检出代码）
say "3/6 迁移检查：prisma migrate status / migrate diff"
( cd "$SERVER_DIR" && DATABASE_URL="$TEMP_URL" npx prisma migrate status ) | tee "$WORK_DIR/migrate-status.txt"
( cd "$SERVER_DIR" && npx prisma migrate diff --from-url "$TEMP_URL" --to-schema-datamodel prisma/schema.prisma --exit-code ) >"$WORK_DIR/migrate-diff.txt" 2>&1 \
  || { cat "$WORK_DIR/migrate-diff.txt"; die "恢复库结构与当前 schema.prisma 不一致"; }
say "migrate diff：恢复库与 schema.prisma 无差异"

# 4-5. 逐项比对 + 用恢复库启动服务
say "4-5/6 比对原库与恢复库，并用恢复库启动服务核验"
( cd "$SERVER_DIR" && BACKUP_VERIFY_SOURCE_URL="$SOURCE_CLEAN" BACKUP_VERIFY_RESTORED_URL="$TEMP_URL" BACKUP_VERIFY_REPORT="$WORK_DIR/report.json" npx tsx scripts/verify-backup-restore-check.ts )

say "6/6 清理：只删除本次临时库"
say "核验通过；报告：$WORK_DIR/report.json"
