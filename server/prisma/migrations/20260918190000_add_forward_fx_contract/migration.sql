-- ★ D6 远期结汇：与银行签的远期结汇合约（2026-09-18）
-- 口径依据：docs/零基础障碍清单-2026-09-18.md D6
--   本仓已有 `FxRateLock`（订单级锁汇，解决"这笔生意按什么汇率算成本/利润"）与 `FxSettlement`
--   （每笔结汇水单）。缺的是**与银行的远期合约**这一层 ⇒ 到期日没人管、合约汇率 vs 实际结汇汇率的**损益**算不出来。
--   已交割金额（`settledForeignAmount`）是派生值，由 `ForwardFxSettlementLink` 累计维护（同事务）。
--
-- ⚠️ 只建新表，不改任何既有表 —— 对生产库零风险（回滚 = DROP TABLE 两张）。
-- ⚠️ 沿用本仓范式：手写 migration.sql（不用 migrate dev，本地库有既有漂移会触发 reset）。

-- CreateTable
CREATE TABLE "ForwardFxContract" (
    "id" TEXT NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "bankRelationId" TEXT,
    "bankName" TEXT,
    "currency" TEXT NOT NULL,
    "foreignAmount" DECIMAL(18,4) NOT NULL,
    "contractRate" DECIMAL(18,8) NOT NULL,
    "signedDate" TEXT NOT NULL,
    "maturityDate" TEXT NOT NULL,
    "settledForeignAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "ForwardFxContract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ForwardFxContract_contractNumber_key" ON "ForwardFxContract"("contractNumber" ASC);
CREATE INDEX "ForwardFxContract_currency_status_idx" ON "ForwardFxContract"("currency" ASC, "status" ASC);
CREATE INDEX "ForwardFxContract_maturityDate_idx" ON "ForwardFxContract"("maturityDate" ASC);
CREATE INDEX "ForwardFxContract_bankRelationId_idx" ON "ForwardFxContract"("bankRelationId" ASC);

-- CreateTable
CREATE TABLE "ForwardFxSettlementLink" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "foreignAmount" DECIMAL(18,4) NOT NULL,
    "actualRate" DECIMAL(18,8) NOT NULL,
    "settleDate" TEXT NOT NULL,
    "operatorId" TEXT,
    "createdAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "ForwardFxSettlementLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ForwardFxSettlementLink_contractId_settlementId_key" ON "ForwardFxSettlementLink"("contractId" ASC, "settlementId" ASC);
CREATE INDEX "ForwardFxSettlementLink_contractId_idx" ON "ForwardFxSettlementLink"("contractId" ASC);
CREATE INDEX "ForwardFxSettlementLink_settlementId_idx" ON "ForwardFxSettlementLink"("settlementId" ASC);
