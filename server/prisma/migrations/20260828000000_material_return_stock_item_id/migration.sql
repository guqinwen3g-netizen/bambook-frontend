-- 外科迁移（运维冲刺任务 1）：MaterialReturn.stockItemId 列曾以 db push 外科 DDL 领先账本上线，
-- 本迁移将其纳入账本；IF NOT EXISTS 保证已外科生效的库幂等通过。
ALTER TABLE "MaterialReturn" ADD COLUMN IF NOT EXISTS "stockItemId" TEXT;
