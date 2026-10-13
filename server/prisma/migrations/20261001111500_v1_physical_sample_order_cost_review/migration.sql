-- AlterTable
ALTER TABLE "SampleCardItem" ADD COLUMN     "receiptSnapshot" JSONB;

-- CreateTable
CREATE TABLE "OrderCostReview" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "scopeSnapshot" JSONB NOT NULL,
    "linesSnapshot" JSONB NOT NULL,
    "coverageSnapshot" JSONB NOT NULL,
    "evidenceSnapshot" JSONB NOT NULL,
    "actualCostCny" DECIMAL(18,4) NOT NULL,
    "actualRevenueCny" DECIMAL(18,4) NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "confirmedAt" BIGINT NOT NULL,
    "supersedesId" TEXT,
    "auditId" TEXT NOT NULL,

    CONSTRAINT "OrderCostReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCostReviewEvidence" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "auditId" TEXT NOT NULL,

    CONSTRAINT "OrderCostReviewEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReview_requestKey_key" ON "OrderCostReview"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReview_supersedesId_key" ON "OrderCostReview"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReview_auditId_key" ON "OrderCostReview"("auditId");

-- CreateIndex
CREATE INDEX "OrderCostReview_orderId_confirmedAt_idx" ON "OrderCostReview"("orderId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReview_orderId_revision_key" ON "OrderCostReview"("orderId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReviewEvidence_requestKey_key" ON "OrderCostReviewEvidence"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReviewEvidence_storageKey_key" ON "OrderCostReviewEvidence"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCostReviewEvidence_auditId_key" ON "OrderCostReviewEvidence"("auditId");

-- CreateIndex
CREATE INDEX "OrderCostReviewEvidence_orderId_createdAt_idx" ON "OrderCostReviewEvidence"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderCostReview" ADD CONSTRAINT "OrderCostReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCostReview" ADD CONSTRAINT "OrderCostReview_confirmedBy_fkey" FOREIGN KEY ("confirmedBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCostReview" ADD CONSTRAINT "OrderCostReview_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCostReview" ADD CONSTRAINT "OrderCostReview_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "OrderCostReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCostReviewEvidence" ADD CONSTRAINT "OrderCostReviewEvidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCostReviewEvidence" ADD CONSTRAINT "OrderCostReviewEvidence_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCostReviewEvidence" ADD CONSTRAINT "OrderCostReviewEvidence_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

