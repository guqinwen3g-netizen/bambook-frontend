-- Explicit development sample hierarchy:
-- DevelopmentSampleRound (shared requirement) -> DevelopmentSampleVersion (factory design)
-- -> SampleBatch (physical sample/form). Existing records remain unlinked unless created
-- through the new workflow; no historical factory/round relationships are inferred here.

BEGIN;

CREATE TABLE IF NOT EXISTS "DevelopmentSampleRound" (
  "id" TEXT NOT NULL,
  "developmentCaseId" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "purpose" TEXT,
  "clientVersion" TEXT,
  "materialConfig" TEXT,
  "notes" TEXT,
  "createdBy" TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,
  CONSTRAINT "DevelopmentSampleRound_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSampleRound_developmentCaseId_round_key"
  ON "DevelopmentSampleRound"("developmentCaseId", "round");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleRound_developmentCaseId_deletedAt_idx"
  ON "DevelopmentSampleRound"("developmentCaseId", "deletedAt");

CREATE TABLE IF NOT EXISTS "DevelopmentSampleVersion" (
  "id" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "developmentCaseId" TEXT NOT NULL,
  "supplierRelationId" TEXT NOT NULL,
  "supplierName" TEXT,
  "versionLabel" TEXT NOT NULL,
  "versionKind" TEXT NOT NULL DEFAULT 'major',
  "parentVersionId" TEXT,
  "minorVersion" INTEGER NOT NULL DEFAULT 0,
  "minorChangeNote" TEXT,
  "createdBy" TEXT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,
  CONSTRAINT "DevelopmentSampleVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DevelopmentSampleVersion_roundId_supplierRelationId_minorVersion_key"
  ON "DevelopmentSampleVersion"("roundId", "supplierRelationId", "minorVersion");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleVersion_developmentCaseId_roundId_idx"
  ON "DevelopmentSampleVersion"("developmentCaseId", "roundId");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleVersion_parentVersionId_idx"
  ON "DevelopmentSampleVersion"("parentVersionId");
CREATE INDEX IF NOT EXISTS "DevelopmentSampleVersion_versionLabel_idx"
  ON "DevelopmentSampleVersion"("versionLabel");

ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "sampleVersionId" TEXT;
CREATE INDEX IF NOT EXISTS "SampleBatch_sampleVersionId_idx" ON "SampleBatch"("sampleVersionId");

ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "sourceSampleVersionId" TEXT;
CREATE INDEX IF NOT EXISTS "ProductAsset_sourceSampleVersionId_idx" ON "ProductAsset"("sourceSampleVersionId");

COMMIT;
