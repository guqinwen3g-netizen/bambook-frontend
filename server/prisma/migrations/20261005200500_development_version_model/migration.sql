-- 开发管理·版本模型（2026-10-05，Kevin 拍板）
--
-- 三件事：
--   ① 立项分类拆三层：initiator（谁发起） + customerInput（客户给什么），source 降级为 legacy
--   ② 版本身份：versionLabel（R1-A / R4-A-1）+ 小版本从属（parentBatchId / minorVersion）
--      + 面料多形态序号（formIndex）
--   ③ 产品档案结构化来源：可精确回溯到「哪个案子的哪个轮次的哪个版本」
--
-- 关于移除唯一约束：
--   schema 原本声明 @@unique([developmentCaseId, supplierRelationId])，
--   但实测该约束在库里从未真正建立（pg_constraint 无记录），
--   且现有数据已存在同案同工厂的多个批次。故本迁移只需确保它不存在即可，无需清理数据。
--   业务依据：Kevin「同一案、同一工厂可以打第二/三/四轮，这非常正常」。

BEGIN;

-- ① 立项分类三层 ─────────────────────────────────────────────────────────
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "initiator" TEXT;
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "customerInput" TEXT;
-- ★ 开发方向（总纲）与实物样指向（2026-10-05 追加）
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "developmentDirection" TEXT;
ALTER TABLE "DevelopmentCase" ADD COLUMN IF NOT EXISTS "referenceRelationId" TEXT;

-- 存量回填：按 legacy source 无损映射（可回滚，不丢信息）
--   customer-sample    → initiator=customer, customerInput=physical-sample（有明确来样·去复刻）
--   customer-colorcard → initiator=customer, customerInput=spec-direction（只给参数方向·我方设计）
--   internal           → initiator=internal, customerInput=none（我方内部·无外部输入）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'DevelopmentCase' AND column_name = 'customerInput'
  ) THEN
    UPDATE "DevelopmentCase" SET
      "initiator"     = CASE
        WHEN "source" IN ('customer-sample','customer-colorcard') THEN 'customer'
        WHEN "source" = 'internal'                             THEN 'internal'
        ELSE NULL END,
      "customerInput" = CASE
        WHEN "source" = 'customer-sample'    THEN 'physical-sample'
        WHEN "source" = 'customer-colorcard' THEN 'spec-direction'
        WHEN "source" = 'internal'           THEN 'none'
        ELSE NULL END
    WHERE "initiator" IS NULL;
  END IF;
END $$;

-- ② 版本身份 ─────────────────────────────────────────────────────────────
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "versionLabel" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "parentBatchId" TEXT;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "minorVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "formIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SampleBatch" ADD COLUMN IF NOT EXISTS "minorChangeNote" TEXT;

-- 存量回填：versionLabel = 'R' || round || '-' || 工厂字母
--   ⚠️ 两个踩过的坑，写在这里防止重犯：
--   ① 不能用 supplierName 的首字符 —— 中文名会得到「R1-宏」这种无意义标签。
--   ② 不能用 Relation.code 的末位数字 —— SUP-0001/SUP-0012 都会得到 '1'，多工厂必撞。
--   正确做法：按该开发案下工厂的**稳定排序**分配序号字母 A/B/C/…
--   （用 min(id) 排序，保证同样输入必得同样输出，可重放）
DO $$
DECLARE
  v_case TEXT;
  v_sup  TEXT;
  v_letter TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'SampleBatch' AND column_name = 'versionLabel'
  ) THEN
    FOR v_case, v_sup, v_letter IN
      SELECT t."developmentCaseId",
             t."supplierRelationId",
             -- ⚠️ chr() 只接受 integer，count(*) 返回 bigint ⇒ 必须显式 ::int
             chr(65::int + (
               SELECT count(*)::int FROM (
                 SELECT DISTINCT s2."supplierRelationId"
                 FROM "SampleBatch" s2
                 WHERE s2."developmentCaseId" = t."developmentCaseId"
                   AND s2."supplierRelationId" < t."supplierRelationId"
               ) d
             ))
      FROM "SampleBatch" t
      WHERE t."versionLabel" IS NULL
      ORDER BY t."developmentCaseId", t."supplierRelationId"
    LOOP
      UPDATE "SampleBatch"
      SET "versionLabel" = 'R' || "round"::text || '-' || v_letter
      WHERE "developmentCaseId" = v_case
        AND "supplierRelationId" = v_sup
        AND "versionLabel" IS NULL;
    END LOOP;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "SampleBatch_developmentCaseId_round_idx"
  ON "SampleBatch" ("developmentCaseId", "round");
CREATE INDEX IF NOT EXISTS "SampleBatch_parentBatchId_idx"
  ON "SampleBatch" ("parentBatchId");
CREATE INDEX IF NOT EXISTS "SampleBatch_versionLabel_idx"
  ON "SampleBatch" ("versionLabel");

-- ③ 产品档案结构化来源 ───────────────────────────────────────────────────
ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "sourceDevelopmentCaseId" TEXT;
ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "sourceSampleBatchId" TEXT;
ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "sourceVersionLabel" TEXT;
ALTER TABLE "ProductAsset" ADD COLUMN IF NOT EXISTS "sourceSpecSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "ProductAsset_sourceDevelopmentCaseId_idx"
  ON "ProductAsset" ("sourceDevelopmentCaseId");
CREATE INDEX IF NOT EXISTS "ProductAsset_sourceSampleBatchId_idx"
  ON "ProductAsset" ("sourceSampleBatchId");

COMMIT;
