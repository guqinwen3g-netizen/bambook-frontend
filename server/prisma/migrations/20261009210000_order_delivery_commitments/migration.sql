ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "contractDeliveryDate" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "agreedDeliveryDate" TEXT;
ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "deliveryAgreementBasis" TEXT;
