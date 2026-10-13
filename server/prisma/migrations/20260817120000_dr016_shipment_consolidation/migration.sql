-- DR-016 合票建模：Order↔Shipment 多对多分配记录 + Shipment 四方交易方扩展
-- 迁移三步法：① nullable 新增 → ② 回填 → ③ 约束（本步仅执行 ①，约束后续按需加）

-- ① Shipment 扩展四方交易方字段（全部可空，逐步迁移）
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "consigneeRelationId" TEXT,
ADD COLUMN IF NOT EXISTS "consigneeName" TEXT,
ADD COLUMN IF NOT EXISTS "docRecipientRelationId" TEXT,
ADD COLUMN IF NOT EXISTS "docRecipientName" TEXT,
ADD COLUMN IF NOT EXISTS "payerRelationId" TEXT,
ADD COLUMN IF NOT EXISTS "payerName" TEXT;

-- ② 新建 ShipmentOrderAllocation 表（全部字段 nullable，除 id/shipmentId/orderId/status/createdAt/updatedAt）
CREATE TABLE IF NOT EXISTS "ShipmentOrderAllocation" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT,
    "plannedQty" DECIMAL(18,4),
    "actualQty" DECIMAL(18,4),
    "unit" TEXT,
    "status" TEXT NOT NULL,
    "batchOrCartonNote" TEXT,
    "exception" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ShipmentOrderAllocation_pkey" PRIMARY KEY ("id")
);

-- 唯一约束：同票同订单行不重复分配
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentOrderAllocation_shipmentId_orderId_orderLineId_key" ON "ShipmentOrderAllocation"("shipmentId", "orderId", "orderLineId");

-- 索引
CREATE INDEX IF NOT EXISTS "ShipmentOrderAllocation_shipmentId_idx" ON "ShipmentOrderAllocation"("shipmentId");
CREATE INDEX IF NOT EXISTS "ShipmentOrderAllocation_orderId_idx" ON "ShipmentOrderAllocation"("orderId");
CREATE INDEX IF NOT EXISTS "ShipmentOrderAllocation_orderLineId_idx" ON "ShipmentOrderAllocation"("orderLineId");
CREATE INDEX IF NOT EXISTS "ShipmentOrderAllocation_status_idx" ON "ShipmentOrderAllocation"("status");

-- ③ 回填：现存 Shipment.orderId IS NOT NULL 且未软删的行 → 每票生成一条订单级分配
-- status 映射：Draft/Booked → Planned; Shipped/Arrived/Cleared/Delivered → Fulfilled 且 actualQty=plannedQty; Cancelled → Cancelled
-- plannedQty = 票内行 quantity 合计（无行则为 NULL）
INSERT INTO "ShipmentOrderAllocation" ("id", "shipmentId", "orderId", "orderLineId", "plannedQty", "actualQty", "unit", "status", "createdAt", "updatedAt")
SELECT
    'SHPA__' || upper(substring(md5(random()::text) from 1 for 12)),
    s."id",
    s."orderId",
    NULL,
    COALESCE((SELECT SUM(sl."quantity") FROM "ShipmentLine" sl WHERE sl."shipmentId" = s."id"), NULL),
    CASE
        WHEN s."status" IN ('Shipped', 'Arrived', 'Cleared', 'Delivered') THEN
            COALESCE((SELECT SUM(sl."quantity") FROM "ShipmentLine" sl WHERE sl."shipmentId" = s."id"), NULL)
        ELSE NULL
    END,
    NULL,
    CASE
        WHEN s."status" IN ('Draft', 'Booked') THEN 'Planned'
        WHEN s."status" IN ('Shipped', 'Arrived', 'Cleared', 'Delivered') THEN 'Fulfilled'
        WHEN s."status" = 'Cancelled' THEN 'Cancelled'
        ELSE 'Planned'
    END,
    s."createdAt",
    s."updatedAt"
FROM "Shipment" s
WHERE s."orderId" IS NOT NULL
  AND s."deletedAt" IS NULL;

-- 验证：回填行数 = SELECT count(*) FROM "Shipment" WHERE "orderId" IS NOT NULL AND "deletedAt" IS NULL
-- 本验证脚本作为注释保留，供 DBA 执行确认：
-- SELECT
--   (SELECT count(*) FROM "Shipment" WHERE "orderId" IS NOT NULL AND "deletedAt" IS NULL) as expected,
--   (SELECT count(*) FROM "ShipmentOrderAllocation") as actual;
