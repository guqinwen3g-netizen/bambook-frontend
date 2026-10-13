-- ============================================================================
-- Prisma P0/P1 缺口迁移 — 数据回填 SQL 脚本
-- 设计真源：docs/design/02-数据模型/Prisma缺口清单与迁移方案.md
-- 执行顺序：严格按 §10 迁移批次顺序（先 Migration 2 Step2 → 再 Migration 2.5 Step2 → Step3 加约束）
-- 注意：本脚本为"Step2 数据回填"阶段使用；Step1 加列由 prisma migrate dev 自动生成；Step3 改 NOT NULL 在回填完成后人工执行
-- ============================================================================

-- ============================================================================
-- 0. MoqThresholdConfig — isActive=true 唯一索引（DB 层强制仅 1 条生效配置）
-- ============================================================================
-- 设计真源：§2 P0-1 DB 层唯一性约束说明
-- 风险：低（不影响现有数据，仅加唯一索引；若有脏数据（多条 isActive=true）需先手工处理）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'moq_threshold_config_only_one_active'
          AND n.nspname = 'public'
    ) THEN
        CREATE UNIQUE INDEX moq_threshold_config_only_one_active
        ON "MoqThresholdConfig" ((1)) WHERE "isActive" = true;
    END IF;
END $$;


-- ============================================================================
-- 1. PaymentVoucher.voucherCategory 回填（P0-9 Step2）
-- ============================================================================
-- 设计真源：§3 P0-9
-- 所有历史行统一兜底 normal（分类仅对新写入凭证有精细区分，历史数据不追溯）
UPDATE "PaymentVoucher"
SET "voucherCategory" = 'normal'
WHERE "voucherCategory" IS NULL;


-- ============================================================================
-- 2. ApprovalRequest.reviewerId NOT NULL 三步法（P0-8 Step2 回填）
-- ============================================================================
-- 设计真源：§3 P0-8 三步法
-- 实测修正（2026-08-16）：Department 无 managerId 列（schema 从未有）；Role 无 roleKey 列（用 id/name）
-- Step2-a：优先按 requesterId → 部门 headId 回填（P0-10 headId 已由迁移加列；若运维已补录 headId 则生效）
UPDATE "ApprovalRequest"
SET "reviewerId" = (
    SELECT d."headId"
    FROM "UserAccount" u
    JOIN "Department" d ON u."primaryDeptId" = d."id"
    WHERE u."id" = "ApprovalRequest"."requesterId"
      AND d."headId" IS NOT NULL
    LIMIT 1
)
WHERE "reviewerId" IS NULL;

-- Step2-b：兜底（仍为 null → 取 Admin/owner 角色用户；再兜底取最早创建的用户）
DO $$
DECLARE
    admin_id TEXT;
BEGIN
    SELECT ur."userId" INTO admin_id
    FROM "UserRole" ur
    JOIN "Role" r ON ur."roleId" = r."id"
    WHERE r."id" IN ('admin', 'role_admin', 'role_owner', 'ADMIN')
       OR r."name" ILIKE 'admin'
       OR r."name" IN ('系统管理员', '超级管理员')
    ORDER BY ur."userId"
    LIMIT 1;

    IF admin_id IS NULL THEN
        SELECT id INTO admin_id FROM "UserAccount" ORDER BY "createdAt" ASC LIMIT 1;
    END IF;

    IF admin_id IS NOT NULL THEN
        UPDATE "ApprovalRequest"
        SET "reviewerId" = admin_id
        WHERE "reviewerId" IS NULL;
    END IF;
END $$;

-- Step3（在 Step2 执行完毕，验证 reviewerId 全部非空后再执行）：
-- ALTER TABLE "ApprovalRequest" ALTER COLUMN "reviewerId" SET NOT NULL;


-- ============================================================================
-- 3. ApprovalRequest.reviewerResolverRoute + departmentSnapshotId 三步法
--    （P0-11 / P0-16 Step2 回填；Migration 2.5）
-- ============================================================================
-- 设计真源：§8 NOT NULL 三步法通用模式
-- Step2-a：reviewerResolverRoute — 旧行统一兜底 DEPT_HEAD_LEGACY_FALLBACK
-- （createOnce 字段本应创建时写入；旧数据无法回溯真实解析路径，用兜底值做审计区分）
UPDATE "ApprovalRequest"
SET "reviewerResolverRoute" = 'DEPT_HEAD_LEGACY_FALLBACK'
WHERE "reviewerResolverRoute" IS NULL;

-- Step2-b：departmentSnapshotId — 按 requesterId → UserAccount.primaryDeptId 回填
UPDATE "ApprovalRequest"
SET "departmentSnapshotId" = (
    SELECT "primaryDeptId" FROM "UserAccount" u
    WHERE u."id" = "ApprovalRequest"."requesterId" LIMIT 1
)
WHERE "departmentSnapshotId" IS NULL;

-- Step2-c：仍为 NULL → 兜底 DEPT_UNKNOWN_LEGACY（绝不允许 NULL）
UPDATE "ApprovalRequest"
SET "departmentSnapshotId" = 'DEPT_UNKNOWN_LEGACY'
WHERE "departmentSnapshotId" IS NULL;

-- Step3（Step2 完成 + 验证全部非空后）：
-- ALTER TABLE "ApprovalRequest" ALTER COLUMN "reviewerResolverRoute" SET NOT NULL;
-- ALTER TABLE "ApprovalRequest" ALTER COLUMN "departmentSnapshotId" SET NOT NULL;


-- ============================================================================
-- 4. GarmentProfile MOQ 归一化（P1-11 Step2 回填）
-- ============================================================================
-- 设计真源：§5 P1-11
-- 前提：Step1 moqValue/moqUnit 两列已加（由 prisma migrate 自动）
-- Step2：从旧 moq String 中 parse 数字回填 moqValue；moqUnit 已默认 'PCS'
-- 正则提取连续数字子串（例：moq="200件" → 200；"MOQ: 500 PCS" → 500）
UPDATE "GarmentProfile"
SET "moqValue" = CAST(SUBSTRING("moq" FROM '[0-9]+') AS INTEGER)
WHERE "moqValue" IS NULL
  AND "moq" IS NOT NULL
  AND "moq" ~ '[0-9]+';

-- Step3（确认新列回填正确后，删除旧列。先做生产灰度验证，建议延后 1~2 周）：
-- ALTER TABLE "GarmentProfile" DROP COLUMN "moq";


-- ============================================================================
-- 5. Department.headId 回填（P0-10 Step2）
-- ============================================================================
-- 设计真源：§8 P0-10
-- 若 Department.managerId（旧字段）已存在 → 先映射到 headId
-- （很多早期项目把部门主管存在 managerId；本次迁移统一真源 headId，managerId 后续可弃用）
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Department' AND column_name = 'managerId'
    ) THEN
        UPDATE "Department"
        SET "headId" = "managerId"::text
        WHERE "headId" IS NULL
          AND "managerId" IS NOT NULL;
    END IF;
END $$;

-- 注：headId 保持 String?（NOT NULL 不强制，允许部门主管空缺 → FALLBACK_DEPT_HEAD_VACANT 兜底）
