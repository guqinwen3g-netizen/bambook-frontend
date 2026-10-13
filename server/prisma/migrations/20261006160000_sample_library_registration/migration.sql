ALTER TABLE "SampleCardItem" ADD COLUMN "libraryMetadata" JSONB,
 ADD COLUMN "customerRelationId" TEXT,
 ADD COLUMN "custodianUserId" TEXT,
 ADD COLUMN "registrationKey" TEXT,
 ADD COLUMN "registrationFingerprint" TEXT;
CREATE UNIQUE INDEX "SampleCardItem_registrationKey_key" ON "SampleCardItem"("registrationKey");
