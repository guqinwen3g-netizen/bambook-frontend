ALTER TABLE "ReleaseRequest"
  ADD COLUMN "rejectedBy" TEXT,
  ADD COLUMN "rejectedAt" BIGINT,
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "requestedChanges" TEXT;
