-- Additive neutral production ranges only. No legacy source, approvals, stock
-- receipts, QC coverage or actual-shipment quantities are backfilled.
-- AlterTable
ALTER TABLE "ReleaseScope" ADD COLUMN     "productionBatchRevision" INTEGER;

-- CreateTable
CREATE TABLE "ProductionBatch" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "parentBatchId" TEXT,
    "factoryRelationId" TEXT NOT NULL,
    "rangeStart" DECIMAL(18,4) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'active',
    "confirmedSourceType" TEXT NOT NULL,
    "confirmedSourceId" TEXT NOT NULL,
    "specSnapshot" JSONB NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "parameterHash" TEXT NOT NULL,
    "commandSnapshot" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ProductionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentProductionAllocation" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productionBatchId" TEXT NOT NULL,
    "productionBatchRevision" INTEGER NOT NULL,
    "plannedQty" DECIMAL(18,4),
    "actualQty" DECIMAL(18,4),
    "unit" TEXT NOT NULL,
    "scopeSnapshot" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ShipmentProductionAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionBatch_orderId_idx" ON "ProductionBatch"("orderId");

-- CreateIndex
CREATE INDEX "ProductionBatch_orderLineId_state_idx" ON "ProductionBatch"("orderLineId", "state");

-- CreateIndex
CREATE INDEX "ProductionBatch_parentBatchId_idx" ON "ProductionBatch"("parentBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBatch_orderLineId_batchCode_key" ON "ProductionBatch"("orderLineId", "batchCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBatch_orderLineId_createdBy_requestKey_key" ON "ProductionBatch"("orderLineId", "createdBy", "requestKey");

-- CreateIndex
CREATE INDEX "ShipmentProductionAllocation_shipmentId_idx" ON "ShipmentProductionAllocation"("shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentProductionAllocation_orderId_idx" ON "ShipmentProductionAllocation"("orderId");

-- CreateIndex
CREATE INDEX "ShipmentProductionAllocation_orderLineId_idx" ON "ShipmentProductionAllocation"("orderLineId");

-- CreateIndex
CREATE INDEX "ShipmentProductionAllocation_productionBatchId_state_idx" ON "ShipmentProductionAllocation"("productionBatchId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentProductionAllocation_allocationId_productionBatchId_key" ON "ShipmentProductionAllocation"("allocationId", "productionBatchId");

