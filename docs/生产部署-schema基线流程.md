# 生产部署：数据库 schema 基线流程（G1 定案）

> 背景：本地表结构真源 = `pg_dump --schema-only` 克隆（不跑 migration），但生产部署脚本
> `ops-deploy-main-api.sh` 会执行 `npx prisma migrate deploy`。schema-only 克隆的库
> `_prisma_migrations` 表**有结构无历史行** → migrate deploy 会从头重放全部迁移 → 报"表已存在"失败。
> 本文档定案生产库的标准建库/部署流程。**首次生产部署与每次大版本更新都按此执行。**

## 标准流程（三选一按场景）

### 场景 A：生产库 = 从本地权威结构克隆（pg_dump --schema-only，与本地逐字节一致）★推荐

克隆完成后、首次 `migrate deploy` 之前，执行**基线回填**：

```bash
cd /Users/panda1/bambook-main-api   # Mac Mini 生产目录（server 同构）
npx ts-node scripts/fix-migration-ledger.ts --apply
# 输出「新补账 N 个」后，再跑部署（migrate deploy 即可幂等通过）
```

- 原理：`fix-migration-ledger.ts` 对照 `_prisma_migrations` 账本，把"结构已生效但未记账"的
  迁移逐个 `prisma migrate resolve --applied` 记账，不改表结构。
- **前提**：克隆源（本地）与迁移目录一致——本地账本已全记账（2026-09-14 核实：54/54）。
- 补账后 `npx prisma migrate deploy` 应输出「No pending migrations」。

### 场景 B：生产库 = 全新空库（不克隆）

直接跑部署即可：`migrate deploy` 会全量建表并记账，无需补账。
（⚠️ 空库上线彩排用的是场景 A 的克隆路径，若生产改走 B，务必先用彩排脚本在空库复验一次。）

### 场景 C：常规版本更新（生产库已有账本）

直接部署：`ops-deploy-main-api.sh` 内的 `migrate deploy` 只执行新增迁移，天然幂等。
部署后核对：`npx ts-node scripts/fix-migration-ledger.ts`（dry-run）应显示「未记账 0 个」。

## 上线日 checklist（G2，配合本流程）

1. ☐ 生产库建库（场景 A 或 B）
2. ☐ 场景 A 则先 `fix-migration-ledger.ts --apply`
3. ☐ `JWT_SECRET` 强随机值（弱默认会拒绝启动）
4. ☐ `BAMBOOK_SDK_KEY` 生产值；**不设** `BAMBOOK_DEV_PANEL`
5. ☐ 管理员初始密码**不是** Bambook@2026（bootstrap 默认密码必须首登即改）
6. ☐ 管理员绑 owner/admin 角色 → 「电子签章」Tab 上传真实章图
7. ☐ 触发一次 `backup-postgres.sh` 并演练恢复（还原到临时库核对行数）
8. ☐ 部署后 `post-deploy-verify.ts` + 公网探活

## 已核实的基础设施（无需动作）

- 登录防爆破限流：`auth/route.ts` loginRateLimiter（IP+账号维度）
- 备份：`backup-postgres.sh` launchd 每日 02:00；远程 `ops/ops-backup-postgres.sh`
- dev 面板生产双护栏：`NODE_ENV=production` 或未设 `BAMBOOK_DEV_PANEL` → 404
- 客户门户 token（kind=customer）与内部 RBAC 天然隔离
