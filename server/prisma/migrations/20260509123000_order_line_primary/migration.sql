-- Promote OrderLine into the line-level follow-up entity used by Order Management.
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'Pending';
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "productionBatch" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "shippingDate" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "shippingMethod" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "invoiceNumber" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "invoiceDate" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "shipmentQuantity" DOUBLE PRECISION;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "shipmentAmount" DOUBLE PRECISION;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "actualPaymentDate" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "actualPaymentAmount" DOUBLE PRECISION;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "specialInstructions" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "fieldSources" JSONB;

CREATE INDEX IF NOT EXISTS "OrderLine_status_idx" ON "OrderLine"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "OrderLine_orderId_itemNo_key" ON "OrderLine"("orderId", "itemNo");
