-- CreateTable
CREATE TABLE IF NOT EXISTS "TrimmingProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productAssetId" TEXT NOT NULL,
    "trimmingCode" TEXT,
    "trimmingName" TEXT,
    "trimmingCategory" TEXT,
    "material" TEXT,
    "specification" TEXT,
    "size" TEXT,
    "color" TEXT,
    "colorCode" TEXT,
    "finish" TEXT,
    "supplier" TEXT,
    "factory" TEXT,
    "brand" TEXT,
    "customer" TEXT,
    "applicableProducts" TEXT,
    "usagePosition" TEXT,
    "unit" TEXT,
    "unitConsumption" TEXT,
    "moq" TEXT,
    "leadTime" TEXT,
    "stockStatus" TEXT,
    "stockQuantity" REAL,
    "stockUnit" TEXT,
    "price" TEXT,
    "currency" TEXT,
    "complianceTests" TEXT,
    "qualityStandard" TEXT,
    "riskNote" TEXT,
    "packaging" TEXT,
    "careRequirement" TEXT,
    "notes" TEXT,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "TrimmingProfile_productAssetId_fkey" FOREIGN KEY ("productAssetId") REFERENCES "ProductAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TrimmingProfile_productAssetId_key" ON "TrimmingProfile"("productAssetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TrimmingProfile_trimmingCode_idx" ON "TrimmingProfile"("trimmingCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TrimmingProfile_trimmingCategory_idx" ON "TrimmingProfile"("trimmingCategory");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TrimmingProfile_supplier_idx" ON "TrimmingProfile"("supplier");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TrimmingProfile_customer_idx" ON "TrimmingProfile"("customer");
