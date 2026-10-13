BEGIN;

ALTER TABLE "DevelopmentSampleVersion"
  ADD COLUMN IF NOT EXISTS "roundRequirementsSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "factoryRequirements" TEXT,
  ADD COLUMN IF NOT EXISTS "targetCompletionDate" TEXT,
  ADD COLUMN IF NOT EXISTS "referenceAttachments" JSONB;

UPDATE "DevelopmentSampleVersion" v
SET "roundRequirementsSnapshot" = r."notes",
    "factoryRequirements" = COALESCE(v."factoryRequirements", r."notes")
FROM "DevelopmentSampleRound" r
WHERE v."roundId" = r."id"
  AND (v."roundRequirementsSnapshot" IS NULL OR v."factoryRequirements" IS NULL);

UPDATE "SampleBatch"
SET "planUnit" = '米'
WHERE "sampleType" = 'yardage' AND lower(COALESCE("planUnit", '')) IN ('m', 'meter', 'meters');

UPDATE "SampleBatch"
SET "planUnit" = '份'
WHERE "sampleType" IN ('lab-dip', 'handloom') AND "planQuantity" IS NOT NULL AND COALESCE("planUnit", '') = '';

COMMIT;
