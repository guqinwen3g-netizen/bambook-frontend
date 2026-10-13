-- Additive only: old billing decisions are not assigned an invented review.
ALTER TABLE "BillingItem" ADD COLUMN "developmentExpenseReviewId" TEXT;
ALTER TABLE "BillingItem" ADD CONSTRAINT "BillingItem_developmentExpenseReviewId_fkey"
  FOREIGN KEY ("developmentExpenseReviewId") REFERENCES "DevelopmentExpenseReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BillingItemCostCoverage" (
  "id" TEXT PRIMARY KEY,
  "billingItemId" TEXT NOT NULL REFERENCES "BillingItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "costRecordId" TEXT NOT NULL REFERENCES "CostRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "costAmount" DECIMAL(18,4) NOT NULL CHECK ("costAmount" >= 0),
  "costCurrency" TEXT NOT NULL CHECK (length(trim("costCurrency")) > 0),
  "createdAt" BIGINT NOT NULL,
  "releasedAt" BIGINT,
  "releaseReason" TEXT,
  CONSTRAINT "BillingItemCostCoverage_release_check" CHECK (
    ("releasedAt" IS NULL AND "releaseReason" IS NULL)
    OR ("releasedAt" IS NOT NULL AND "releaseReason" IS NOT NULL AND length(trim("releaseReason")) > 0)
  )
);
CREATE UNIQUE INDEX "BillingItemCostCoverage_billingItemId_costRecordId_key" ON "BillingItemCostCoverage"("billingItemId", "costRecordId");
CREATE INDEX "BillingItemCostCoverage_costRecordId_idx" ON "BillingItemCostCoverage"("costRecordId");
CREATE UNIQUE INDEX "BillingItemCostCoverage_active_cost_key" ON "BillingItemCostCoverage"("costRecordId") WHERE "releasedAt" IS NULL;
