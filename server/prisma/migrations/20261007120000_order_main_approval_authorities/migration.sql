ALTER TABLE "ApprovalRequest"
  ADD COLUMN IF NOT EXISTS "eligibleReviewerIds" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "OrderApprovalAuthority" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "businessLine" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderApprovalAuthority_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderApprovalAuthority_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderApprovalAuthority_userId_businessLine_key"
  ON "OrderApprovalAuthority"("userId", "businessLine");
CREATE INDEX IF NOT EXISTS "OrderApprovalAuthority_businessLine_active_idx"
  ON "OrderApprovalAuthority"("businessLine", "active");
