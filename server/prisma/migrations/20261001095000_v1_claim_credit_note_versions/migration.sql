-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "currentAmount" DECIMAL(18,4),
ADD COLUMN     "currentVersionId" TEXT,
ADD COLUMN     "logicalClaimCaseId" TEXT;

-- CreateTable
CREATE TABLE "ClaimCreditNoteLine" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "claimDispositionId" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "decisionAuditId" TEXT NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "ClaimCreditNoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteDocumentVersion" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousVersionId" TEXT,
    "linesSnapshot" JSONB NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "issuedBy" TEXT,
    "issuedAt" BIGINT,
    "reason" TEXT,
    "requestId" TEXT,

    CONSTRAINT "CreditNoteDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteSettlementEvent" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceId" TEXT,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT,
    "parameters" JSONB NOT NULL,
    "parametersHash" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "CreditNoteSettlementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimCreditNoteLine_claimDispositionId_key" ON "ClaimCreditNoteLine"("claimDispositionId");

-- CreateIndex
CREATE INDEX "ClaimCreditNoteLine_creditNoteId_idx" ON "ClaimCreditNoteLine"("creditNoteId");

-- CreateIndex
CREATE INDEX "CreditNoteDocumentVersion_creditNoteId_idx" ON "CreditNoteDocumentVersion"("creditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteDocumentVersion_creditNoteId_version_key" ON "CreditNoteDocumentVersion"("creditNoteId", "version");

-- CreateIndex
CREATE INDEX "CreditNoteSettlementEvent_invoiceId_idx" ON "CreditNoteSettlementEvent"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteSettlementEvent_creditNoteId_requestId_key" ON "CreditNoteSettlementEvent"("creditNoteId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_logicalClaimCaseId_key" ON "CreditNote"("logicalClaimCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_currentVersionId_key" ON "CreditNote"("currentVersionId");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_logicalClaimCaseId_fkey" FOREIGN KEY ("logicalClaimCaseId") REFERENCES "ClaimCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCreditNoteLine" ADD CONSTRAINT "ClaimCreditNoteLine_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCreditNoteLine" ADD CONSTRAINT "ClaimCreditNoteLine_claimDispositionId_fkey" FOREIGN KEY ("claimDispositionId") REFERENCES "ClaimDisposition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCreditNoteLine" ADD CONSTRAINT "ClaimCreditNoteLine_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimCreditNoteLine" ADD CONSTRAINT "ClaimCreditNoteLine_decisionAuditId_fkey" FOREIGN KEY ("decisionAuditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteDocumentVersion" ADD CONSTRAINT "CreditNoteDocumentVersion_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteSettlementEvent" ADD CONSTRAINT "CreditNoteSettlementEvent_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

