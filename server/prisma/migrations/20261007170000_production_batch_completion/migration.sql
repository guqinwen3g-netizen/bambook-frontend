-- Actual completed-production quantity is a separate immutable fact. Do not
-- backfill from planned ProductionBatch.quantity or Shipment allocations.
CREATE TABLE "ProductionBatchCompletion" (
    "id" TEXT NOT NULL,
    "productionBatchId" TEXT NOT NULL,
    "productionBatchRevision" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "actualQuantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "lineFingerprint" TEXT NOT NULL,
    "scopeSnapshot" JSONB NOT NULL,
    "requestKey" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "commandSnapshot" JSONB NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "recordedAt" BIGINT NOT NULL,

    CONSTRAINT "ProductionBatchCompletion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductionBatchCompletion_productionBatchId_fkey"
      FOREIGN KEY ("productionBatchId") REFERENCES "ProductionBatch"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ProductionBatchCompletion_batch_revision_key"
  ON "ProductionBatchCompletion"("productionBatchId", "productionBatchRevision");
CREATE UNIQUE INDEX "ProductionBatchCompletion_recorder_request_key"
  ON "ProductionBatchCompletion"("recordedBy", "requestKey");
CREATE INDEX "ProductionBatchCompletion_order_line_recorded_idx"
  ON "ProductionBatchCompletion"("orderId", "orderLineId", "recordedAt");
CREATE INDEX "ProductionBatchCompletion_batch_revision_idx"
  ON "ProductionBatchCompletion"("productionBatchId", "productionBatchRevision");
