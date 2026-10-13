-- AlterTable
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS     "fabricSpec" TEXT,
ADD COLUMN IF NOT EXISTS     "processSpec" TEXT,
ADD COLUMN IF NOT EXISTS     "sampleInvoiceId" TEXT,
ADD COLUMN IF NOT EXISTS     "sampleRecipientAddress" TEXT,
ADD COLUMN IF NOT EXISTS     "sampleRecipientCompany" TEXT,
ADD COLUMN IF NOT EXISTS     "sampleRecipientName" TEXT,
ADD COLUMN IF NOT EXISTS     "sampleRecipientPhone" TEXT,
ADD COLUMN IF NOT EXISTS     "sampleShippingFee" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS     "sizeSpec" TEXT,
ADD COLUMN IF NOT EXISTS     "styleSpec" TEXT;

-- AlterTable
ALTER TABLE "FabricShipmentSample" ADD COLUMN IF NOT EXISTS     "shippingFee" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS     "availableQty" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS     "devCaseId" TEXT,
ADD COLUMN IF NOT EXISTS     "maxStock" INTEGER,
ADD COLUMN IF NOT EXISTS     "minStock" INTEGER,
ADD COLUMN IF NOT EXISTS     "orderId" TEXT,
ADD COLUMN IF NOT EXISTS     "productAssetId" TEXT,
ADD COLUMN IF NOT EXISTS     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS     "unit" TEXT DEFAULT '张',
ADD COLUMN IF NOT EXISTS     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "SampleCardLoan" ADD COLUMN IF NOT EXISTS     "loanQuantity" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SupplierInquiry" (
    "id" TEXT NOT NULL,
    "inquiryNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "materialCode" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "currency" TEXT NOT NULL,
    "expectedDeliveryDate" TEXT,
    "orderId" TEXT,
    "bomId" TEXT,
    "buyer" TEXT,
    "supplierQuotes" JSONB,
    "selectedSupplierId" TEXT,
    "selectedSupplierName" TEXT,
    "decisionNote" TEXT,
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "SupplierInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierInquiry_inquiryNumber_key" ON "SupplierInquiry"("inquiryNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierInquiry_status_idx" ON "SupplierInquiry"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierInquiry_inquiryNumber_idx" ON "SupplierInquiry"("inquiryNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierInquiry_materialCode_idx" ON "SupplierInquiry"("materialCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierInquiry_orderId_idx" ON "SupplierInquiry"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupplierInquiry_selectedSupplierId_idx" ON "SupplierInquiry"("selectedSupplierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SampleCardItem_warehouseId_idx" ON "SampleCardItem"("warehouseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SampleCardItem_devCaseId_idx" ON "SampleCardItem"("devCaseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SampleCardItem_orderId_idx" ON "SampleCardItem"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SampleCardItem_productAssetId_idx" ON "SampleCardItem"("productAssetId");

