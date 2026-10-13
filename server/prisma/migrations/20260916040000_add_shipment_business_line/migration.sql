-- T2/D8-Q3 品类下沉到运单：Shipment.businessLine 由订单 businessLine 派生回填
-- （合票边界已由服务层校验「同业务线」，故取主订单/任一分配订单值一致）
ALTER TABLE "Shipment" ADD COLUMN "businessLine" TEXT;

-- 存量回填：按 orderId 投影取订单品类；无主订单的散货运单保持 null
UPDATE "Shipment" s
SET "businessLine" = o."businessLine"
FROM "Order" o
WHERE s."orderId" = o."id" AND o."businessLine" IS NOT NULL;

-- 软删订单不回填（保持 null，与散货同口径）
UPDATE "Shipment" s
SET "businessLine" = NULL
WHERE s."businessLine" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "Order" o WHERE s."orderId" = o."id" AND o."deletedAt" IS NOT NULL
);
