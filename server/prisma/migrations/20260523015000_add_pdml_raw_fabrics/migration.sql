CREATE TABLE IF NOT EXISTS "PdmlRawFabric" (
  "id" TEXT NOT NULL,
  "gsid" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "rawData" JSONB NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "articleNo" TEXT,
  "factoryArticleNo" TEXT,
  "colorCode" TEXT,
  "factoryColorCode" TEXT,
  "supplierName" TEXT,
  "productLine" TEXT,
  "registeredDate" TEXT,
  "imageUrl" TEXT,
  "sourceStatus" TEXT,
  "firstSeenAt" BIGINT NOT NULL,
  "lastSeenAt" BIGINT NOT NULL,
  "syncedAt" BIGINT NOT NULL,
  "deletedAt" BIGINT,
  CONSTRAINT "PdmlRawFabric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PdmlRawFabric_gsid_sourceId_key" ON "PdmlRawFabric"("gsid", "sourceId");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_sourceId_idx" ON "PdmlRawFabric"("sourceId");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_gsid_idx" ON "PdmlRawFabric"("gsid");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_articleNo_idx" ON "PdmlRawFabric"("articleNo");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_factoryArticleNo_idx" ON "PdmlRawFabric"("factoryArticleNo");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_supplierName_idx" ON "PdmlRawFabric"("supplierName");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_productLine_idx" ON "PdmlRawFabric"("productLine");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_registeredDate_idx" ON "PdmlRawFabric"("registeredDate");
CREATE INDEX IF NOT EXISTS "PdmlRawFabric_sourceStatus_idx" ON "PdmlRawFabric"("sourceStatus");
