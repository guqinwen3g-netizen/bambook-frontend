-- Preserve existing supplier/unit/MOQ/price facts; no inferred backfill.
ALTER TABLE "TrimmingProfile"
 ADD COLUMN "manufacturerRelationId" TEXT,
 ADD COLUMN "images" JSONB,
 ADD COLUMN "attachments" JSONB,
 ADD COLUMN "quoteDate" TEXT,
 ADD COLUMN "quoteConditions" TEXT,
 ADD COLUMN "priceUnit" TEXT,
 ADD COLUMN "moqUnit" TEXT,
 ADD COLUMN "supplierArticleNo" TEXT,
 ADD COLUMN "categoryParameters" JSONB;
