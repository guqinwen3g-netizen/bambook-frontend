-- Phase B4 — 三级样衣节点 + QC 验货报告扩展

-- CreateTable: SampleNode（三级样衣节点：确认样/产前样/大货样）
CREATE TABLE IF NOT EXISTS "SampleNode" (
    "id" TEXT NOT NULL,
    "developmentCaseId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sentDate" TEXT,
    "courier" TEXT,
    "trackingNumber" TEXT,
    "feedback" TEXT,
    "feedbackDate" TEXT,
    "approvedAt" BIGINT,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "SampleNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SampleNode_developmentCaseId_level_key" ON "SampleNode"("developmentCaseId", "level");
CREATE INDEX IF NOT EXISTS "SampleNode_developmentCaseId_idx" ON "SampleNode"("developmentCaseId");
CREATE INDEX IF NOT EXISTS "SampleNode_status_idx" ON "SampleNode"("status");

-- AlterTable: InspectionReport — 支持中期+终期多份报告与 AQL/疵点明细
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "inspectionType" TEXT NOT NULL DEFAULT 'final';
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "inspectionDate" TEXT;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "inspectorOrg" TEXT;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "aqlLevel" TEXT;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "lotSize" INTEGER;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "sampleSize" INTEGER;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "criticalDefects" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "majorDefects" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "minorDefects" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "defectSummary" TEXT;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "result" TEXT;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "shipmentId" TEXT;
ALTER TABLE "InspectionReport" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- 旧唯一约束（每单一份）→ 复合唯一（每单每种类型一份）
DROP INDEX IF EXISTS "InspectionReport_orderId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "InspectionReport_orderId_inspectionType_key" ON "InspectionReport"("orderId", "inspectionType");
