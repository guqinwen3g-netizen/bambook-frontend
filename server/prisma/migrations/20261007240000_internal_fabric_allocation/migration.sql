-- Preserve unknown legacy purpose/mode; do not backfill business facts.
ALTER TABLE "Order" ADD COLUMN "orderPurpose" TEXT,
 ADD COLUMN "internalPurpose" TEXT,
 ADD COLUMN "internalDemandTeamId" TEXT,
 ADD COLUMN "internalReceiverId" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN "fulfillmentMode" TEXT, ADD COLUMN "cmtIncludedItems" JSONB;
CREATE TABLE "FabricLineAllocation" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "fabricOrderId" TEXT NOT NULL,
 "fabricOrderLineId" TEXT NOT NULL,
 "garmentOrderId" TEXT NOT NULL,
 "garmentOrderLineId" TEXT NOT NULL,
 "metres" DECIMAL(18,4) NOT NULL,
 "status" TEXT NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1,
 "lastRequestKey" TEXT NOT NULL,
 "lastRequestFingerprint" TEXT NOT NULL,
 "auditId" TEXT NOT NULL,
 "createdBy" TEXT NOT NULL,
 "updatedBy" TEXT NOT NULL,
 "createdAt" BIGINT NOT NULL,
 "updatedAt" BIGINT NOT NULL,
 CONSTRAINT "FabricLineAllocation_metres_check" CHECK ("metres">0),
 CONSTRAINT "FabricLineAllocation_revision_check" CHECK ("revision">0),
 CONSTRAINT "FabricLineAllocation_status_check" CHECK ("status" IN ('active','cancelled')),
 CONSTRAINT "FabricLineAllocation_fabricOrderLineId_fkey" FOREIGN KEY("fabricOrderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "FabricLineAllocation_garmentOrderLineId_fkey" FOREIGN KEY("garmentOrderLineId") REFERENCES "OrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FabricLineAllocation_garmentOrderLineId_key" ON "FabricLineAllocation"("garmentOrderLineId");
CREATE INDEX "FabricLineAllocation_fabricOrderLineId_status_idx" ON "FabricLineAllocation"("fabricOrderLineId","status");
CREATE INDEX "FabricLineAllocation_fabricOrderId_status_idx" ON "FabricLineAllocation"("fabricOrderId","status");
CREATE INDEX "FabricLineAllocation_garmentOrderId_status_idx" ON "FabricLineAllocation"("garmentOrderId","status");
ALTER TABLE "OrderSampleCoverage" ADD COLUMN "materialProof" JSONB;
