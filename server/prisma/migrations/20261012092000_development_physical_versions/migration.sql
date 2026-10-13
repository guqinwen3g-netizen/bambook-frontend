-- Preserve legacy identities: new physical sequences are nullable for old rows.
ALTER TABLE "DevelopmentSampleVersion"
 ADD COLUMN "physicalSequence" INTEGER,
 ADD COLUMN "sourceVersionId" TEXT,
 ADD COLUMN "factoryCode" TEXT;
-- Historical SQL used the long literal name; Prisma db-push installations
-- truncate field names while retaining _key, yielding the second real name.
DROP INDEX IF EXISTS "DevelopmentSampleVersion_roundId_supplierRelationId_minorVersion_key";
DROP INDEX IF EXISTS "DevelopmentSampleVersion_roundId_supplierRelationId_minorVe_key";
CREATE UNIQUE INDEX "DevelopmentSampleVersion_physical_minor_key"
 ON "DevelopmentSampleVersion" ("roundId", "supplierRelationId", "physicalSequence", "minorVersion");
-- PostgreSQL UNIQUE treats NULL as distinct; retain the old uniqueness guarantee
-- specifically for historical rows until they acquire a physical sequence.
CREATE UNIQUE INDEX "DevelopmentSampleVersion_legacy_minor_key"
 ON "DevelopmentSampleVersion" ("roundId", "supplierRelationId", "minorVersion")
 WHERE "physicalSequence" IS NULL;
