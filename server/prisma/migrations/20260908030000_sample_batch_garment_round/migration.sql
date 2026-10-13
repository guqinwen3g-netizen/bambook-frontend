-- DR-054 阶段 G-Ⅱ：SampleBatch 扩展——成衣轮次并入批次机制（QC 门禁 + 扩展字段 JSON）
-- 手写幂等 SQL（对齐 DR-054 惯例：ADD COLUMN IF NOT EXISTS）

ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "qcStatus" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "qcReviewedBy" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "qcReviewedAt" BIGINT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "qcInspectionReportId" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "attachments" JSONB;
