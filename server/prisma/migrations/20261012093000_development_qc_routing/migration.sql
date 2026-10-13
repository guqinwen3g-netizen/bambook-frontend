ALTER TABLE "DevelopmentSampleQualityReview"
 ADD COLUMN "routingTeamId" TEXT,
 ADD COLUMN "responsibleHeadId" TEXT;
CREATE INDEX "DevelopmentSampleQualityReview_routingTeamId_status_idx" ON "DevelopmentSampleQualityReview" ("routingTeamId", "status");
CREATE INDEX "DevelopmentSampleQualityReview_responsibleHeadId_status_idx" ON "DevelopmentSampleQualityReview" ("responsibleHeadId", "status");
