ALTER TABLE "OrderLine"
  ADD COLUMN "requiredSampleFamilies" JSONB;

ALTER TABLE "ShipmentHandoffLine"
  ADD COLUMN "requiredSampleFamilies" JSONB,
  ADD COLUMN "eligibilityFingerprint" TEXT;

CREATE TABLE "ProductionQcIssue" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "productionBatchRevision" INTEGER NOT NULL,
  "failedReportId" TEXT NOT NULL,
  "reason" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "ProductionQcIssue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductionQcIssueEvent" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "productionBatchId" TEXT NOT NULL,
  "productionBatchRevision" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "reportId" TEXT,
  "requestKey" TEXT NOT NULL,
  "commandHash" TEXT NOT NULL,
  "note" TEXT,
  "payload" JSONB,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "ProductionQcIssueEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductionQcIssue_failedReportId_key" ON "ProductionQcIssue"("failedReportId");
CREATE INDEX "ProductionQcIssue_orderId_orderLineId_idx" ON "ProductionQcIssue"("orderId", "orderLineId");
CREATE INDEX "ProductionQcIssue_productionBatchId_productionBatchRevision_createdAt_idx" ON "ProductionQcIssue"("productionBatchId", "productionBatchRevision", "createdAt");
CREATE UNIQUE INDEX "ProductionQcIssueEvent_issueId_kind_requestKey_key" ON "ProductionQcIssueEvent"("issueId", "kind", "requestKey");
CREATE INDEX "ProductionQcIssueEvent_issueId_createdAt_idx" ON "ProductionQcIssueEvent"("issueId", "createdAt");
CREATE INDEX "ProductionQcIssueEvent_productionBatchId_productionBatchRevision_createdAt_idx" ON "ProductionQcIssueEvent"("productionBatchId", "productionBatchRevision", "createdAt");
CREATE INDEX "ProductionQcIssueEvent_reportId_idx" ON "ProductionQcIssueEvent"("reportId");
CREATE INDEX "ProductionQcIssueEvent_actorId_requestKey_idx" ON "ProductionQcIssueEvent"("actorId", "requestKey");

ALTER TABLE "ShipmentHandoffEvent"
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "commandHash" TEXT;
CREATE UNIQUE INDEX "ShipmentHandoffEvent_handoffId_requestKey_key"
  ON "ShipmentHandoffEvent"("handoffId", "requestKey");
