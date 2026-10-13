-- 样品管理域（DR-052）：统一样品对象 Sample
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 可重复执行

-- CreateTable: Sample（设计确认 dev/seal + 生产确认 pp/top/ship/head/pioneer，类型可演进，产物级开票触点）
CREATE TABLE IF NOT EXISTS "Sample" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subType" TEXT,
    "sourceCaseId" TEXT,
    "sourceOrderId" TEXT,
    "productAssetId" TEXT,
    "supplierRelationId" TEXT,
    "supplierName" TEXT,
    "customerRelationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "round" INTEGER NOT NULL DEFAULT 1,
    "sentDate" TEXT,
    "courier" TEXT,
    "trackingNumber" TEXT,
    "shippingFee" DOUBLE PRECISION,
    "recipientName" TEXT,
    "recipientCompany" TEXT,
    "recipientAddress" TEXT,
    "recipientPhone" TEXT,
    "feedback" TEXT,
    "feedbackDate" TEXT,
    "approvedAt" BIGINT,
    "approvedBy" TEXT,
    "qcStatus" TEXT,
    "qcInspectionReportId" TEXT,
    "customerStatus" TEXT,
    "forkedFromSampleId" TEXT,
    "invoiceId" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "Sample_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Sample_code_key" ON "Sample"("code");

-- 查询加速索引
CREATE INDEX IF NOT EXISTS "Sample_type_idx" ON "Sample"("type");
CREATE INDEX IF NOT EXISTS "Sample_status_idx" ON "Sample"("status");
CREATE INDEX IF NOT EXISTS "Sample_sourceCaseId_idx" ON "Sample"("sourceCaseId");
CREATE INDEX IF NOT EXISTS "Sample_sourceOrderId_idx" ON "Sample"("sourceOrderId");
CREATE INDEX IF NOT EXISTS "Sample_productAssetId_idx" ON "Sample"("productAssetId");
CREATE INDEX IF NOT EXISTS "Sample_supplierRelationId_idx" ON "Sample"("supplierRelationId");
