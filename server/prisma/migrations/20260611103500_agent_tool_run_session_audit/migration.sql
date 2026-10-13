ALTER TABLE "AgentToolRun" ADD COLUMN IF NOT EXISTS "requestSource" TEXT;
ALTER TABLE "AgentToolRun" ADD COLUMN IF NOT EXISTS "approvalId" TEXT;

CREATE INDEX IF NOT EXISTS "AgentToolRun_requestSource_idx" ON "AgentToolRun"("requestSource");
CREATE INDEX IF NOT EXISTS "AgentToolRun_approvalId_idx" ON "AgentToolRun"("approvalId");
