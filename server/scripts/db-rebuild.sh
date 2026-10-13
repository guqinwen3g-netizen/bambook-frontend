#!/usr/bin/env bash
# db-rebuild.sh — 重建本地开发库到出厂状态
#
# 用法（cd server）：
#   bash scripts/db-rebuild.sh empty            # 重建全空库（交互式确认）
#   bash scripts/db-rebuild.sh empty --yes      # 跳过确认（脚本/自动化用）
#   bash scripts/db-rebuild.sh mature --yes     # 重建满数据库
#
# 为什么需要：全空库用于模拟甲方第一次上手。走完一遍主链后库就"脏"了，
# 想重新演练必须回到出厂状态 —— 本脚本就是那个"回到第一天"的按钮。
#
# ── 安全护栏（多重）──────────────────────────────────────────────────
#   1. 仅允许重建白名单库：panda_hub_empty / panda_hub_mature
#      panda_hub_local 与任何其他库名一律拒绝（local 是结构权威 + 现网工作库）
#   2. 仅允许 localhost / 127.0.0.1
#   3. 默认交互式确认；非 --yes 不删任何东西
#   4. 表结构始终从 panda_hub_local 导出，不依赖被重建的库自身
# ────────────────────────────────────────────────────────────────────

set -euo pipefail

SERVER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$SERVER_ROOT/.env.local"

[[ -f "$ENV_FILE" ]] || { echo "✗ 找不到 $ENV_FILE"; exit 1; }

TARGET="${1:-}"
FORCE=0
for a in "${@:2}"; do [[ "$a" == "--yes" ]] && FORCE=1; done

read_url() {
  grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | sed -E 's/^DATABASE_URL="?//; s/"?$//'
}

url_part() {
  local url="$1" key="$2"
  case "$key" in
    host) printf '%s' "$url" | sed -E 's#^[a-z]+://[^@]*@([^:/]+).*#\1#' ;;
    user) printf '%s' "$url" | sed -E 's#^[a-z]+://([^:/]*).*#\1#' ;;
    pass) printf '%s' "$url" | sed -E 's#^[a-z]+://[^/]*:([^@]*)@.*#\1#' ;;
    db)   printf '%s' "$url" | sed -E 's#^[a-z]+://[^@]*@[^/]+/([^?]+).*#\1#' ;;
  esac
}

URL="$(read_url)"
[[ -n "$URL" ]] || { echo "✗ $ENV_FILE 里没有 DATABASE_URL"; exit 1; }

HOST="$(url_part "$URL" host)"
USER="$(url_part "$URL" user)"
PASS="$(url_part "$URL" pass)"
PASS="$(printf '%s' "$PASS" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()),end="")' 2>/dev/null || printf '%s' "$PASS")"
export PGPASSWORD="$PASS"

# ── 护栏 2：仅本地 ──
case "$HOST" in
  localhost|127.0.0.1) ;;
  *) echo "✗ 拒绝：DATABASE_URL 指向非本地主机 [$HOST]。本脚本只管理本地开发库。"; exit 1 ;;
esac

# ── 护栏 1：白名单库 ──
case "$TARGET" in
  empty)  TARGET_DB="panda_hub_empty" ;;
  mature) TARGET_DB="panda_hub_mature" ;;
  local|panda_hub_local)
    echo "✗ 拒绝重建 panda_hub_local —— 它是表结构权威源与现网工作库，重建会导致数据不可逆丢失。"
    exit 1 ;;
  "") echo "✗ 请指定目标：empty 或 mature"; exit 1 ;;
  *) echo "✗ 拒绝：'$TARGET' 不在白名单（仅允许 empty / mature）"; exit 1 ;;
esac

STRUCTURE_SOURCE="panda_hub_local"

if ! psql -h "$HOST" -U "$USER" -d postgres -t -A -c "SELECT 1 FROM pg_database WHERE datname='$STRUCTURE_SOURCE';" 2>/dev/null | grep -q 1; then
  echo "✗ 结构源库 $STRUCTURE_SOURCE 不存在，无法导出表结构。"
  exit 1
fi

