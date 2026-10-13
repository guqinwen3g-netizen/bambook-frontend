ALTER TABLE "CostRecord" ADD COLUMN "registrationKey" TEXT, ADD COLUMN "registrationFingerprint" TEXT;
CREATE UNIQUE INDEX "CostRecord_registrationKey_key" ON "CostRecord"("registrationKey");
