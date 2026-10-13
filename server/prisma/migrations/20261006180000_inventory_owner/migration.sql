ALTER TABLE "InventoryItem" ADD COLUMN "ownerRelationId" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN "ownershipDate" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN "ownershipEvidence" TEXT;
CREATE INDEX "InventoryItem_ownerRelationId_idx" ON "InventoryItem"("ownerRelationId");
