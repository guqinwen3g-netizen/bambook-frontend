-- Sample library keeps only private-photo metadata on the physical item row.
-- Image bytes are stored below the private-files root by the authorized route.
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "photos" JSONB;
ALTER TABLE "SampleCardItem" ADD COLUMN IF NOT EXISTS "locationDetail" JSONB;
