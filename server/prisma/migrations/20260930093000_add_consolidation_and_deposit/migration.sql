-- 拼柜（LCL）建模 + 定金比例（2026-09-30）
-- 真源：docs/业务变体矩阵-2026-09-16.md D1（拼柜拍板）/ D3（定金拍板）
--
-- ── D1 拼柜：为什么必须新建"柜"这个聚合体 ──
--   矩阵原话：「拼柜（LCL）常见，本轮要做『同柜多票/合票』。现有 `OrderShipmentBatch`
--   是**订单 ↔ 运单**的分配关系，语义是『一张订单分几票出』，**不是**『多票合一柜』。
--   两者不可复用，需要新概念（柜/航次维度的聚合体）。」
--   ★ 连带修正：`FCL/LCL` **不能塞进 `shippingMethod` 枚举** —— 整柜/拼柜是**装载方式**，
--     与海运/空运是**运输方式**，两个正交维度（一票可以是 Sea+LCL，也可以是 Sea+FCL）。
--     （矩阵点名 `agent/mcp/manifest.ts:537` 示例 `shippingMethod:'FCL'` 是错的。）
--
-- ── D3 定金：为什么只加比例 + 已收额两个列 ──
--   拍板：「T/T 定金比例结构化（新增 `depositRatio`）并**未收足定金不得进生产/不得发运**」。
--   判据需要两个数：应收比例（订单定）× 已收金额（收款侧归集）⇒ 只加这两列，
--   不做"已收"的第二份真源（收款归集将来从 PaymentVoucher 算，不在此冗余落库 ⇒ 防两套账）。
--
-- ★ 本仓迁移范式：**手写幂等 SQL**（`prisma migrate dev` 的 shadow DB 重放历史必崩 P3006）。
-- ★ 只做本地测试库；**生产迁移等使用方安排**（与 A1/A19 及前几批同口径）。
-- ★ `loadType` / `depositRatio` 一律**可空**：空 = 未录（不是 0）——
--    与"可空 = 未录"纪律一致，不允许把"不知道"落成 0（0 会被读成"零定金"，那是豁免，风险相反）。

-- 1) 运单：装载方式（与 shippingMethod 正交）
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "loadType" TEXT; -- FCL | LCL，空 = 未录

-- 2) 柜/航次聚合体（同柜多票的"柜"）
CREATE TABLE IF NOT EXISTS "ContainerConsolidation" (
  "id"              TEXT NOT NULL,
  "containerNo"     TEXT,
  "sealNo"          TEXT,
  "vesselOrFlight"  TEXT,
  "voyageNumber"    TEXT,
  "carrierName"     TEXT,
  "shipMethod"      TEXT,             -- Sea | Air | Land | Rail | Courier（与 Shipment.shippingMethod 同枚举）
  "etd"             TEXT,
  "eta"             TEXT,
  "portOfLoading"   TEXT,
  "portOfDischarge" TEXT,
  "notes"           TEXT,
  "status"          TEXT NOT NULL DEFAULT 'Draft',
  "createdAt"       BIGINT NOT NULL,
  "updatedAt"       BIGINT NOT NULL,
  "deletedAt"       BIGINT,
  CONSTRAINT "ContainerConsolidation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContainerConsolidation_containerNo_idx" ON "ContainerConsolidation"("containerNo");
CREATE INDEX IF NOT EXISTS "ContainerConsolidation_deletedAt_idx" ON "ContainerConsolidation"("deletedAt");

-- 3) 柜 ↔ 运单（一柜多票；同一票只许挂一个柜）
CREATE TABLE IF NOT EXISTS "ConsolidationShipment" (
  "id"              TEXT NOT NULL,
  "consolidationId" TEXT NOT NULL,
  "shipmentId"      TEXT NOT NULL,
  "note"            TEXT,
  "createdAt"       BIGINT NOT NULL,
  "deletedAt"       BIGINT,
  CONSTRAINT "ConsolidationShipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ConsolidationShipment_consolidationId_shipmentId_key"
  ON "ConsolidationShipment"("consolidationId","shipmentId");
CREATE INDEX IF NOT EXISTS "ConsolidationShipment_shipmentId_idx" ON "ConsolidationShipment"("shipmentId");

-- 4) 订单：定金比例与币种（已收额**不落库**，由收款侧归集 ⇒ 防两套账）
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "depositRatio" DECIMAL(5, 2); -- 百分比，如 30.00 = 30%
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "depositCurrency" TEXT;
