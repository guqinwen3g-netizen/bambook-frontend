-- DR-053 阶段 3：收费事项（BillingItem）+ 成本记录（CostRecord）
-- 费用四层表达：费用发生(CostRecord) → 收费决定(BillingItem) → 应收草稿(Invoice Draft) → 签发(Issued)
-- 手写幂等 SQL：全部 ADD COLUMN / CREATE TABLE IF NOT EXISTS，可重复执行（对齐阶段 0/1/2 惯例）

-- ── CostRecord：费用发生（成本记录）──
CREATE TABLE IF NOT EXISTS "CostRecord" (
    "id" TEXT NOT NULL,
    "recordNo" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "costType" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "incurredAt" TEXT NOT NULL,
    "bearerType" TEXT NOT NULL DEFAULT 'customer',
    "bearerRelationId" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "CostRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CostRecord_recordNo_key" ON "CostRecord"("recordNo");
CREATE INDEX IF NOT EXISTS "CostRecord_sourceType_sourceId_idx" ON "CostRecord"("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "CostRecord_costType_idx" ON "CostRecord"("costType");

-- ── BillingItem：收费决定（收费事项）──
CREATE TABLE IF NOT EXISTS "BillingItem" (
    "id" TEXT NOT NULL,
    "itemNo" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "costRecordId" TEXT,
    "chargeType" TEXT NOT NULL,
    "bearerType" TEXT NOT NULL DEFAULT 'customer',
    "bearerRelationId" TEXT,
    "bearerName" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "waivedAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "offsetAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "offsetOrderId" TEXT,
    "offsetOrderNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "invoiceId" TEXT,
    "invoiceNumber" TEXT,
    "confirmedAt" BIGINT,
    "confirmedBy" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "BillingItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BillingItem_itemNo_key" ON "BillingItem"("itemNo");
CREATE INDEX IF NOT EXISTS "BillingItem_sourceType_sourceId_idx" ON "BillingItem"("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "BillingItem_status_idx" ON "BillingItem"("status");
