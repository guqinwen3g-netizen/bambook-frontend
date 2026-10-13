-- An unclaimed task has no invented inspector. Historical assignments and
-- reports retain their existing identity/evidence without any backfill.
ALTER TABLE "QCAssignment" ALTER COLUMN "qcUserId" DROP NOT NULL;
ALTER TABLE "InspectionReport" ADD COLUMN "evidenceFiles" JSONB;
