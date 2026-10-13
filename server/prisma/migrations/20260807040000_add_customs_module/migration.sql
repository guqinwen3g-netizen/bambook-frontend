-- ============ Phase 5 B5 + Phase 3 C6: 外贸与报关（报关单/HS编码/信用证/出口退税/贸易单据） ============
-- 服装外贸出口合规闭环：发货 → 报关 → 退税 → 外汇结算 → 信用证

-- CreateTable: CustomsDeclaration
CREATE TABLE IF NOT EXISTS "CustomsDeclaration" (
    "id" TEXT NOT NULL,
    "declarationNumber" TEXT NOT NULL,
    "shipmentId" TEXT,
    "orderId" TEXT,
    "relationId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "declarationDate" TEXT,
    "customsCode" TEXT,
    "declarationPort" TEXT,
    "tradeTerms" TEXT,
    "totalValue" DECIMAL(18,4),
    "currency" TEXT,
    "totalPackages" INTEGER,
    "grossWeight" DECIMAL(18,4),
    "netWeight" DECIMAL(18,4),
    "originCountry" TEXT,
    "destinationCountry" TEXT,
    "consignee" TEXT,
    "consignor" TEXT,
    "declarant" TEXT,
    "agent" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "CustomsDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CustomsDeclarationLine
CREATE TABLE IF NOT EXISTS "CustomsDeclarationLine" (
    "id" TEXT NOT NULL,
    "declarationId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productCode" TEXT,
    "productName" TEXT NOT NULL,
    "hsCode" TEXT,
    "brandName" TEXT,
    "specification" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4),
    "totalAmount" DECIMAL(18,4),
    "currency" TEXT,
    "grossWeight" DECIMAL(18,4),
    "netWeight" DECIMAL(18,4),
    "originCountry" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    CONSTRAINT "CustomsDeclarationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable: HsCode
CREATE TABLE IF NOT EXISTS "HsCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "exportTaxRebateRate" DECIMAL(6,4),
    "importTariffRate" DECIMAL(6,4),
    "vatRate" DECIMAL(6,4),
    "unit" TEXT,
    "supervisionCondition" TEXT,
    "inspectionQuarantine" TEXT,
    "additionalDuty" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    CONSTRAINT "HsCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable: LetterOfCredit
CREATE TABLE IF NOT EXISTS "LetterOfCredit" (
    "id" TEXT NOT NULL,
    "lcNumber" TEXT NOT NULL,
    "relationId" TEXT,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Issued',
    "issueDate" TEXT,
    "issueBank" TEXT,
    "advisingBank" TEXT,
    "negotiatingBank" TEXT,
    "confirmingBank" TEXT,
    "applicant" TEXT,
    "beneficiary" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "availableAmount" DECIMAL(18,4),
    "expiryDate" TEXT,
    "expiryPlace" TEXT,
    "presentationDeadline" TEXT,
    "shipmentDeadline" TEXT,
    "tradeTerms" TEXT,
    "portOfLoading" TEXT,
    "portOfDischarge" TEXT,
    "documentsRequired" JSONB,
    "specialConditions" TEXT,
    "discrepancies" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "LetterOfCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TaxRefund
CREATE TABLE IF NOT EXISTS "TaxRefund" (
    "id" TEXT NOT NULL,
    "refundNumber" TEXT NOT NULL,
    "declarationId" TEXT,
    "orderId" TEXT,
    "relationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "exportDate" TEXT,
    "declarationDate" TEXT,
    "fxRate" DECIMAL(18,8),
    "exportAmountFob" DECIMAL(18,4),
    "exportAmountFobCurrency" TEXT,
    "exportAmountCny" DECIMAL(18,4),
    "refundableVat" DECIMAL(18,4),
    "refundableRate" DECIMAL(6,4),
    "refundAmount" DECIMAL(18,4),
    "refundDate" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" BIGINT,
    "reviewNotes" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "TaxRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TradeDocument
CREATE TABLE IF NOT EXISTS "TradeDocument" (
    "id" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "shipmentId" TEXT,
    "declarationId" TEXT,
    "orderId" TEXT,
    "relationId" TEXT,
    "issueDate" TEXT,
    "expiryDate" TEXT,
    "issuedBy" TEXT,
    "consignee" TEXT,
    "consignor" TEXT,
    "portOfLoading" TEXT,
    "portOfDischarge" TEXT,
    "totalAmount" DECIMAL(18,4),
    "currency" TEXT,
    "filePath" TEXT,
    "fileName" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "TradeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: CustomsDeclaration
CREATE UNIQUE INDEX IF NOT EXISTS "CustomsDeclaration_declarationNumber_key" ON "CustomsDeclaration"("declarationNumber");
CREATE INDEX IF NOT EXISTS "CustomsDeclaration_shipmentId_idx" ON "CustomsDeclaration"("shipmentId");
CREATE INDEX IF NOT EXISTS "CustomsDeclaration_orderId_idx" ON "CustomsDeclaration"("orderId");
CREATE INDEX IF NOT EXISTS "CustomsDeclaration_relationId_idx" ON "CustomsDeclaration"("relationId");
CREATE INDEX IF NOT EXISTS "CustomsDeclaration_status_idx" ON "CustomsDeclaration"("status");
CREATE INDEX IF NOT EXISTS "CustomsDeclaration_type_idx" ON "CustomsDeclaration"("type");

-- CreateIndex: CustomsDeclarationLine
CREATE INDEX IF NOT EXISTS "CustomsDeclarationLine_declarationId_idx" ON "CustomsDeclarationLine"("declarationId");
CREATE INDEX IF NOT EXISTS "CustomsDeclarationLine_hsCode_idx" ON "CustomsDeclarationLine"("hsCode");

-- CreateIndex: HsCode
CREATE UNIQUE INDEX IF NOT EXISTS "HsCode_code_key" ON "HsCode"("code");
CREATE INDEX IF NOT EXISTS "HsCode_category_idx" ON "HsCode"("category");
CREATE INDEX IF NOT EXISTS "HsCode_isActive_idx" ON "HsCode"("isActive");

-- CreateIndex: LetterOfCredit
CREATE UNIQUE INDEX IF NOT EXISTS "LetterOfCredit_lcNumber_key" ON "LetterOfCredit"("lcNumber");
CREATE INDEX IF NOT EXISTS "LetterOfCredit_relationId_idx" ON "LetterOfCredit"("relationId");
CREATE INDEX IF NOT EXISTS "LetterOfCredit_orderId_idx" ON "LetterOfCredit"("orderId");
CREATE INDEX IF NOT EXISTS "LetterOfCredit_status_idx" ON "LetterOfCredit"("status");

-- CreateIndex: TaxRefund
CREATE UNIQUE INDEX IF NOT EXISTS "TaxRefund_refundNumber_key" ON "TaxRefund"("refundNumber");
CREATE INDEX IF NOT EXISTS "TaxRefund_declarationId_idx" ON "TaxRefund"("declarationId");
CREATE INDEX IF NOT EXISTS "TaxRefund_orderId_idx" ON "TaxRefund"("orderId");
CREATE INDEX IF NOT EXISTS "TaxRefund_relationId_idx" ON "TaxRefund"("relationId");
CREATE INDEX IF NOT EXISTS "TaxRefund_status_idx" ON "TaxRefund"("status");

-- CreateIndex: TradeDocument
CREATE UNIQUE INDEX IF NOT EXISTS "TradeDocument_documentNumber_key" ON "TradeDocument"("documentNumber");
CREATE INDEX IF NOT EXISTS "TradeDocument_shipmentId_idx" ON "TradeDocument"("shipmentId");
CREATE INDEX IF NOT EXISTS "TradeDocument_declarationId_idx" ON "TradeDocument"("declarationId");
CREATE INDEX IF NOT EXISTS "TradeDocument_orderId_idx" ON "TradeDocument"("orderId");
CREATE INDEX IF NOT EXISTS "TradeDocument_relationId_idx" ON "TradeDocument"("relationId");
CREATE INDEX IF NOT EXISTS "TradeDocument_type_idx" ON "TradeDocument"("type");
CREATE INDEX IF NOT EXISTS "TradeDocument_status_idx" ON "TradeDocument"("status");

-- AddForeignKey: CustomsDeclarationLine → CustomsDeclaration
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomsDeclarationLine_declarationId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "CustomsDeclarationLine" ADD CONSTRAINT "CustomsDeclarationLine_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "CustomsDeclaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
