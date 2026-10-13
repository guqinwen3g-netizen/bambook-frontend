-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "customerRelationId" TEXT,
ADD COLUMN     "payeeType" TEXT NOT NULL DEFAULT 'Supplier';

-- AlterTable
ALTER TABLE "CreditNoteSettlementEvent" ADD COLUMN     "paymentVoucherId" TEXT,
ADD COLUMN     "refundId" TEXT;

-- CreateTable
CREATE TABLE "CreditNoteRefund" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "customerRelationId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "payeeSnapshot" JSONB NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "parametersHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PendingApproval',
    "decisionAuditId" TEXT,
    "paymentVoucherId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "CreditNoteRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteRefundEvent" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "parametersHash" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "CreditNoteRefundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteRefundEvidence" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "privateStorageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" BIGINT NOT NULL,

    CONSTRAINT "CreditNoteRefundEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefund_paymentRequestId_key" ON "CreditNoteRefund"("paymentRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefund_paymentVoucherId_key" ON "CreditNoteRefund"("paymentVoucherId");

-- CreateIndex
CREATE INDEX "CreditNoteRefund_creditNoteId_status_idx" ON "CreditNoteRefund"("creditNoteId", "status");

-- CreateIndex
CREATE INDEX "CreditNoteRefund_requesterId_idx" ON "CreditNoteRefund"("requesterId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefund_creditNoteId_requestId_key" ON "CreditNoteRefund"("creditNoteId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundEvent_auditId_key" ON "CreditNoteRefundEvent"("auditId");

-- CreateIndex
CREATE INDEX "CreditNoteRefundEvent_refundId_createdAt_idx" ON "CreditNoteRefundEvent"("refundId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundEvent_refundId_requestId_key" ON "CreditNoteRefundEvent"("refundId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundEvent_refundId_sequence_key" ON "CreditNoteRefundEvent"("refundId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteRefundEvidence_privateStorageKey_key" ON "CreditNoteRefundEvidence"("privateStorageKey");

-- CreateIndex
CREATE INDEX "CreditNoteRefundEvidence_refundId_idx" ON "CreditNoteRefundEvidence"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteSettlementEvent_refundId_key" ON "CreditNoteSettlementEvent"("refundId");

-- AddForeignKey
ALTER TABLE "CreditNoteSettlementEvent" ADD CONSTRAINT "CreditNoteSettlementEvent_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "CreditNoteRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteSettlementEvent" ADD CONSTRAINT "CreditNoteSettlementEvent_paymentVoucherId_fkey" FOREIGN KEY ("paymentVoucherId") REFERENCES "PaymentVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CreditNoteDocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_customerRelationId_fkey" FOREIGN KEY ("customerRelationId") REFERENCES "Relation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_decisionAuditId_fkey" FOREIGN KEY ("decisionAuditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefund" ADD CONSTRAINT "CreditNoteRefund_paymentVoucherId_fkey" FOREIGN KEY ("paymentVoucherId") REFERENCES "PaymentVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundEvent" ADD CONSTRAINT "CreditNoteRefundEvent_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "CreditNoteRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundEvent" ADD CONSTRAINT "CreditNoteRefundEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundEvent" ADD CONSTRAINT "CreditNoteRefundEvent_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundEvidence" ADD CONSTRAINT "CreditNoteRefundEvidence_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "CreditNoteRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteRefundEvidence" ADD CONSTRAINT "CreditNoteRefundEvidence_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

