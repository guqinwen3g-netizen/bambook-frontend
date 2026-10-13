-- DR-053 阶段 0：Invoice 来源幂等约束（防并发/重试重复建票）
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §12.7（阶段 0）
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS 可重复执行
-- PG unique 索引对 NULL 不互斥：历史/订单级发票 sourceType/sourceId 均为 NULL，不冲突

-- AddColumn: Invoice.sourceType / Invoice.sourceId（来源类型+业务单据 ID，联合唯一）
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "sourceType" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "sourceId" TEXT;

-- 来源唯一约束：同一来源（如某样品）最多一张有效发票
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_sourceType_sourceId_key" ON "Invoice"("sourceType", "sourceId");
