-- A 组 · 售后索赔模型：新建 4 张表（ClaimCase / ClaimDisposition / CreditNote / ReturnReceipt）
-- 口径依据：docs/业务口径决策单-2026-09-17.md A1–A6
-- 实施方案：docs/A组售后索赔模型-实施方案-2026-09-17.md
--
-- ⚠️ 本迁移**只建新表**，不改任何既有表 —— 对生产库零风险。
-- ⚠️ 生成方式：prisma migrate diff（**不用 migrate dev**，因本地库存在既有漂移，
--    migrate dev 可能触发 reset）。生成后**人工剔除**了一条与本次无关的
--    DROP INDEX "SampleNode_supplierRelationId_idx"（既有漂移，丢索引有风险）。

-- CreateTable
CREATE TABLE "ClaimCase" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "customerRelationId" TEXT,
    "customerName" TEXT,
    "sourceOrderId" TEXT,
    "sourceInvoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Registered',
    "category" TEXT,
    "problemDesc" TEXT NOT NULL,
    "attachments" JSONB,
    "reportedAt" TEXT NOT NULL,
    "reportedBy" TEXT NOT NULL,
    "totalCreditAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "creditCurrency" TEXT,
    "totalReturnQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "closedAt" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "ClaimCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimDisposition" (
    "id" TEXT NOT NULL,
    "claimCaseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "materialCode" TEXT,
    "quantity" DECIMAL(18,4),
    "unit" TEXT,
    "amount" DECIMAL(18,4),
    "currency" TEXT,
    "returnDisposition" TEXT,
    "creditNoteId" TEXT,
    "returnReceiptId" TEXT,
    "replacementShipmentId" TEXT,
    "repairWorkOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "approverId" TEXT,
    "approvedAt" TEXT,
    "cancelledAt" TEXT,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "ClaimDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "customerRelationId" TEXT,
    "customerName" TEXT,
    "claimCaseId" TEXT,
    "sourceInvoiceId" TEXT,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "openAmount" DECIMAL(18,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "issueDate" TEXT NOT NULL,
    "appliedToInvoiceId" TEXT,
    "refundedAt" TEXT,
    "refundedBy" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "cancelledAt" TEXT,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnReceipt" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "claimCaseId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "stockMovementId" TEXT,
    "receivedAt" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "ReturnReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaimCase_caseNumber_key" ON "ClaimCase"("caseNumber");

-- CreateIndex
CREATE INDEX "ClaimCase_customerRelationId_idx" ON "ClaimCase"("customerRelationId");

-- CreateIndex
CREATE INDEX "ClaimCase_sourceOrderId_idx" ON "ClaimCase"("sourceOrderId");

-- CreateIndex
CREATE INDEX "ClaimCase_status_idx" ON "ClaimCase"("status");

-- CreateIndex
CREATE INDEX "ClaimCase_reportedAt_idx" ON "ClaimCase"("reportedAt");

-- CreateIndex
CREATE INDEX "ClaimDisposition_claimCaseId_idx" ON "ClaimDisposition"("claimCaseId");

-- CreateIndex
CREATE INDEX "ClaimDisposition_kind_idx" ON "ClaimDisposition"("kind");

-- CreateIndex
CREATE INDEX "ClaimDisposition_status_idx" ON "ClaimDisposition"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_creditNoteNumber_key" ON "CreditNote"("creditNoteNumber");

-- CreateIndex
CREATE INDEX "CreditNote_customerRelationId_idx" ON "CreditNote"("customerRelationId");

-- CreateIndex
CREATE INDEX "CreditNote_claimCaseId_idx" ON "CreditNote"("claimCaseId");

-- CreateIndex
CREATE INDEX "CreditNote_status_idx" ON "CreditNote"("status");

-- CreateIndex
CREATE INDEX "CreditNote_issueDate_idx" ON "CreditNote"("issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnReceipt_receiptNumber_key" ON "ReturnReceipt"("receiptNumber");

-- CreateIndex
CREATE INDEX "ReturnReceipt_claimCaseId_idx" ON "ReturnReceipt"("claimCaseId");

-- CreateIndex
CREATE INDEX "ReturnReceipt_disposition_idx" ON "ReturnReceipt"("disposition");

-- CreateIndex
CREATE INDEX "ReturnReceipt_status_idx" ON "ReturnReceipt"("status");

