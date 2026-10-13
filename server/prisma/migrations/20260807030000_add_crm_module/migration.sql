-- ============ Phase 3 C1: CRM 深化（联系人/信用/跟进/商机/分层）============

-- CreateTable: Contact
CREATE TABLE IF NOT EXISTS "Contact" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "department" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "wechat" TEXT,
    "whatsapp" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false,
    "birthday" TEXT,
    "personalNote" TEXT,
    "tags" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CreditLimit
CREATE TABLE IF NOT EXISTS "CreditLimit" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "totalLimit" DECIMAL(18,4) NOT NULL,
    "usedAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "validFrom" TEXT NOT NULL,
    "validTo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "approvedBy" TEXT,
    "approvedAt" BIGINT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "CreditLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FollowUpRecord
CREATE TABLE IF NOT EXISTS "FollowUpRecord" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "contactId" TEXT,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "followUpAt" TEXT NOT NULL,
    "nextFollowUpAt" TEXT,
    "nextFollowUpTopic" TEXT,
    "opportunityId" TEXT,
    "orderId" TEXT,
    "salesRepId" TEXT,
    "salesRepName" TEXT,
    "attachments" JSONB,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "FollowUpRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Opportunity
CREATE TABLE IF NOT EXISTS "Opportunity" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "stage" TEXT NOT NULL DEFAULT 'Prospecting',
    "probability" INTEGER NOT NULL DEFAULT 10,
    "expectedCloseDate" TEXT,
    "source" TEXT,
    "orderId" TEXT,
    "salesRepId" TEXT,
    "salesRepName" TEXT,
    "tags" TEXT[],
    "notes" TEXT,
    "closedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CustomerTier
CREATE TABLE IF NOT EXISTS "CustomerTier" (
    "id" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "criteria" TEXT,
    "discountRate" DECIMAL(5,2),
    "paymentTermsDays" INTEGER,
    "creditPriority" TEXT NOT NULL DEFAULT 'Normal',
    "evaluatedAt" TEXT NOT NULL,
    "validUntil" TEXT,
    "evaluatedBy" TEXT,
    "notes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    CONSTRAINT "CustomerTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Contact
CREATE INDEX IF NOT EXISTS "Contact_relationId_idx" ON "Contact"("relationId");
CREATE INDEX IF NOT EXISTS "Contact_isPrimary_idx" ON "Contact"("isPrimary");
CREATE INDEX IF NOT EXISTS "Contact_status_idx" ON "Contact"("status");

-- CreateIndex: CreditLimit
CREATE INDEX IF NOT EXISTS "CreditLimit_relationId_idx" ON "CreditLimit"("relationId");
CREATE INDEX IF NOT EXISTS "CreditLimit_status_idx" ON "CreditLimit"("status");

-- CreateIndex: FollowUpRecord
CREATE INDEX IF NOT EXISTS "FollowUpRecord_relationId_idx" ON "FollowUpRecord"("relationId");
CREATE INDEX IF NOT EXISTS "FollowUpRecord_contactId_idx" ON "FollowUpRecord"("contactId");
CREATE INDEX IF NOT EXISTS "FollowUpRecord_followUpAt_idx" ON "FollowUpRecord"("followUpAt");
CREATE INDEX IF NOT EXISTS "FollowUpRecord_nextFollowUpAt_idx" ON "FollowUpRecord"("nextFollowUpAt");

-- CreateIndex: Opportunity
CREATE INDEX IF NOT EXISTS "Opportunity_relationId_idx" ON "Opportunity"("relationId");
CREATE INDEX IF NOT EXISTS "Opportunity_stage_idx" ON "Opportunity"("stage");
CREATE INDEX IF NOT EXISTS "Opportunity_expectedCloseDate_idx" ON "Opportunity"("expectedCloseDate");
CREATE INDEX IF NOT EXISTS "Opportunity_salesRepId_idx" ON "Opportunity"("salesRepId");

-- CreateIndex: CustomerTier
CREATE INDEX IF NOT EXISTS "CustomerTier_relationId_idx" ON "CustomerTier"("relationId");
CREATE INDEX IF NOT EXISTS "CustomerTier_level_idx" ON "CustomerTier"("level");

-- AddForeignKey: Contact → Relation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Contact_relationId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "Contact" ADD CONSTRAINT "Contact_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "Relation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: CreditLimit → Relation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditLimit_relationId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "CreditLimit" ADD CONSTRAINT "CreditLimit_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "Relation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: FollowUpRecord → Relation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FollowUpRecord_relationId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "FollowUpRecord" ADD CONSTRAINT "FollowUpRecord_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "Relation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: FollowUpRecord → Contact
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FollowUpRecord_contactId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "FollowUpRecord" ADD CONSTRAINT "FollowUpRecord_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: Opportunity → Relation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Opportunity_relationId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "Relation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: CustomerTier → Relation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerTier_relationId_fkey' AND connamespace = 'public'::regnamespace) THEN
    ALTER TABLE "CustomerTier" ADD CONSTRAINT "CustomerTier_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "Relation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
