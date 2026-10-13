# Mac mini 正式库 DEMO 数据执行 Runbook

本文档用于在 Mac mini 当前正式 PostgreSQL 中写入、验证和回滚 Bambook DEMO 案例数据。

## 0. 前提

- 代码已同步到 Mac mini 的主数据 API 目录。
- 当前目录应为 Bambook server 目录，包含 `package.json`、`prisma/`、`scripts/`。
- `.env.local` 或 `.env` 中必须有正式库 `DATABASE_URL`。
- 执行前必须先备份。

## 1. 进入服务器目录

```bash
cd ~/bambook-main-api/server
```

## 2. 加载环境变量

```bash
set -a
[ -f .env ] && source .env
[ -f .env.local ] && source .env.local
set +a
test -n "$DATABASE_URL" && echo "DATABASE_URL loaded"
```

不要在会议或聊天中展示完整 `DATABASE_URL`。

## 3. 备份正式库

```bash
npm run backup:postgres
```

确认：`Backup written: /Users/Shared/BambookBackups/bambook-panda-hub-YYYYMMDD-HHMMSS.dump`

## 4. 确认 schema 已是最新

```bash
npx prisma migrate deploy
npx prisma generate
```

## 5. Dry run（不连 DB）

```bash
npx tsx scripts/seed-demo-data.ts --dry-run
```

期望输出：`Dry-run only. No database connection was opened and no data was written.`

## 6. 写入 DEMO 数据

### ✅ 推荐：通过 REST API 写入（route-backed，有 audit/sync）

```bash
npx tsx scripts/seed-demo-data.ts --api-apply
```

请求经 `https://jiangsupanda.com/bambook/api/*` 转发到 Mac mini Express API，再写入 PostgreSQL。
此路径经过 route 层的 audit、sync、validation，是正式库的推荐路径。

### ⚠️ 不推荐：直接 Prisma 写入（bypass route audit/sync）

```bash
npx tsx scripts/seed-demo-data.ts --apply --unsafe-direct-prisma
```

**风险**：绕过 REST API 的 route audit/sync，无 EntityLink 同步、无审计日志。
必须显式传 `--unsafe-direct-prisma` 确认门才会执行。
仅在 REST API 不可用且急需时使用，并在执行后手动补 audit。

## 7. API 验证

```bash
curl -sS -H "X-Bambook-API-Key: $BAMBOOK_SDK_KEY" \
  "https://jiangsupanda.com/bambook/api/v1/products/assets?search=DEMO" | head
curl -sS -H "X-Bambook-API-Key: $BAMBOOK_SDK_KEY" \
  "https://jiangsupanda.com/bambook/api/v1/orders" | grep DEMO-PO
curl -sS -H "X-Bambook-API-Key: $BAMBOOK_SDK_KEY" \
  "https://jiangsupanda.com/bambook/api/v1/relations" | grep DEMO
```

## 8. 前端验证

1. 产品档案搜索 `DEMO-FAB`。
2. 关系智库搜索 `DEMO`。
3. 订单列表搜索 `DEMO-PO`。
4. 检查 `DEMO-PO-2601005` 是否显示为风险订单。
5. 检查 `DEMO-FAB-CST-240-OLIVE` 是否显示完整成分、价格、认证、客户编码。

## 9. 回滚 DEMO 数据

只删除本批显式标记的 DEMO 数据。

### ✅ 推荐：通过 REST API 回滚（route-backed）

```bash
npx tsx scripts/seed-demo-data.ts --api-rollback
```

### ⚠️ 不推荐：直接 Prisma 回滚（bypass route audit/sync）

```bash
npx tsx scripts/seed-demo-data.ts --rollback --unsafe-direct-prisma
```

回滚范围（基于 DEMO marker，不扩大）：
- `Order.source = demo` 或 `Order.id/poNumber` 以 `DEMO-PO-` 开头
- 相关 `OrderLine`
- `ProductAsset.id` 以 `DEMO-PROD-` 开头或 `sku` 以 `DEMO-FAB-` 开头
- 相关 FabricProfile、Composition、Price、Certification、CustomerCode、ProductImage
- `Relation.id` 以 `DEMO-` 开头或 `tags` 包含 `DEMO`

## 10. 灾难回滚

误操作影响非 DEMO 数据时，使用第 3 步备份做 pg_restore。

## 11. 注意事项

- 不允许无备份直接执行 `--apply`。
- 不允许手动改掉 DEMO 前缀后写入正式库。
- 不允许将本脚本改为随机 ID，否则会破坏回滚能力。
- `--apply`/`--rollback` 不带 `--unsafe-direct-prisma` 会被拒绝执行（exit 2）。
- 本脚本不写图片文件。
