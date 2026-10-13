-- Historical decisions retain NULL workflow state; do not invent submissions.
ALTER TABLE "BillingItem"
 ADD COLUMN "developmentWorkflowState" TEXT,
 ADD COLUMN "developmentWorkflowVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "developmentSubmittedBy" TEXT,
 ADD COLUMN "developmentSubmittedAt" BIGINT,
 ADD COLUMN "developmentAssigneeId" TEXT,
 ADD COLUMN "developmentApprovalId" TEXT;
ALTER TABLE "BillingItem" ADD CONSTRAINT "BillingItem_development_workflow_state_check"
 CHECK ("developmentWorkflowState" IS NULL OR "developmentWorkflowState" IN ('draft','submitted','returned','approval_pending','ready','cancelled'));
ALTER TABLE "BillingItem" ADD CONSTRAINT "BillingItem_development_workflow_version_check" CHECK ("developmentWorkflowVersion" >= 0);
ALTER TABLE "BillingItemCostCoverage" ADD COLUMN "submissionVersion" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "BillingItemCostCoverage_round_key" ON "BillingItemCostCoverage"("billingItemId","costRecordId","submissionVersion");
DROP INDEX "BillingItemCostCoverage_billingItemId_costRecordId_key";
-- Keep the separate partial unique active-cost index: history may repeat, active coverage may not.
CREATE TABLE "DevelopmentBillingWorkflowEvent" (
 "id" TEXT PRIMARY KEY,
 "billingItemId" TEXT NOT NULL REFERENCES "BillingItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "requestKey" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL,
 "action" TEXT NOT NULL,
 "version" INTEGER NOT NULL CHECK ("version" > 0),
 "actorId" TEXT NOT NULL,
 "snapshot" JSONB NOT NULL,
 "createdAt" BIGINT NOT NULL
);
CREATE UNIQUE INDEX "DevelopmentBillingWorkflowEvent_billingItemId_requestKey_key" ON "DevelopmentBillingWorkflowEvent"("billingItemId","requestKey");
CREATE UNIQUE INDEX "DevelopmentBillingWorkflowEvent_billingItemId_version_key" ON "DevelopmentBillingWorkflowEvent"("billingItemId","version");
