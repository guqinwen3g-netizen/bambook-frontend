#!/usr/bin/env bash
# 开发环境数据库首次初始化（仅 panda_hub_dev@localhost；幂等）。
# 用法（root）：sudo bash scripts/deploy/init-dev-database.sh
# 迁移历史无法从空库重放（早期迁移依赖库外已有表），因此空库按 schema.prisma 建表，
# 再把全部迁移标记为已应用作为基线；之后的 schema 变更照常 `prisma migrate deploy`。
# 正式库禁止 db push 的原则不变，本脚本拒绝非开发库。
set -euo pipefail
ENV_FILE=${BAMBOOK_DEV_ENV_FILE:-/etc/bambook-dev/backend.env}
SERVER_DIR=${BAMBOOK_DEV_SERVER_DIR:-/srv/bambook-dev/current/server}
ACCOUNTS_FILE=${BAMBOOK_DEV_ACCOUNTS_FILE:-/srv/bambook-dev/shared/test-accounts.txt}
set -a; . "$ENV_FILE"; set +a
case "$DATABASE_URL" in
  *@localhost:5432/panda_hub_dev*|*@127.0.0.1:5432/panda_hub_dev*) ;;
  *) echo "refuse: DATABASE_URL is not the local panda_hub_dev database" >&2; exit 1 ;;
esac
export BAMBOOK_DEV_ENVIRONMENT=1
cd "$SERVER_DIR"
prisma=./node_modules/.bin/prisma

has_ledger=$(psql "${DATABASE_URL%%\?*}" -Atc "select to_regclass('public.\"_prisma_migrations\"') is not null")
if [ "$has_ledger" != t ]; then
  echo "== empty database: db push + baseline"
  "$prisma" db push --skip-generate
  for dir in prisma/migrations/*/; do
    "$prisma" migrate resolve --applied "$(basename "$dir")" >/dev/null
  done
fi
"$prisma" migrate deploy

npm run seed:base
SEED_OWNER_ALLOW_NONEMPTY=1 npx tsx scripts/seed-empty-owner.ts
npm run seed:dev-roles
install -m 600 /dev/null "$ACCOUNTS_FILE.tmp"
npx tsx scripts/set-dev-environment-passwords.ts "$ACCOUNTS_FILE.tmp"
mv "$ACCOUNTS_FILE.tmp" "$ACCOUNTS_FILE"
chmod 600 "$ACCOUNTS_FILE"
echo "== done; test accounts in $ACCOUNTS_FILE (root only)"
