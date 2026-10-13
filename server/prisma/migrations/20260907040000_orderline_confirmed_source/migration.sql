-- DR-053 阶段 1：订单行版本引用 + 多订单关系 + 请求幂等
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §13
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS 可重复执行
-- PG unique 索引对 NULL 不互斥：历史订单 clientRequestId/confirmedSource* 均为 NULL，不冲突

-- ── Order：来源开发案快照 + 请求幂等键 ──
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "sourceCaseId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "clientRequestId" TEXT;

-- 幂等键唯一：同一请求重复提交返回已有订单，不重复建单
CREATE UNIQUE INDEX IF NOT EXISTS "Order_clientRequestId_key" ON "Order"("clientRequestId");
CREATE INDEX IF NOT EXISTS "Order_sourceCaseId_idx" ON "Order"("sourceCaseId");

-- ── OrderLine：版本引用（确认成果 → 订单）+ 不可变规格快照 ──
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "confirmedSourceType" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "confirmedSourceId" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "confirmedAt" BIGINT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "confirmedBy" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "specSnapshot" JSONB;

-- 成果→订单反查
CREATE INDEX IF NOT EXISTS "OrderLine_confirmedSourceType_confirmedSourceId_idx" ON "OrderLine"("confirmedSourceType", "confirmedSourceId");
