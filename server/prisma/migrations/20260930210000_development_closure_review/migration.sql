CREATE TABLE "DevelopmentLifecycleEvent" (
 "id" TEXT PRIMARY KEY,
 "developmentCaseId" TEXT NOT NULL REFERENCES "DevelopmentCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "revision" INTEGER NOT NULL CHECK ("revision" > 0),
 "action" TEXT NOT NULL, "state" TEXT NOT NULL, "outcome" TEXT,
 "reason" TEXT NOT NULL, "disposition" TEXT, "snapshot" JSONB NOT NULL,
 "requestKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "createdBy" TEXT NOT NULL, "createdAt" BIGINT NOT NULL,
 CONSTRAINT "DevelopmentLifecycleEvent_state_check" CHECK (
   ("action"='pause' AND "state"='paused' AND "outcome" IS NULL)
   OR ("action"='resume' AND "state"='active' AND "outcome" IS NULL)
   OR ("action"='close' AND "state"='closed' AND "outcome" IS NOT NULL AND "outcome" IN ('completed','stopped'))
 )
);
CREATE UNIQUE INDEX "DevelopmentLifecycleEvent_developmentCaseId_revision_key" ON "DevelopmentLifecycleEvent"("developmentCaseId","revision");
CREATE UNIQUE INDEX "DevelopmentLifecycleEvent_developmentCaseId_requestKey_key" ON "DevelopmentLifecycleEvent"("developmentCaseId","requestKey");
CREATE INDEX "DevelopmentLifecycleEvent_developmentCaseId_createdAt_idx" ON "DevelopmentLifecycleEvent"("developmentCaseId","createdAt");
CREATE TABLE "DevelopmentExpenseReview" (
 "id" TEXT PRIMARY KEY,
 "developmentCaseId" TEXT NOT NULL REFERENCES "DevelopmentCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "lifecycleEventId" TEXT NOT NULL REFERENCES "DevelopmentLifecycleEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "fingerprint" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "note" TEXT NOT NULL,
 "requestKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "createdBy" TEXT NOT NULL, "createdAt" BIGINT NOT NULL
);
CREATE UNIQUE INDEX "DevelopmentExpenseReview_developmentCaseId_requestKey_key" ON "DevelopmentExpenseReview"("developmentCaseId","requestKey");
CREATE INDEX "DevelopmentExpenseReview_developmentCaseId_createdAt_idx" ON "DevelopmentExpenseReview"("developmentCaseId","createdAt");
CREATE INDEX "DevelopmentExpenseReview_lifecycleEventId_idx" ON "DevelopmentExpenseReview"("lifecycleEventId");
