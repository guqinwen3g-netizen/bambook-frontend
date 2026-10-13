-- Preserve existing values and permit a genuinely unknown product cost.
ALTER TABLE "ProductAsset" ALTER COLUMN "cost" DROP NOT NULL;
