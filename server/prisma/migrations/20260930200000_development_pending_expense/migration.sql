CREATE TABLE "DevelopmentPendingExpense" (
  "id" TEXT PRIMARY KEY,
  "developmentCaseId" TEXT NOT NULL REFERENCES "DevelopmentCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceType" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
  "costType" TEXT NOT NULL, "description" TEXT NOT NULL, "ownerId" TEXT NOT NULL,
  "expectedDate" TEXT, "status" TEXT NOT NULL DEFAULT 'pending', "version" INTEGER NOT NULL DEFAULT 1,
  "requestKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
  "completionRequestKey" TEXT, "completionFingerprint" TEXT,
  "costRecordId" TEXT REFERENCES "CostRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "resolutionNote" TEXT, "createdBy" TEXT NOT NULL, "completedBy" TEXT,
  "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL, "completedAt" BIGINT,
  CONSTRAINT "DevelopmentPendingExpense_version_check" CHECK ("version" >= 1),
  CONSTRAINT "DevelopmentPendingExpense_status_check" CHECK ("status" IN ('pending', 'resolved', 'cancelled')),
  CONSTRAINT "DevelopmentPendingExpense_completion_check" CHECK (
    ("status" = 'pending' AND "costRecordId" IS NULL AND "completedAt" IS NULL AND "completedBy" IS NULL AND "completionRequestKey" IS NULL AND "completionFingerprint" IS NULL)
    OR ("status" IN ('resolved','cancelled') AND "completedAt" IS NOT NULL AND "completedBy" IS NOT NULL AND "completionRequestKey" IS NOT NULL AND "completionFingerprint" IS NOT NULL AND "resolutionNote" IS NOT NULL
      AND (("status" = 'resolved' AND "costRecordId" IS NOT NULL) OR ("status" = 'cancelled' AND "costRecordId" IS NULL)))
  )
);
CREATE UNIQUE INDEX "DevelopmentPendingExpense_developmentCaseId_requestKey_key" ON "DevelopmentPendingExpense"("developmentCaseId", "requestKey");
CREATE UNIQUE INDEX "DevelopmentPendingExpense_costRecordId_key" ON "DevelopmentPendingExpense"("costRecordId");
CREATE INDEX "DevelopmentPendingExpense_developmentCaseId_status_idx" ON "DevelopmentPendingExpense"("developmentCaseId", "status");
CREATE INDEX "DevelopmentPendingExpense_ownerId_status_idx" ON "DevelopmentPendingExpense"("ownerId", "status");
