-- CreateTable: ProductionStage
CREATE TABLE IF NOT EXISTS "ProductionStage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "stageSeq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "operator" TEXT,
    "startedAt" BIGINT,
    "doneAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ProductionStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductionStage_orderId_stageKey_key" ON "ProductionStage"("orderId", "stageKey");
CREATE INDEX IF NOT EXISTS "ProductionStage_orderId_idx" ON "ProductionStage"("orderId");
CREATE INDEX IF NOT EXISTS "ProductionStage_status_idx" ON "ProductionStage"("status");

-- CreateTable: PreCutChecklist
CREATE TABLE IF NOT EXISTS "PreCutChecklist" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "gradingConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "consumptionConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "patternConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "preProductionMeeting" BOOLEAN NOT NULL DEFAULT false,
    "meetingNote" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "PreCutChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PreCutChecklist_orderId_key" ON "PreCutChecklist"("orderId");
CREATE INDEX IF NOT EXISTS "PreCutChecklist_orderId_idx" ON "PreCutChecklist"("orderId");

-- CreateTable: InspectionReport
CREATE TABLE IF NOT EXISTS "InspectionReport" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "passedUnits" INTEGER NOT NULL DEFAULT 0,
    "reportFile" TEXT,
    "inspectedBy" TEXT,
    "approvedByBusiness" BOOLEAN NOT NULL DEFAULT false,
    "businessApprover" TEXT,
    "approvedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "InspectionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InspectionReport_orderId_key" ON "InspectionReport"("orderId");
CREATE INDEX IF NOT EXISTS "InspectionReport_orderId_idx" ON "InspectionReport"("orderId");

-- AlterTable: Order (productionPlanDeadline + delayNoticeDeadline)
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "productionPlanDeadline" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "delayNoticeDeadline" TEXT;

-- AlterTable: Invoice (settlementDate)
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "settlementDate" TEXT;

-- AlterTable: DevelopmentCase (sampleCategory + review fields)
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "sampleCategory" TEXT DEFAULT 'normal';
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT;
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "reviewerId" TEXT;
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "reviewDate" TEXT;
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

-- AlterTable: ProductionStage (dual-sign fields)
ALTER TABLE "ProductionStage" ADD COLUMN IF NOT EXISTS "signedByProduction" TEXT;
ALTER TABLE "ProductionStage" ADD COLUMN IF NOT EXISTS "signedByBusiness" TEXT;
ALTER TABLE "ProductionStage" ADD COLUMN IF NOT EXISTS "signedAtProduction" BIGINT;
ALTER TABLE "ProductionStage" ADD COLUMN IF NOT EXISTS "signedAtBusiness" BIGINT;
