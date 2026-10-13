-- CreateEnum (procurement 状态枚举由应用层管理，DB 用 TEXT)

-- CreateTable: PurchaseOrder
CREATE TABLE IF NOT EXISTS "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "supplierRelationId" TEXT,
    "supplierName" TEXT,
    "supplierCode" TEXT,
    "currency" TEXT NOT NULL,
    "totalAmount" DECIMAL(18,4) NOT NULL,
    "exchangeRate" DECIMAL(18,4),
    "baseCurrency" TEXT NOT NULL DEFAULT 'CNY',
    "orderDate" TEXT NOT NULL,
    "expectedDeliveryDate" TEXT,
    "actualDeliveryDate" TEXT,
    "deliveryTerms" TEXT,
    "paymentTerms" TEXT,
    "shipToAddress" TEXT,
    "orderId" TEXT,
    "quotationId" TEXT,
    "bomId" TEXT,
    "buyer" TEXT,
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PurchaseLine
CREATE TABLE IF NOT EXISTS "PurchaseLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "materialCode" TEXT,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "specification" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "rejectedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "PurchaseLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable: MaterialReceipt
CREATE TABLE IF NOT EXISTS "MaterialReceipt" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "receivedDate" TEXT NOT NULL,
    "receivedBy" TEXT,
    "inspectedBy" TEXT,
    "inspectionDate" TEXT,
    "warehouseId" TEXT,
    "warehouseName" TEXT,
    "totalReceived" DECIMAL(18,4) NOT NULL,
    "totalAccepted" DECIMAL(18,4) NOT NULL,
    "totalRejected" DECIMAL(18,4) NOT NULL,
    "rejectionReason" TEXT,
    "qualityNotes" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "MaterialReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_supplierRelationId_idx" ON "PurchaseOrder"("supplierRelationId");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_poNumber_idx" ON "PurchaseOrder"("poNumber");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_orderDate_idx" ON "PurchaseOrder"("orderDate");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_orderId_idx" ON "PurchaseOrder"("orderId");

CREATE INDEX IF NOT EXISTS "PurchaseLine_purchaseOrderId_idx" ON "PurchaseLine"("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "PurchaseLine_materialCode_idx" ON "PurchaseLine"("materialCode");

CREATE INDEX IF NOT EXISTS "MaterialReceipt_purchaseOrderId_idx" ON "MaterialReceipt"("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "MaterialReceipt_status_idx" ON "MaterialReceipt"("status");
CREATE INDEX IF NOT EXISTS "MaterialReceipt_receivedDate_idx" ON "MaterialReceipt"("receivedDate");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseLine_purchaseOrderId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaterialReceipt_purchaseOrderId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "MaterialReceipt" ADD CONSTRAINT "MaterialReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE;
  END IF;
END $$;
