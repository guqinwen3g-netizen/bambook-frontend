-- Preserve every old report/task and its original approvals/signatures.
-- Legacy defaults label whole-order revision 1; nullable coverage remains unknown.
-- No source, batch coverage, approval or historical evidence is backfilled.
-- DropIndex
DROP INDEX "InspectionReport_orderId_inspectionType_key";

-- AlterTable
ALTER TABLE "InspectionReport" ADD COLUMN     "commandHash" TEXT,
ADD COLUMN     "contentFingerprint" TEXT,
ADD COLUMN     "productionBatchId" TEXT,
ADD COLUMN     "productionBatchRevision" INTEGER,
ADD COLUMN     "requestKey" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "scopeFingerprint" TEXT,
ADD COLUMN     "scopeKey" TEXT NOT NULL DEFAULT 'whole_order',
ADD COLUMN     "scopeSnapshot" JSONB,
ADD COLUMN     "scopeType" TEXT NOT NULL DEFAULT 'whole_order',
ADD COLUMN     "supersedesId" TEXT;

-- AlterTable
ALTER TABLE "QCAssignment" ADD COLUMN     "commandHash" TEXT,
ADD COLUMN     "productionBatchId" TEXT,
ADD COLUMN     "productionBatchRevision" INTEGER,
ADD COLUMN     "requestKey" TEXT,
ADD COLUMN     "scopeFingerprint" TEXT,
ADD COLUMN     "scopeKey" TEXT NOT NULL DEFAULT 'whole_order',
ADD COLUMN     "scopeSnapshot" JSONB,
ADD COLUMN     "scopeType" TEXT NOT NULL DEFAULT 'whole_order';

-- CreateIndex
CREATE INDEX "InspectionReport_productionBatchId_idx" ON "InspectionReport"("productionBatchId");

-- CreateIndex
CREATE INDEX "InspectionReport_supersedesId_idx" ON "InspectionReport"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionReport_orderId_inspectionType_scopeKey_revision_key" ON "InspectionReport"("orderId", "inspectionType", "scopeKey", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionReport_inspectedBy_requestKey_key" ON "InspectionReport"("inspectedBy", "requestKey");

-- CreateIndex
CREATE INDEX "QCAssignment_orderId_inspectionType_scopeKey_idx" ON "QCAssignment"("orderId", "inspectionType", "scopeKey");

-- CreateIndex
CREATE INDEX "QCAssignment_productionBatchId_idx" ON "QCAssignment"("productionBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "QCAssignment_assignedById_requestKey_key" ON "QCAssignment"("assignedById", "requestKey");

