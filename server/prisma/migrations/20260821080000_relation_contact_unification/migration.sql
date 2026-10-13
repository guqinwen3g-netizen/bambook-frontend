-- 联系人统一（Relation 人物轨为唯一真源）：自 Contact 实体并入的 CRM 语义字段
-- 仅 isOrganization=false 的人物记录消费；组织记录恒为 false/null
ALTER TABLE "Relation" ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Relation" ADD COLUMN IF NOT EXISTS "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Relation" ADD COLUMN IF NOT EXISTS "contactStatus" TEXT;

-- 联系人统一：FollowUpRecord.contactId 改裸引用（指向 Relation 人物轨，历史数据可能是旧 Contact id）
-- 与 CommunicationLog/CommissionRule 的 snapshot FK 同口径
ALTER TABLE "FollowUpRecord" DROP CONSTRAINT IF EXISTS "FollowUpRecord_contactId_fkey";
