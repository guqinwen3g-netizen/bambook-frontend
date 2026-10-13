-- Preserve historical records with unknown exact-version identity. Do not infer
-- minor-version QC or requester confirmation from a parent sample/recording user.
ALTER TABLE "DevelopmentSampleQualityReview"
  ADD COLUMN "sampleVersionId" TEXT,
  ADD COLUMN "reviewSequence" INTEGER;
DROP INDEX IF EXISTS "DevelopmentSampleQualityReview_sampleBatchId_key";
CREATE INDEX "DevelopmentSampleQualityReview_sampleBatchId_requestedAt_idx"
  ON "DevelopmentSampleQualityReview"("sampleBatchId", "requestedAt");
CREATE INDEX "DevelopmentSampleQualityReview_sampleVersionId_requestedAt_idx"
  ON "DevelopmentSampleQualityReview"("sampleVersionId", "requestedAt");
CREATE UNIQUE INDEX "DevelopmentSampleQualityReview_version_sequence_key"
  ON "DevelopmentSampleQualityReview"("sampleVersionId", "reviewSequence");

CREATE TABLE "DevelopmentVersionConfirmation" (
  "id" TEXT NOT NULL,
  "developmentCaseId" TEXT NOT NULL,
  "sampleVersionId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "confirmerType" TEXT NOT NULL,
  "confirmerName" TEXT NOT NULL,
  "confirmerUserId" TEXT,
  "confirmerRelationId" TEXT,
  "confirmerOrganization" TEXT,
  "confirmedAt" BIGINT NOT NULL,
  "result" TEXT NOT NULL,
  "basis" TEXT NOT NULL,
  "evidence" JSONB,
  "recordedBy" TEXT NOT NULL,
  "recordedAt" BIGINT NOT NULL,
  "sourceFingerprint" VARCHAR(64) NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  CONSTRAINT "DevelopmentVersionConfirmation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevelopmentVersionConfirmation_requestKey_key"
  ON "DevelopmentVersionConfirmation"("requestKey");
CREATE INDEX "DevelopmentVersionConfirmation_developmentCaseId_recordedAt_idx"
  ON "DevelopmentVersionConfirmation"("developmentCaseId", "recordedAt");
CREATE INDEX "DevelopmentVersionConfirmation_sampleVersionId_recordedAt_idx"
  ON "DevelopmentVersionConfirmation"("sampleVersionId", "recordedAt");
