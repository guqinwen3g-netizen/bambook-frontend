DROP INDEX IF EXISTS "Order_factoryName_idx";

ALTER TABLE "Order"
  DROP COLUMN IF EXISTS "factoryName",
  DROP COLUMN IF EXISTS "buyerName",
  DROP COLUMN IF EXISTS "buyerAddress",
  DROP COLUMN IF EXISTS "buyerPhone",
  DROP COLUMN IF EXISTS "buyerFax",
  DROP COLUMN IF EXISTS "supplierAddress";
