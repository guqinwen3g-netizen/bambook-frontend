-- A customer PO can contain both fabric and garment contracts. Order.id/code
-- remain the internal unique identities. Preserve every existing reference.
DROP INDEX IF EXISTS "Order_poNumber_key";
CREATE INDEX "Order_poNumber_idx" ON "Order"("poNumber");
