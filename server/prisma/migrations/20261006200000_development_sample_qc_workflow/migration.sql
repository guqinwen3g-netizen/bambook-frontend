-- Separate the factory-return result from QC review and physical sample-room
-- intake. Each real sample form receives one immutable QC task and frozen source.

BEGIN;

ALTER TABLE "SampleBatch"
  ADD COLUMN IF NOT EXISTS "returnedAt" BIGINT,
  ADD COLUMN IF NOT EXISTS "returnedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "returnRequestKey" TEXT,
  ADD COLUMN IF NOT EXISTS "returnFingerprint" VARCHAR(64);

CREATE TABLE IF NOT EXISTS "DevelopmentSampleQualityReview" (
  "id" TEXT NOT NULL,
  "sampleBatchId" TEXT NOT NULL,
  "developmentCaseId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "sourceFingerprint" VARCHAR(64) NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "requestedBy" TEXT NOT NULL,
  "requestedAt" BIGINT NOT NULL,
  "startedBy" TEXT,
  "startedAt" BIGINT,
  "result" TEXT,
  "opinion" TEXT,
  "inspectionDate" TEXT,
  "inspectorOrg" TEXT,
  "criticalDefects" INTEGER NOT NULL DEFAULT 0,
  "majorDefects" INTEGER NOT NULL DEFAULT 0,
  "minorDefects" INTEGER NOT NULL DEFAULT 0,
  "evidence" JSONB,
  "reviewedBy" TEXT,
  "reviewedAt" BIGINT,
  "completionRequestKey" TEXT,
  "completionFingerprint" VARCHAR(64),
  "acknowledgedBy" TEXT,
  "acknowledgedAt" BIGINT,
  "acknowledgementRequestKey" TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  CONSTRAINT "DevelopmentSampleQualityReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_sampleBatchId_key"
  ON "DevelopmentSampleQualityReview"("sampleBatchId");
CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_requestKey_key"
  ON "DevelopmentSampleQualityReview"("requestKey");
CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_completionRequestKey_key"
  ON "DevelopmentSampleQualityReview"("completionRequestKey");
CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_acknowledgementRequestKey_key"
  ON "DevelopmentSampleQualityReview"("acknowledgementRequestKey");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_status_requestedAt_idx"
  ON "DevelopmentSampleQualityReview"("status", "requestedAt");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_developmentCaseId_requestedAt_idx"
  ON "DevelopmentSampleQualityReview"("developmentCaseId", "requestedAt");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleQualityReview_requestedBy_requestedAt_idx"
  ON "DevelopmentSampleQualityReview"("requestedBy", "requestedAt");

COMMIT;
