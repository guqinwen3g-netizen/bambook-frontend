-- Actual piece/size/position/value/unit readings remain unknown on legacy rows.
ALTER TABLE "DevelopmentSampleQualityReview" ADD COLUMN "measurements" JSONB;
