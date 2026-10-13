-- Additive original physical receipts only. No old inventory, production,
-- approval, QC or shipment records are inferred or rewritten.
CREATE TABLE "ProductionStockReceipt" (
    "id" TEXT NOT NULL,
    "productionBatchId" TEXT NOT NULL,
    "productionBatchRevision" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "scopeFingerprint" TEXT NOT NULL,
    "scopeSnapshot" JSONB NOT NULL,
    "movementDate" TEXT NOT NULL,
    "receiptReference" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "commandSnapshot" JSONB NOT NULL,
    "receiptSnapshot" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    CONSTRAINT "ProductionStockReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductionStockReceipt_positive_quantity" CHECK ("quantity" > 0),
    CONSTRAINT "ProductionStockReceipt_positive_revision" CHECK ("productionBatchRevision" > 0)
);
CREATE UNIQUE INDEX "ProductionStockReceipt_inventoryItemId_key" ON "ProductionStockReceipt"("inventoryItemId");
CREATE UNIQUE INDEX "ProductionStockReceipt_stockMovementId_key" ON "ProductionStockReceipt"("stockMovementId");
CREATE UNIQUE INDEX "ProductionStockReceipt_productionBatchId_createdBy_requestK_key" ON "ProductionStockReceipt"("productionBatchId", "createdBy", "requestKey");
CREATE INDEX "ProductionStockReceipt_orderId_idx" ON "ProductionStockReceipt"("orderId");
CREATE INDEX "ProductionStockReceipt_orderLineId_idx" ON "ProductionStockReceipt"("orderLineId");
CREATE INDEX "ProductionStockReceipt_warehouseId_idx" ON "ProductionStockReceipt"("warehouseId");
ALTER TABLE "ProductionStockReceipt" ADD CONSTRAINT "ProductionStockReceipt_productionBatchId_fkey" FOREIGN KEY ("productionBatchId") REFERENCES "ProductionBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductionStockReceipt" ADD CONSTRAINT "ProductionStockReceipt_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductionStockReceipt" ADD CONSTRAINT "ProductionStockReceipt_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
