-- CreateTable
CREATE TABLE "ReturnReceiptLine" (
    "id" TEXT NOT NULL,
    "returnReceiptId" TEXT NOT NULL,
    "claimDispositionId" TEXT NOT NULL,
    "materialCode" TEXT NOT NULL,
    "expectedQuantity" DECIMAL(18,4) NOT NULL,
    "receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ReturnReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairInspection" (
    "id" TEXT NOT NULL,
    "repairWorkOrderId" TEXT NOT NULL,
    "inspectionNumber" TEXT NOT NULL,
    "inspectedQuantity" DECIMAL(18,4) NOT NULL,
    "passedQuantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "inspectionDate" TEXT NOT NULL,
    "inspectedBy" TEXT NOT NULL,
    "reportFile" TEXT,
    "defectSummary" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "RepairInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptMatchProposal" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "requestedAmount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "requestId" TEXT NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "decisionActorId" TEXT,
    "decidedAt" BIGINT,
    "decisionNote" TEXT,
    "allocationId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "ReceiptMatchProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnReceiptLine_claimDispositionId_idx" ON "ReturnReceiptLine"("claimDispositionId");

-- CreateIndex
CREATE INDEX "ReturnReceiptLine_status_idx" ON "ReturnReceiptLine"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnReceiptLine_returnReceiptId_claimDispositionId_key" ON "ReturnReceiptLine"("returnReceiptId", "claimDispositionId");

-- CreateIndex
CREATE UNIQUE INDEX "RepairInspection_inspectionNumber_key" ON "RepairInspection"("inspectionNumber");

-- CreateIndex
CREATE INDEX "RepairInspection_repairWorkOrderId_result_inspectionDate_idx" ON "RepairInspection"("repairWorkOrderId", "result", "inspectionDate");

-- CreateIndex
CREATE INDEX "ReceiptMatchProposal_requesterId_status_idx" ON "ReceiptMatchProposal"("requesterId", "status");

-- CreateIndex
CREATE INDEX "ReceiptMatchProposal_status_createdAt_idx" ON "ReceiptMatchProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptMatchProposal_voucherId_idx" ON "ReceiptMatchProposal"("voucherId");

-- CreateIndex
CREATE INDEX "ReceiptMatchProposal_invoiceId_idx" ON "ReceiptMatchProposal"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptMatchProposal_requesterId_requestId_key" ON "ReceiptMatchProposal"("requesterId", "requestId");

-- AddForeignKey
ALTER TABLE "ReturnReceiptLine" ADD CONSTRAINT "ReturnReceiptLine_returnReceiptId_fkey" FOREIGN KEY ("returnReceiptId") REFERENCES "ReturnReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnReceiptLine" ADD CONSTRAINT "ReturnReceiptLine_claimDispositionId_fkey" FOREIGN KEY ("claimDispositionId") REFERENCES "ClaimDisposition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairInspection" ADD CONSTRAINT "RepairInspection_repairWorkOrderId_fkey" FOREIGN KEY ("repairWorkOrderId") REFERENCES "RepairWorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
