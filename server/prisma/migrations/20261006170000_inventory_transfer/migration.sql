CREATE TABLE "InventoryTransfer" (
 "id" TEXT PRIMARY KEY,"requestKey" TEXT NOT NULL UNIQUE,"requestHash" TEXT NOT NULL,"sourceItemId" TEXT NOT NULL REFERENCES "InventoryItem"("id"),"targetWarehouseId" TEXT NOT NULL REFERENCES "Warehouse"("id"),"quantity" DECIMAL(18,4) NOT NULL,"receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,"unit" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'pending',"note" TEXT NOT NULL,"createdBy" TEXT NOT NULL,"dispatchedAt" TEXT,"completedAt" TEXT,"history" JSONB NOT NULL DEFAULT '[]',"createdAt" BIGINT NOT NULL,"updatedAt" BIGINT NOT NULL);
CREATE INDEX "InventoryTransfer_status_idx" ON "InventoryTransfer"("status");
CREATE INDEX "InventoryTransfer_sourceItemId_idx" ON "InventoryTransfer"("sourceItemId");
