-- Additive nullable facts: existing unknown trade dates remain unknown.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryPlace" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "expectedArrivalDate" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "agreedArrivalDate" TEXT;
