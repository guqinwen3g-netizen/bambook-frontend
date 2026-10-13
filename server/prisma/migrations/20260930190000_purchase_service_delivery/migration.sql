ALTER TABLE "PurchaseLine" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'Material', ADD COLUMN "orderLineId" TEXT;
ALTER TABLE "ProcurementDemand" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'Material';
CREATE TABLE "PurchaseServiceDelivery" (
"id" TEXT PRIMARY KEY, "purchaseOrderId" TEXT NOT NULL, "purchaseLineId" TEXT NOT NULL,
"orderId" TEXT NOT NULL, "orderLineId" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
"requestFingerprint" TEXT NOT NULL, "deliveryNumber" TEXT NOT NULL, "deliveredAt" TEXT NOT NULL,
"acceptedQuantity" DECIMAL(18,4) NOT NULL, "rejectedQuantity" DECIMAL(18,4) NOT NULL,
"unit" TEXT NOT NULL, "unitPriceSnapshot" DECIMAL(18,4) NOT NULL, "currencySnapshot" TEXT NOT NULL,
"acceptedAmount" DECIMAL(18,4) NOT NULL, "evidenceReference" TEXT NOT NULL, "notes" TEXT,
"createdBy" TEXT NOT NULL, "createdAt" BIGINT NOT NULL
);
CREATE UNIQUE INDEX "PurchaseServiceDelivery_requestKey_key" ON "PurchaseServiceDelivery"("requestKey");
CREATE INDEX "PurchaseServiceDelivery_purchaseOrderId_idx" ON "PurchaseServiceDelivery"("purchaseOrderId");
CREATE INDEX "PurchaseServiceDelivery_purchaseLineId_idx" ON "PurchaseServiceDelivery"("purchaseLineId");
CREATE INDEX "PurchaseServiceDelivery_orderId_idx" ON "PurchaseServiceDelivery"("orderId");
