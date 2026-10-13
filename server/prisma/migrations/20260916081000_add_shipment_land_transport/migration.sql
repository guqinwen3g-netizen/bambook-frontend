-- T6-b 陆运段（H12）：工厂→货代仓一程（一票一段 upsert）+ 费用采集（进毛利口径未切，只记录）
-- CreateTable
CREATE TABLE "ShipmentLandTransport" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'factory_to_forwarder',
    "plannedArrivalAt" TEXT,
    "actualDeliveredAt" TEXT,
    "plateNo" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "carrierName" TEXT,
    "inlandFreightAmount" DECIMAL(18,4),
    "inlandFreightCurrency" TEXT,
    "warehouseFeeAmount" DECIMAL(18,4),
    "warehouseFeeCurrency" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ShipmentLandTransport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLandTransport_shipmentId_key" ON "ShipmentLandTransport"("shipmentId");
-- schema 声明的普通索引（与唯一索引并存；Prisma diff 以此为对齐依据）
CREATE INDEX "ShipmentLandTransport_shipmentId_idx" ON "ShipmentLandTransport"("shipmentId");
