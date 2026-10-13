-- 面料开发链（DR-050）：DevelopmentCase 面料扩展字段 + 4 新表（DevelopmentSupplier/SampleBatch/SealSample/SealSampleBatch）
-- 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/面料开发流程.md
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 可重复执行

-- AlterTable: DevelopmentCase 面料扩展（立项/技术评审，type=fabric 专用）
ALTER TABLE "DevelopmentCase"
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "dyeMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "departmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "departmentName" TEXT,
  ADD COLUMN IF NOT EXISTS "specComposition" TEXT,
  ADD COLUMN IF NOT EXISTS "specWeight" TEXT,
  ADD COLUMN IF NOT EXISTS "specWidth" TEXT,
  ADD COLUMN IF NOT EXISTS "specWeave" TEXT,
  ADD COLUMN IF NOT EXISTS "specFinish" TEXT,
  ADD COLUMN IF NOT EXISTS "targetPrice" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "moqEstimate" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "techReviewStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "techReviewNote" TEXT,
  ADD COLUMN IF NOT EXISTS "techReviewAt" TEXT,
  ADD COLUMN IF NOT EXISTS "techReviewBy" TEXT;

-- CreateTable: DevelopmentSupplier（开发供应商，开发案↔工厂多对多）
CREATE TABLE IF NOT EXISTS "DevelopmentSupplier" (
    "id" TEXT NOT NULL,
    "developmentCaseId" TEXT NOT NULL,
    "supplierRelationId" TEXT NOT NULL,
    "supplierName" TEXT,
    "quoteNote" TEXT,
    "leadTime" TEXT,
    "trialConclusion" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "DevelopmentSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SampleBatch（统一样品批次，色样/手织样/米样一套模型）
CREATE TABLE IF NOT EXISTS "SampleBatch" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "developmentCaseId" TEXT NOT NULL,
    "supplierRelationId" TEXT NOT NULL,
    "supplierName" TEXT,
    "sampleType" TEXT NOT NULL,
    "specNote" TEXT,
    "round" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentDate" TEXT,
    "courier" TEXT,
    "trackingNumber" TEXT,
    "shippingFee" DOUBLE PRECISION,
    "feedback" TEXT,
    "feedbackDate" TEXT,
    "approvedAt" BIGINT,
    "approvedBy" TEXT,
    "dyeLotNo" TEXT,
    "colorRating" INTEGER,
    "sideDiff" INTEGER,
    "endDiff" INTEGER,
    "defectCauses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customerStatus" TEXT,
    "approvedAsSealed" BOOLEAN NOT NULL DEFAULT false,
    "customerFeedbackNote" TEXT,
    "customerFeedbackDate" TEXT,
    "photos" JSONB,
    "convertedProductAssetId" TEXT,
    "convertedAt" BIGINT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "SampleBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SealSample（封样，同厂批次组合）
CREATE TABLE IF NOT EXISTS "SealSample" (
    "id" TEXT NOT NULL,
    "sealCode" TEXT NOT NULL,
    "developmentCaseId" TEXT NOT NULL,
    "supplierRelationId" TEXT NOT NULL,
    "name" TEXT,
    "standardNo" TEXT,
    "retainLocation" TEXT,
    "qualityNote" TEXT,
    "customerRelationId" TEXT,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "convertedProductAssetId" TEXT,
    "convertedAt" BIGINT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "SealSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SealSampleBatch（封样↔批次组合）
CREATE TABLE IF NOT EXISTS "SealSampleBatch" (
    "id" TEXT NOT NULL,
    "sealSampleId" TEXT NOT NULL,
    "sampleBatchId" TEXT NOT NULL,
    CONSTRAINT "SealSampleBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DevelopmentSupplier_developmentCaseId_idx" ON "DevelopmentSupplier"("developmentCaseId");
CREATE INDEX IF NOT EXISTS "DevelopmentSupplier_supplierRelationId_idx" ON "DevelopmentSupplier"("supplierRelationId");
CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSupplier_developmentCaseId_supplierRelationId_key" ON "DevelopmentSupplier"("developmentCaseId", "supplierRelationId");
CREATE UNIQUE INDEX IF NOT EXISTS "SampleBatch_batchCode_key" ON "SampleBatch"("batchCode");
CREATE INDEX IF NOT EXISTS "SampleBatch_developmentCaseId_idx" ON "SampleBatch"("developmentCaseId");
CREATE INDEX IF NOT EXISTS "SampleBatch_supplierRelationId_idx" ON "SampleBatch"("supplierRelationId");
CREATE INDEX IF NOT EXISTS "SampleBatch_sampleType_idx" ON "SampleBatch"("sampleType");
CREATE INDEX IF NOT EXISTS "SampleBatch_status_idx" ON "SampleBatch"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "SealSample_sealCode_key" ON "SealSample"("sealCode");
CREATE INDEX IF NOT EXISTS "SealSample_developmentCaseId_idx" ON "SealSample"("developmentCaseId");
CREATE INDEX IF NOT EXISTS "SealSample_supplierRelationId_idx" ON "SealSample"("supplierRelationId");
CREATE INDEX IF NOT EXISTS "SealSample_status_idx" ON "SealSample"("status");
CREATE INDEX IF NOT EXISTS "SealSampleBatch_sampleBatchId_idx" ON "SealSampleBatch"("sampleBatchId");
CREATE UNIQUE INDEX IF NOT EXISTS "SealSampleBatch_sealSampleId_sampleBatchId_key" ON "SealSampleBatch"("sealSampleId", "sampleBatchId");
