CREATE TABLE "ShipmentHandoff" (
  "id" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "businessActorId" TEXT NOT NULL,
  "logisticsActorId" TEXT,
  "requestKey" TEXT,
  "commandHash" TEXT,
  "note" TEXT,
  "discrepancyReason" TEXT,
  "businessResponse" TEXT,
  "returnedToBusinessAt" BIGINT,
  "businessRespondedAt" BIGINT,
  "completedAt" BIGINT,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  CONSTRAINT "ShipmentHandoff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShipmentHandoffLine" (
  "id" TEXT NOT NULL,
  "handoffId" TEXT NOT NULL,
  "allocationId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "productionBatchRevision" INTEGER NOT NULL,
  "factoryRelationId" TEXT NOT NULL,
  "factoryName" TEXT,
  "scopeFingerprint" TEXT NOT NULL,
  "plannedQty" DECIMAL(18,4) NOT NULL,
  "unit" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "ShipmentHandoffLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShipmentHandoffEvent" (
  "id" TEXT NOT NULL,
  "handoffId" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "ShipmentHandoffEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShipmentHandoffEvent"
  ADD COLUMN "decision" TEXT,
  ADD COLUMN "payload" JSONB;

ALTER TABLE "ShipmentHandoffLine"
  ADD COLUMN "partialShipmentAllowed" BOOLEAN;

ALTER TABLE "OrderLine"
  ADD COLUMN "partialShipmentAllowed" BOOLEAN;

CREATE UNIQUE INDEX "ShipmentHandoff_shipmentId_key" ON "ShipmentHandoff"("shipmentId");
CREATE UNIQUE INDEX "ShipmentHandoff_businessActorId_requestKey_key" ON "ShipmentHandoff"("businessActorId", "requestKey");
CREATE INDEX "ShipmentHandoff_status_createdAt_idx" ON "ShipmentHandoff"("status", "createdAt");
CREATE INDEX "ShipmentHandoff_businessActorId_createdAt_idx" ON "ShipmentHandoff"("businessActorId", "createdAt");
CREATE INDEX "ShipmentHandoffLine_handoffId_idx" ON "ShipmentHandoffLine"("handoffId");
CREATE INDEX "ShipmentHandoffLine_allocationId_idx" ON "ShipmentHandoffLine"("allocationId");
CREATE INDEX "ShipmentHandoffLine_orderId_orderLineId_idx" ON "ShipmentHandoffLine"("orderId", "orderLineId");
CREATE INDEX "ShipmentHandoffLine_productionBatchId_productionBatchRevision_idx" ON "ShipmentHandoffLine"("productionBatchId", "productionBatchRevision");
CREATE INDEX "ShipmentHandoffLine_factoryRelationId_idx" ON "ShipmentHandoffLine"("factoryRelationId");
CREATE INDEX "ShipmentHandoffEvent_handoffId_createdAt_idx" ON "ShipmentHandoffEvent"("handoffId", "createdAt");
CREATE INDEX "ShipmentHandoffEvent_actorId_createdAt_idx" ON "ShipmentHandoffEvent"("actorId", "createdAt");
