-- DR-054 阶段 A：样品·开发·费用·开票 全局综合设计 数据模型地基
-- 手写幂等 SQL（对齐 DR-053 惯例：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS，可重复执行）

-- ── SampleBatch：批次 = 开发活动 + 确认单位（计划/实际数量 + 批次级确认 tag）──
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "planQuantity" DECIMAL(18,4);
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "planUnit" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "actualQuantity" DECIMAL(18,4);
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "actualUnit" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "confirmStatus" TEXT NOT NULL DEFAULT 'unconfirmed';
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "confirmedAt" BIGINT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "confirmedBy" TEXT;

-- ── Sample：设计确认链展示口径（确认锚点上移批次）──
ALTER TABLE "Sample" ADD COLUMN IF NOT EXISTS "designConfirmStatus" TEXT;

-- ── ProductAsset：产品来源（溯源）──
ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "sourceDetail" TEXT;

-- ── SampleCardItem：封样实物级 tag + 标准批次 reference + 寄出(终态) + 批次归属 ──
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "sealedStatus" TEXT NOT NULL DEFAULT 'unsealed';
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "sealedAt" BIGINT;
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "sealedBy" TEXT;
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "standardBatchNo" TEXT;
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
CREATE INDEX IF NOT EXISTS "SampleCardItem_batchId_idx" ON "SampleCardItem"("batchId");

-- ── SampleCardLoan：出样语义（loanType 值域加 ship，由应用层约束）──

-- ── InvoiceLine：发票行（费用行为开票唯一来源；一费用行最多一张票的一行）──
CREATE TABLE IF NOT EXISTS "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "description" TEXT,
    "createdAt" BIGINT NOT NULL,
    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceLine_sourceType_sourceId_key" ON "InvoiceLine"("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");
