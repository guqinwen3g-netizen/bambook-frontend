ALTER TABLE "Quotation"
 ADD COLUMN "quotationType" TEXT,
 ADD COLUMN "contactName" TEXT,
 ADD COLUMN "contactPhone" TEXT,
 ADD COLUMN "tradePlace" TEXT,
 ADD COLUMN "internalCostBasis" JSONB;
ALTER TABLE "QuotationLine"
 ADD COLUMN "productAssetId" TEXT,
 ADD COLUMN "productType" TEXT,
 ADD COLUMN "specification" TEXT,
 ADD COLUMN "moq" DECIMAL(18,4),
 ADD COLUMN "leadTimeDays" INTEGER,
 ADD COLUMN "leadTimeStart" TEXT,
 ADD COLUMN "priceTiers" JSONB;
