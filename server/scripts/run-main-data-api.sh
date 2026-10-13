#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${BAMBOOK_MAIN_API_DIR:-$HOME/bambook-main-api}"
LOG_PREFIX="[bambook-main-api]"

export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:/opt/homebrew/bin:$PATH"

cd "$APP_DIR"

if [[ ! -f ".env" && ! -f ".env.local" ]]; then
  echo "$LOG_PREFIX missing .env or .env.local in $APP_DIR" >&2
  exit 1
fi

set -a
[[ -f ".env.local" ]] && source ".env.local"
[[ -f ".env" ]] && source ".env"
set +a

npm install --include=dev
npx prisma generate
# 部署通道已收敛到 migrate deploy 单一真源（运维冲刺任务 2）——禁止 db push --accept-data-loss
# （绕过账本、可能静默丢列）；迁移账本断链时用 scripts/fix-migration-ledger.ts 补账。
npx prisma migrate deploy
npm run build

export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-8081}"

exec npm start
