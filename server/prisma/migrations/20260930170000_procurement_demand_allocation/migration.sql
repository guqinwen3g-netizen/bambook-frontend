CREATE TABLE "ProcurementDemand" (
 "id" TEXT PRIMARY KEY, "sourceKey" TEXT NOT NULL UNIQUE, "creationFingerprint" TEXT, "orderId" TEXT, "orderLineId" TEXT,
 "bomId" TEXT, "bomLineId" TEXT, "bomVersion" INTEGER, "description" TEXT NOT NULL, "unit" TEXT NOT NULL,
 "quantityBasis" TEXT NOT NULL DEFAULT 'ExplicitTotal', "perOutputQuantity" DECIMAL(18,4),
 "plannedOutputQuantity" DECIMAL(18,4), "requiredQuantity" DECIMAL(18,4),
 "status" TEXT NOT NULL DEFAULT 'NeedsConfirmation', "assigneeId" TEXT, "revision" INTEGER NOT NULL DEFAULT 1,
 "confirmedBy" TEXT, "confirmedAt" BIGINT, "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL
);
CREATE INDEX "ProcurementDemand_orderId_status_idx" ON "ProcurementDemand"("orderId", "status");
CREATE INDEX "ProcurementDemand_assigneeId_status_idx" ON "ProcurementDemand"("assigneeId", "status");
CREATE TABLE "PurchaseDemandAllocation" (
 "id" TEXT PRIMARY KEY, "requestKey" TEXT NOT NULL UNIQUE, "requestFingerprint" TEXT NOT NULL,
 "demandId" TEXT NOT NULL REFERENCES "ProcurementDemand"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "purchaseOrderId" TEXT NOT NULL, "purchaseLineId" TEXT NOT NULL UNIQUE, "quantity" DECIMAL(18,4) NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'Active', "createdBy" TEXT NOT NULL, "createdAt" BIGINT NOT NULL, "releasedAt" BIGINT
);
CREATE INDEX "PurchaseDemandAllocation_purchaseOrderId_status_idx" ON "PurchaseDemandAllocation"("purchaseOrderId", "status");
CREATE INDEX "PurchaseDemandAllocation_demandId_status_idx" ON "PurchaseDemandAllocation"("demandId", "status");
