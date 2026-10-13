-- 索引补齐（查询性能优化）：为高频排序/筛选字段补 5 个缺失索引，删除 1 个冗余索引。
-- 新增：Order.dueDate（交期筛选/到期提醒）、Order.updatedAt（列表排序）、
--       Relation.lastInteraction（CRM 最近互动排序）、StockMovement.createdAt（流水时间排序）、
--       ProductAsset.updatedAt（档案更新排序）。
-- 删除：ProductAsset @@index([sku]) —— sku 已有 @unique 唯一索引，二级索引冗余，徒增写放大。
-- 纯索引 DDL，无数据变更；沿用账本幂等化惯例（IF [NOT] EXISTS），任何一侧已有同名索引均可安全通过。

-- DropIndex
DROP INDEX IF EXISTS "ProductAsset_sku_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_dueDate_idx" ON "Order"("dueDate");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_updatedAt_idx" ON "Order"("updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductAsset_updatedAt_idx" ON "ProductAsset"("updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Relation_lastInteraction_idx" ON "Relation"("lastInteraction");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StockMovement_createdAt_idx" ON "StockMovement"("createdAt");
