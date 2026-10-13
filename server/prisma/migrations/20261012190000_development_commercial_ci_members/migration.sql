-- Additive: no invented commercial lines, round labels, customer prices or claims for old invoices.
ALTER TABLE "BillingItem"
  ADD COLUMN "developmentCommercialFingerprint" TEXT,
  ADD COLUMN "developmentCommercialConfirmedAt" BIGINT,
  ADD COLUMN "developmentCommercialConfirmedBy" TEXT,
  ADD COLUMN "developmentCommercialCostSelection" JSONB;
CREATE TABLE "DevelopmentBillingChargeLine" (
  "id" TEXT PRIMARY KEY,
  "billingItemId" TEXT NOT NULL REFERENCES "BillingItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "displayOrder" INTEGER NOT NULL CHECK ("displayOrder" >= 0),
  "purpose" TEXT NOT NULL CHECK (length(trim("purpose")) > 0),
  "description" TEXT NOT NULL CHECK (length(trim("description")) > 0),
  "roundId" TEXT,
  "roundNumber" INTEGER CHECK ("roundNumber" > 0),
  "roundLabel" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceLabel" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL CHECK ("amount" > 0),
  "currency" TEXT NOT NULL CHECK ("currency" IN ('CNY','USD')),
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  UNIQUE ("billingItemId", "displayOrder")
);
CREATE INDEX "DevelopmentBillingChargeLine_billingItemId_idx" ON "DevelopmentBillingChargeLine"("billingItemId");
CREATE TABLE "DevelopmentCiBillingClaim" (
  "id" TEXT PRIMARY KEY,
  "billingItemId" TEXT NOT NULL REFERENCES "BillingItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "documentId" TEXT NOT NULL REFERENCES "TradeDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" BIGINT NOT NULL,
  "issuedVersionId" TEXT,
  "releasedAt" BIGINT,
  "releaseReason" TEXT,
  CONSTRAINT "DevelopmentCiBillingClaim_release_check" CHECK (
    ("releasedAt" IS NULL AND "releaseReason" IS NULL)
    OR ("releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL AND length(trim("releaseReason")) > 0 AND "issuedVersionId" IS NULL)
  )
);
CREATE INDEX "DevelopmentCiBillingClaim_billingItemId_idx" ON "DevelopmentCiBillingClaim"("billingItemId");
CREATE INDEX "DevelopmentCiBillingClaim_documentId_idx" ON "DevelopmentCiBillingClaim"("documentId");
CREATE UNIQUE INDEX "DevelopmentCiBillingClaim_active_billing_key" ON "DevelopmentCiBillingClaim"("billingItemId") WHERE "releasedAt" IS NULL;