echo "════════════════════════════════════════════════"
echo " 重建目标 : $TARGET_DB"
echo " 主机     : $HOST"
echo " 结构来源 : $STRUCTURE_SOURCE （只取表结构，不取数据）"
echo "════════════════════════════════════════════════"
echo ""
echo "⚠ 此操作将 DROP DATABASE ${TARGET_DB}，库内现有数据全部丢失且不可恢复。"

if [[ "$FORCE" -ne 1 ]]; then
  printf '确认请输入 yes（其他任意输入取消）： '
  read -r answer
  if [[ "$answer" != "yes" ]]; then
    echo "已取消，未做任何改动。"
    exit 0
  fi
fi

TMP_SQL="$(mktemp "${TMPDIR:-/tmp}/bambook_schema.XXXXXX.sql")"
trap 'rm -f "$TMP_SQL"' EXIT

echo ""
echo "── 1/5 导出表结构 ──"
pg_dump -h "$HOST" -U "$USER" -d "$STRUCTURE_SOURCE" --schema-only --no-owner --no-privileges > "$TMP_SQL" 2>/dev/null
echo "   $(wc -l < "$TMP_SQL" | tr -d ' ') 行"

echo "── 2/5 断开活跃连接 ──"
psql -h "$HOST" -U "$USER" -d postgres -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$TARGET_DB' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
echo "   完成"

echo "── 3/5 删库 + 建库 ──"
dropdb -h "$HOST" -U "$USER" --if-exists "$TARGET_DB"
createdb -h "$HOST" -U "$USER" "$TARGET_DB"
echo "   $TARGET_DB 已重建"

echo "── 4/5 灌入表结构 ──"
psql -h "$HOST" -U "$USER" -d "$TARGET_DB" -q -f "$TMP_SQL" >/dev/null 2>&1
TABLES="$(psql -h "$HOST" -U "$USER" -d "$TARGET_DB" -t -A -c "SELECT count(*) FROM pg_stat_user_tables;")"
echo "   ${TABLES} 张表"

echo "── 5/5 切换到 $TARGET_DB 并灌数据 ──"
bash "$SERVER_ROOT/scripts/db-use.sh" "$TARGET" | tail -3

cd "$SERVER_ROOT"
export PGPASSWORD="$PASS"
echo ""
echo "   › 基础数据（RBAC / 字典 / 系统配置 / 发号器 / 权限 / MOQ）"
npm run --silent seed:base > /dev/null 2>&1 && echo "     基础数据完成" || { echo "     ✗ 基础数据失败"; exit 1; }

if [[ "$TARGET" == "empty" ]]; then
  # 空白公司：业务数据保持为零（模拟甲方第一次上手），但必须保留「恰好一个」bootstrap 管理员，
  # 否则零账号 → 无人审批注册 → 新注册永远 pending → 谁都进不去（死锁）。
  # 先清空所有业务/账号表，再注入唯一 owner（seed-empty-owner 幂等，已有则跳过）。
  echo "   › 清空业务与账号数据（回到甲方第一天，业务单据为 0）"
  psql -h "$HOST" -U "$USER" -d "$TARGET_DB" -q -c \
    "TRUNCATE TABLE \"AgentMemory\",\"AgentMessage\",\"AgentSession\",\"AgentToolRun\",\"ApprovalRequest\",\"AuditLog\",\"EmployeeProfile\",\"Notification\",\"NotificationPreference\",\"UserRole\",\"WorkflowInstance\",\"WorkflowStep\",\"UserAccount\" RESTART IDENTITY CASCADE;" >/dev/null 2>&1 \
    && echo "     业务/账号数据已清空（0 业务单据）" || echo "     ⚠ 清空失败"
  echo "   › 注入预设 bootstrap 管理员（owner@bambook.local / Bambook@2026，角色=超级管理员）"
  npx ts-node scripts/seed-empty-owner.ts 2>&1 | sed 's/^/     /' || echo "     ⚠ 注入 owner 失败"
fi

if [[ "$TARGET" == "mature" ]]; then
  echo "   › 13 周公司剧情数据（耗时较长）"
  npm run --silent seed:company > /dev/null 2>&1 && echo "     剧情数据完成" || { echo "     ✗ 剧情数据失败"; exit 1; }
fi

echo ""
echo "✅ $TARGET_DB 已回到出厂状态。"
echo "   记得重启 dev server 后生效。"
