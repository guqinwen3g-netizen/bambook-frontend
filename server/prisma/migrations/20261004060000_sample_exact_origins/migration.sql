-- Additive only. No historical inference/backfill; not executed by this implementation.
ALTER TABLE "Sample" ADD COLUMN "projectionKey" TEXT;
CREATE UNIQUE INDEX "Sample_projectionKey_key" ON "Sample"("projectionKey");
CREATE TABLE "SampleSource" (
  "id" TEXT NOT NULL,
  "sampleId" TEXT NOT NULL,
  "sampleBatchId" TEXT NOT NULL,
  "sourceRound" INTEGER NOT NULL,
  "sourceSealId" TEXT,
  "sourceSnapshot" JSONB NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "sourceUpdatedAt" BIGINT NOT NULL,
  "sourceHistoryRevision" INTEGER,
  "sourceEventId" TEXT,
  "evidenceAuditId" TEXT NOT NULL,
  "boundAt" BIGINT NOT NULL,
  "boundBy" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  CONSTRAINT "SampleSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SampleSource_sourceRound_positive" CHECK ("sourceRound" > 0),
  CONSTRAINT "SampleSource_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "Sample"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SampleSource_sampleBatchId_fkey" FOREIGN KEY ("sampleBatchId") REFERENCES "SampleBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SampleSource_sourceSealId_fkey" FOREIGN KEY ("sourceSealId") REFERENCES "SealSample"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SampleSource_sampleId_sampleBatchId_sourceRound_key" ON "SampleSource"("sampleId", "sampleBatchId", "sourceRound");
CREATE INDEX "SampleSource_sampleBatchId_sourceRound_idx" ON "SampleSource"("sampleBatchId", "sourceRound");
CREATE INDEX "SampleSource_sampleId_idx" ON "SampleSource"("sampleId");
CREATE INDEX "SampleSource_sourceSealId_idx" ON "SampleSource"("sourceSealId");
