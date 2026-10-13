-- ★ C4 备货（无单先产）订单锚点 + 归属变更留痕（2026-09-18）
-- 口径依据：docs/零基础障碍清单-2026-09-18.md C4
--   背景：备货（工厂按预测先做、等订单来了再归属）在面料行业很常见，但
--     · `InventoryItem` 完全没有订单锚点（`StockMovement.referenceType/Id` 只记流水，
--       表达不了「这批货现在挂在谁头上」）⇒ 备货无法归属订单
--     · A 单货挪 B 单**无任何留痕**
--
-- 本迁移只做两件事，全部是**加列/加表**（对既有数据零风险，回滚 = DROP COLUMN / DROP TABLE）：
--   ① `InventoryItem` 加 `orderId`（可空）+ `stockPrep`（默认 false）
--      —— 存量行自动成为「未归属、非备货」，语义与现状一致
--   ② 新建 `InventoryOwnershipChange`（归属变更 append-only 留痕）
--      —— 为什么不复用 `StockMovement`：归属变更**不改变数量**，而 `StockMovement.quantity`
--         必填；塞 0 会让流水看起来像「数量 0 的调整」（脏数据 + 污染数量口径统计）
--
-- ⚠️ 手写 migration.sql（不用 migrate dev：本地库有既有漂移会触发 reset，见 A3 迁移同款注释）

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "orderId" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN "stockPrep" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "InventoryItem_orderId_idx" ON "InventoryItem"("orderId" ASC);
CREATE INDEX "InventoryItem_stockPrep_idx" ON "InventoryItem"("stockPrep" ASC);

-- CreateTable
CREATE TABLE "InventoryOwnershipChange" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fromOrderId" TEXT,
    "toOrderId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operatorId" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "InventoryOwnershipChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryOwnershipChange_itemId_idx" ON "InventoryOwnershipChange"("itemId" ASC);
CREATE INDEX "InventoryOwnershipChange_toOrderId_idx" ON "InventoryOwnershipChange"("toOrderId" ASC);
CREATE INDEX "InventoryOwnershipChange_fromOrderId_idx" ON "InventoryOwnershipChange"("fromOrderId" ASC);
CREATE INDEX "InventoryOwnershipChange_action_idx" ON "InventoryOwnershipChange"("action" ASC);
