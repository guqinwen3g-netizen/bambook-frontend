-- A 组 A-3 二期：新建返修工单表（RepairWorkOrder）
-- 口径依据：docs/业务口径决策单-2026-09-17.md A1（返修 = 只动货）
-- 行业依据：Odoo repair.order 独立模型 + 共用 workcenter · SAP Rework Order 独立订单类型
--
-- ⚠️ 只建新表，不改任何既有表 —— 对生产库零风险。
-- ⚠️ 同上一批：用 migrate diff 生成（不用 migrate dev，本地库有既有漂移会触发 reset），
--    并人工剔除与本次无关的 DROP INDEX "SampleNode_supplierRelationId_idx"。

-- DropIndex

-- CreateTable
CREATE TABLE "RepairWorkOrder" (
    "id" TEXT NOT NULL,
    "workOrderNumber" TEXT NOT NULL,
    "claimCaseId" TEXT NOT NULL,
    "dispositionId" TEXT,
    "sourceShipmentId" TEXT,
    "sourceProductionPlanId" TEXT,
    "materialCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT,
    "workStationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "repairReason" TEXT,
    "needsReinspection" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TEXT,
    "completedAt" TEXT,
    "reshipmentId" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,

    CONSTRAINT "RepairWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepairWorkOrder_workOrderNumber_key" ON "RepairWorkOrder"("workOrderNumber");

-- CreateIndex
CREATE INDEX "RepairWorkOrder_claimCaseId_idx" ON "RepairWorkOrder"("claimCaseId");

-- CreateIndex
CREATE INDEX "RepairWorkOrder_workStationId_idx" ON "RepairWorkOrder"("workStationId");

-- CreateIndex
CREATE INDEX "RepairWorkOrder_status_idx" ON "RepairWorkOrder"("status");

