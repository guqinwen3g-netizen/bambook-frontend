-- New verified factory loading facts only. Existing warehouse or shipment
-- records are not interpreted as factory receipts or backfilled as verified.
CREATE TABLE "FactoryLoadingReceipt" (
  "id" TEXT NOT NULL,
  "handoffId" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "allocationId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "productionBatchRevision" INTEGER NOT NULL,
  "factoryRelationId" TEXT NOT NULL,
  "scopeFingerprint" VARCHAR(64) NOT NULL,
  "scopeSnapshot" JSONB NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "unit" TEXT NOT NULL,
  "loadingDate" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "verifiedAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "commandHash" VARCHAR(64) NOT NULL,
  "commandSnapshot" JSONB NOT NULL,
  "receiptSnapshot" JSONB NOT NULL,
  CONSTRAINT "FactoryLoadingReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FactoryLoadingReceipt_command_key"
  ON "FactoryLoadingReceipt"("handoffId", "productionBatchId", "createdBy", "requestKey");
CREATE INDEX "FactoryLoadingReceipt_batchRevision_idx"
  ON "FactoryLoadingReceipt"("productionBatchId", "productionBatchRevision");
CREATE INDEX "FactoryLoadingReceipt_shipmentId_idx" ON "FactoryLoadingReceipt"("shipmentId");
CREATE INDEX "FactoryLoadingReceipt_allocationId_idx" ON "FactoryLoadingReceipt"("allocationId");
