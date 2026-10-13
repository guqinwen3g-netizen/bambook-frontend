-- Durable idempotency receipts for approved Agent write commits.
CREATE TABLE IF NOT EXISTS "AgentCommitReceipt" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentCommitReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentCommitReceipt_idempotencyKey_key" ON "AgentCommitReceipt"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "AgentCommitReceipt_toolId_idx" ON "AgentCommitReceipt"("toolId");
CREATE INDEX IF NOT EXISTS "AgentCommitReceipt_approvalId_idx" ON "AgentCommitReceipt"("approvalId");
CREATE INDEX IF NOT EXISTS "AgentCommitReceipt_status_idx" ON "AgentCommitReceipt"("status");
