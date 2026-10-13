-- D7-② 货权标记：InventoryItem 增加 ownership（默认 Owned = 我方货权，存量数据零影响）
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "ownership" TEXT NOT NULL DEFAULT 'Owned';
CREATE INDEX IF NOT EXISTS "InventoryItem_ownership_idx" ON "InventoryItem"("ownership");
