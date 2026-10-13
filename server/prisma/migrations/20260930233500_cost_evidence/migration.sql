CREATE TABLE "CostEvidence" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "costRecordId" TEXT NOT NULL REFERENCES "CostRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "requestKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "originalName" TEXT NOT NULL, "storageKey" TEXT NOT NULL,
 "mimeType" TEXT NOT NULL, "byteSize" INTEGER NOT NULL,
 "sha256" TEXT NOT NULL, "note" TEXT NOT NULL,
 "createdBy" TEXT NOT NULL, "createdAt" BIGINT NOT NULL,
 "revokedBy" TEXT, "revokedAt" BIGINT, "revokeReason" TEXT
);
CREATE UNIQUE INDEX "CostEvidence_storageKey_key" ON "CostEvidence"("storageKey");
CREATE UNIQUE INDEX "CostEvidence_costRecordId_requestKey_key" ON "CostEvidence"("costRecordId", "requestKey");
CREATE INDEX "CostEvidence_costRecordId_createdAt_idx" ON "CostEvidence"("costRecordId", "createdAt");
