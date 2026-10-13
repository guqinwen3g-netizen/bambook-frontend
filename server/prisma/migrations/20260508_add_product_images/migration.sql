CREATE TABLE IF NOT EXISTS "ProductImage" (
    "id" TEXT NOT NULL,
    "productAssetId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "uploadedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProductImage_productAssetId_idx" ON "ProductImage"("productAssetId");
CREATE INDEX IF NOT EXISTS "ProductImage_isPrimary_idx" ON "ProductImage"("isPrimary");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductImage_productAssetId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productAssetId_fkey" FOREIGN KEY ("productAssetId") REFERENCES "ProductAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
