-- H16-② 客户对账确认回执（对账函回签电子化）
CREATE TABLE IF NOT EXISTS "CustomerReconciliationAck" (
    "id" TEXT NOT NULL,
    "customerRelationId" TEXT NOT NULL,
    "customerUserId" TEXT,
    "customerUserName" TEXT,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "snapshot" JSONB NOT NULL,
    "disputeNote" TEXT,
    "ip" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "CustomerReconciliationAck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CustomerReconciliationAck_customerRelationId_idx" ON "CustomerReconciliationAck"("customerRelationId");
CREATE INDEX IF NOT EXISTS "CustomerReconciliationAck_status_idx" ON "CustomerReconciliationAck"("status");
CREATE INDEX IF NOT EXISTS "CustomerReconciliationAck_periodStart_periodEnd_idx" ON "CustomerReconciliationAck"("periodStart", "periodEnd");
