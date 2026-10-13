-- A3 少收销账闭环：新建贷项票抵扣发票核销明细表（CreditNoteAllocation）
-- 口径依据：docs/业务口径决策单-2026-09-17.md A2/A3 + 零基础障碍清单 A3
--   贷项票核销（抵扣发票）此前只减 CN 自身余额、不落发票侧 ⇒ 发票永久 PartiallyPaid + 永久逾期。
--   现补「CN→发票」核销明细；发票「已核销总额」真源 sumAppliedAmount 扩展为 收款 + 折让。
--
-- ⚠️ 只建新表，不改任何既有表 —— 对生产库零风险。
-- ⚠️ 同上批范式：手写 migration.sql（不用 migrate dev，本地库有既有漂移会触发 reset）。

-- CreateTable
CREATE TABLE "CreditNoteAllocation" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "appliedAmount" DECIMAL(18,4) NOT NULL,
    "appliedDate" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,

    CONSTRAINT "CreditNoteAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteAllocation_creditNoteId_invoiceId_key" ON "CreditNoteAllocation"("creditNoteId" ASC, "invoiceId" ASC);

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_invoiceId_idx" ON "CreditNoteAllocation"("invoiceId" ASC);

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_creditNoteId_idx" ON "CreditNoteAllocation"("creditNoteId" ASC);
