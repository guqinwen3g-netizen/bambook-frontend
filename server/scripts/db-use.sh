#!/usr/bin/env bash
# db-use.sh — 切换本地开发数据库（empty / mature / local）
#
# 用法（cd server）：
#   bash scripts/db-use.sh             # 显示当前指向的库
#   bash scripts/db-use.sh empty       # 全空库：模拟甲方首次打开系统
#   bash scripts/db-use.sh mature      # 满数据库：模拟公司已长期运营
#   bash scripts/db-use.sh local       # 原有开发库（默认/兜底）
#
# 三档语义：
#   panda_hub_empty   只有系统基础数据（RBAC/组织/系统配置/发号器/数据字典/演示账号），
#                     业务单据为 0 —— 用于从零走通主链、模拟甲方上手第一天
#   panda_hub_mature  seed-company-sim 生成的 13 周完整剧情数据 —— 用于验证
#                     已运营状态下的报表/驾驶舱/历史查询/跨域联动
#   panda_hub_local   原有开发库，原样保留不动
#
# 安全护栏：仅允许操作 localhost / 127.0.0.1 上的库，非本地主机直接拒绝。
# 切换后必须重启 dev server（Prisma 连接池在进程启动时建立，运行中不重读 env）。

set -euo pipefail

SERVER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$SERVER_ROOT/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ 找不到 $ENV_FILE"
  exit 1
fi

TARGET="${1:-}"

read_url() {
  grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | sed -E 's/^DATABASE_URL="?//; s/"?$//'
}

# 从 URL 中取出指定片段
url_part() {
  local url="$1" key="$2"
  case "$key" in
    host) printf '%s' "$url" | sed -E 's#^[a-z]+://[^@]*@([^:/]+).*#\1#' ;;
    db)   printf '%s' "$url" | sed -E 's#^[a-z]+://[^@]*@[^/]+/([^?]+).*#\1#' ;;
    user) printf '%s' "$url" | sed -E 's#^[a-z]+://([^:/]*).*#\1#' ;;
    pass) printf '%s' "$url" | sed -E 's#^[a-z]+://[^/]*:([^@]*)@.*#\1#' ;;
  esac
}

CURRENT_URL="$(read_url)"
if [[ -z "$CURRENT_URL" ]]; then
  echo "✗ $ENV_FILE 里没有 DATABASE_URL"
  exit 1
fi

CUR_HOST="$(url_part "$CURRENT_URL" host)"
CUR_DB="$(url_part "$CURRENT_URL" db)"
CUR_USER="$(url_part "$CURRENT_URL" user)"
CUR_PASS="$(url_part "$CURRENT_URL" pass)"

# 密码可能经过 URL 编码（%40 → @ 等），解码后再交给 psql
CUR_PASS="$(printf '%s' "$CUR_PASS" | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()),end="")' 2>/dev/null || printf '%s' "$CUR_PASS")"
export PGPASSWORD="$CUR_PASS"

echo "当前库: $CUR_DB   (host: $CUR_HOST)"

# ── 安全护栏：绝不触碰非本地库 ──
case "$CUR_HOST" in
  localhost|127.0.0.1) ;;
  *)
    echo "✗ 安全护栏：当前 DATABASE_URL 指向非本地主机 [$CUR_HOST]，拒绝操作。"
    echo "  本脚本只允许管理本地开发库，生产库请通过部署流程处理。"
    exit 1
    ;;
esac

if [[ -z "$TARGET" ]]; then
  cat <<'EOF'

可用目标：
  empty    panda_hub_empty    全空库（甲方首次使用，业务单据 0）
  mature   panda_hub_local    成熟演示公司 = 你原有的开发工作库（69 单业务 + 36 账号）
  local    panda_hub_local    同 mature（别名：本地工作库即成熟演示库）

示例：bash scripts/db-use.sh empty
EOF
  exit 0
fi

case "$TARGET" in
  empty)  NEW_DB="panda_hub_empty" ;;
  mature) NEW_DB="panda_hub_local" ;;
  local)  NEW_DB="panda_hub_local" ;;
  *)
    echo "✗ 未知目标 '$TARGET'（可选：empty / mature / local）"
    exit 1
    ;;
esac

if [[ "$NEW_DB" == "$CUR_DB" ]]; then
  echo "→ 已经指向 ${NEW_DB}，无需切换。"
  exit 0
fi

# 目标库必须存在
if ! psql -h "$CUR_HOST" -U "$CUR_USER" -d postgres -t -A -c "SELECT 1 FROM pg_database WHERE datname='$NEW_DB';" 2>/dev/null | grep -q 1; then
  echo "✗ 目标库 $NEW_DB 不存在。先创建：createdb -h $CUR_HOST -U $CUR_USER $NEW_DB"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 同步 DATABASE_URL 到 .env.local 与 .env（两文件必须一致）
#
# 为什么必须同步两个文件（踩过的坑）：
#   `import { PrismaClient }` 会被 ES module 提升到模块体之前执行，Prisma 在
#   import 阶段就加载了 server/.env 并写入 process.env.DATABASE_URL；
#   而多数 seed 脚本（seed-rbac / seed-datadict / seed-sequence …）的
#   dotenv.config({ path: '.env.local' }) 未设 override，dotenv 默认不覆盖
#   已存在的环境变量 —— 于是 .env.local 的切换静默失效，数据被写进
#   .env 指向的库。只改 .env.local 是不够的。
# ─────────────────────────────────────────────────────────────────────────────
STAMP="$(date +%Y%m%d_%H%M%S)"
ENV_BASE="$SERVER_ROOT/.env"

sync_env_file() {
  local file="$1"
  local name
  name="$(basename "$file")"

  if [[ ! -f "$file" ]]; then
    echo "  · 跳过（文件不存在）: $name"
    return 0
  fi
  if ! grep -qE '^[[:space:]]*DATABASE_URL=' "$file"; then
    echo "  · 跳过（无 DATABASE_URL 行）: $name"
    return 0
  fi

  cp "$file" "$file.bak.$STAMP"
  sed -i.tmp -E "s#^(DATABASE_URL=\"?[a-z]+://[^@]*@[^/]+/)[^/?\"]+(.*)#\1${NEW_DB}\2#" "$file"
  rm -f "$file.tmp"

  local after
  after="$(grep -E '^DATABASE_URL=' "$file" | head -1 | sed -E 's/^DATABASE_URL="?//; s/"?$//')"
  if [[ "$(url_part "$after" db)" != "$NEW_DB" ]]; then
    echo "  ✗ 切换失败: ${name}（DATABASE_URL 格式不符合预期，请检查该文件）"
    return 1
  fi
  echo "  · 已更新: $name"
}

echo "同步 DATABASE_URL："
sync_env_file "$ENV_FILE"
sync_env_file "$ENV_BASE"

NEW_URL="$(read_url)"
NEW_DB_ACTUAL="$(url_part "$NEW_URL" db)"

if [[ "$NEW_DB_ACTUAL" != "$NEW_DB" ]]; then
  echo "✗ 切换失败：期望 ${NEW_DB}，实际 ${NEW_DB_ACTUAL}。"
  exit 1
fi

echo "已切换 → $NEW_DB_ACTUAL"
echo "（原文件已备份为 .env.local.bak.${STAMP} / .env.bak.${STAMP}）"
echo ""
echo "⚠ 请重启 dev server 生效 —— Prisma 连接池在进程启动时建立，运行中不会重读 env。"
