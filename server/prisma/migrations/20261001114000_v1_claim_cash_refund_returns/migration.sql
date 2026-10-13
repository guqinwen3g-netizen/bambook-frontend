-- AlterTable
ALTER TABLE "CreditNoteSettlementEvent" ADD COLUMN     "refundReturnId" TEXT;

-- CreateTable
CREATE TABLE "CreditNoteRefundReturn" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "customerRelationId" TEXT NOT NULL,
    "sourceSettlementEventId" TEXT NOT NULL,
    "sourcePaymentVoucherId" TEXT NOT NULL,
    "currentVersionId" TEXT NOT NULL,
    "currentVersionFingerprint" TEXT NOT NULL,
    "receiptVoucherId" TEXT NOT NULL,
    "returnedPrincipal" DECIMAL(18,4) NOT NULL,
    "receivedNet" DECIMAL(18,4) NOT NULL,
    "bankFee" DECIMAL(18,4) NOT NULL,
    "feeBearer" TEXT,
    "currency" TEXT NOT NULL,
    "actualDate" TEXT NOT NULL,
    "actualMethod" TEXT NOT NULL,
    "bankReference" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "parametersHash" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "CreditNoteRefundReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteRefundReturnEvidence" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,

    CONSTRAINT "CreditNoteRefundReturnEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundReturn_receiptVoucherId_key" ON "CreditNoteRefundReturn"("receiptVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundReturn_auditId_key" ON "CreditNoteRefundReturn"("auditId");

-- CreateIndex
CREATE INDEX "CreditNoteRefundReturn_creditNoteId_createdAt_idx" ON "CreditNoteRefundReturn"("creditNoteId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditNoteRefundReturn_refundId_idx" ON "CreditNoteRefundReturn"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundReturn_creditNoteId_requestId_key" ON "CreditNoteRefundReturn"("creditNoteId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundReturn_refundId_actualDate_bankReference_key" ON "CreditNoteRefundReturn"("refundId", "actualDate", "bankReference");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundReturn_customerRelationId_currency_actualDa_key" ON "CreditNoteRefundReturn"("customerRelationId", "currency", "actualDate", "actualMethod", "bankReference");

-- CreateIndex
CREATE INDEX "CreditNoteRefundReturnEvidence_evidenceId_idx" ON "CreditNoteRefundReturnEvidence"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundReturnEvidence_returnId_evidenceId_key" ON "CreditNoteRefundReturnEvidence"("returnId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteSettlementEvent_refundReturnId_key" ON "CreditNoteSettlementEvent"("refundReturnId");

-- AddForeignKey
ALTER TABLE "CreditNoteSettlementEvent" ADD CONSTRAINT "CreditNoteSettlementEvent_refundReturnId_fkey" FOREIGN KEY ("refundReturnId") REFERENCES "CreditNoteRefundReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "CreditNoteRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_customerRelationId_fkey" FOREIGN KEY ("customerRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_sourceSettlementEventId_fkey" FOREIGN KEY ("sourceSettlementEventId") REFERENCES "CreditNoteSettlementEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_sourcePaymentVoucherId_fkey" FOREIGN KEY ("sourcePaymentVoucherId") REFERENCES "PaymentVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "CreditNoteDocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_receiptVoucherId_fkey" FOREIGN KEY ("receiptVoucherId") REFERENCES "PaymentVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturn" ADD CONSTRAINT "CreditNoteRefundReturn_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturnEvidence" ADD CONSTRAINT "CreditNoteRefundReturnEvidence_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "CreditNoteRefundReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundReturnEvidence" ADD CONSTRAINT "CreditNoteRefundReturnEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "CreditNoteRefundEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

