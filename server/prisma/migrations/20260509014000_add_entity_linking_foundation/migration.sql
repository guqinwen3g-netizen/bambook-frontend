-- Add order role fields introduced during the unified order UI work.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "customerAddress" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "salesPerson" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "salesPersonRelationId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "merchandiser" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "merchandiserRelationId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "supervisor" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "supervisorRelationId" TEXT;

-- Generic references from module fields to existing source-of-truth profiles.
CREATE TABLE IF NOT EXISTS "EntityReference" (
  "id" TEXT NOT NULL,
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "fieldKey" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetPath" TEXT,
  "snapshot" JSONB,
  "confidence" DOUBLE PRECISION,
  "source" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,
  CONSTRAINT "EntityReference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EntityAlias" (
  "id" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetPath" TEXT,
  "alias" TEXT NOT NULL,
  "normalized" TEXT NOT NULL,
  "source" TEXT,
  "confidence" DOUBLE PRECISION,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,
  CONSTRAINT "EntityAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EntityLink" (
  "id" TEXT NOT NULL,
  "fromType" TEXT NOT NULL,
  "fromId" TEXT NOT NULL,
  "fromPath" TEXT,
  "toType" TEXT NOT NULL,
  "toId" TEXT NOT NULL,
  "toPath" TEXT,
  "linkKind" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION,
  "metadata" JSONB,
  "source" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,
  CONSTRAINT "EntityLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EntityReference_ownerType_ownerId_fieldKey_targetType_targetId_targetPath_key" ON "EntityReference"("ownerType", "ownerId", "fieldKey", "targetType", "targetId", "targetPath");
CREATE INDEX IF NOT EXISTS "EntityReference_ownerType_ownerId_idx" ON "EntityReference"("ownerType", "ownerId");
CREATE INDEX IF NOT EXISTS "EntityReference_fieldKey_idx" ON "EntityReference"("fieldKey");
CREATE INDEX IF NOT EXISTS "EntityReference_targetType_targetId_idx" ON "EntityReference"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "EntityReference_status_idx" ON "EntityReference"("status");
CREATE INDEX IF NOT EXISTS "EntityReference_source_idx" ON "EntityReference"("source");

CREATE INDEX IF NOT EXISTS "EntityAlias_targetType_targetId_idx" ON "EntityAlias"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "EntityAlias_targetPath_idx" ON "EntityAlias"("targetPath");
CREATE INDEX IF NOT EXISTS "EntityAlias_normalized_idx" ON "EntityAlias"("normalized");
CREATE INDEX IF NOT EXISTS "EntityAlias_source_idx" ON "EntityAlias"("source");

CREATE INDEX IF NOT EXISTS "EntityLink_fromType_fromId_idx" ON "EntityLink"("fromType", "fromId");
CREATE INDEX IF NOT EXISTS "EntityLink_toType_toId_idx" ON "EntityLink"("toType", "toId");
CREATE INDEX IF NOT EXISTS "EntityLink_linkKind_idx" ON "EntityLink"("linkKind");
CREATE INDEX IF NOT EXISTS "EntityLink_status_idx" ON "EntityLink"("status");
CREATE INDEX IF NOT EXISTS "EntityLink_source_idx" ON "EntityLink"("source");
