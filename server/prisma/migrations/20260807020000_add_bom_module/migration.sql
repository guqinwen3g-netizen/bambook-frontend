-- ============ Phase 2 B4: BOM / 成本核算 ============

-- CreateTable: BOM
CREATE TABLE IF NOT EXISTS "BOM" (
    "id" TEXT NOT NULL,
    "bomNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "productAssetId" TEXT,
    "orderId" TEXT,
    "quotationId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentBomId" TEXT,
    "totalMaterialCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalLaborCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalOverheadCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "sellingPrice" DECIMAL(18,4),
    "profitMargin" DECIMAL(8,4),
    "profitAmount" DECIMAL(18,4),
    "notes" TEXT,
    "attachments" JSONB,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "BOM_pkey" PRIMARY KEY ("id")
);

-- CreateTable: BOMLine
CREATE TABLE IF NOT EXISTS "BOMLine" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "materialType" TEXT NOT NULL,
    "materialCode" TEXT,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "specification" TEXT,
    "supplierId" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "wastagePercent" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "effectiveQty" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    CONSTRAINT "BOMLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CostEstimate
CREATE TABLE IF NOT EXISTS "CostEstimate" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "costType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    CONSTRAINT "CostEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (BOM)
CREATE UNIQUE INDEX IF NOT EXISTS "BOM_bomNumber_key" ON "BOM"("bomNumber");
CREATE INDEX IF NOT EXISTS "BOM_status_idx" ON "BOM"("status");
CREATE INDEX IF NOT EXISTS "BOM_productAssetId_idx" ON "BOM"("productAssetId");
CREATE INDEX IF NOT EXISTS "BOM_orderId_idx" ON "BOM"("orderId");
CREATE INDEX IF NOT EXISTS "BOM_quotationId_idx" ON "BOM"("quotationId");
CREATE INDEX IF NOT EXISTS "BOM_bomNumber_idx" ON "BOM"("bomNumber");

-- CreateIndex (BOMLine)
CREATE INDEX IF NOT EXISTS "BOMLine_bomId_idx" ON "BOMLine"("bomId");
CREATE INDEX IF NOT EXISTS "BOMLine_materialCode_idx" ON "BOMLine"("materialCode");
CREATE INDEX IF NOT EXISTS "BOMLine_materialType_idx" ON "BOMLine"("materialType");
CREATE INDEX IF NOT EXISTS "BOMLine_category_idx" ON "BOMLine"("category");

-- CreateIndex (CostEstimate)
CREATE INDEX IF NOT EXISTS "CostEstimate_bomId_idx" ON "CostEstimate"("bomId");
CREATE INDEX IF NOT EXISTS "CostEstimate_costType_idx" ON "CostEstimate"("costType");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BOMLine_bomId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "BOMLine" ADD CONSTRAINT "BOMLine_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "BOM"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CostEstimate_bomId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "CostEstimate" ADD CONSTRAINT "CostEstimate_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "BOM"("id") ON DELETE CASCADE;
  END IF;
END $$;
