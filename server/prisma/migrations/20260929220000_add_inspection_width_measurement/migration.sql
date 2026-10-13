-- 幅宽实测（QC 查货验货登记）—— 窄幅索赔扣款的输入事实（2026-09-29 晚）
-- 真源：docs/inventory/窄幅扣款-设计-2026-09-29.md（使用方口述：幅宽由**我们自己的 QC** 在查货时记录；
--       索赔基数是**该订单行的货款金额**）
--
-- 为什么要有这张表（实测过：全库此前**没有任何地方**能存"实测幅宽"）：
--   · `FabricProfile.widthValue` 是**面料档案的名义幅宽**（不是某一批货量出来的值）；
--   · `InspectionReport` 只有成衣 AQL 口径（件数/疵点），没有幅宽；
--   · `TestRequest` 是**第三方送检**（ITS/SGS）—— 使用方明确「这些不用我们管」。
--   ⇒ 幅宽这件事必须落在"我们自己 QC 的查货记录"上，故随验货报告建这张从表。
--
-- 两个维度都不能省：
--   · `reportId` = 哪一次查货（事实来源）；
--   · `orderLineId` = 哪一支面料（**索赔金额按订单行的货款金额算**，不按行就算不出钱）。
--
-- ★★ 两列幅宽都 NOT NULL —— 与"可空 = 未录"那条纪律（见 20260929165416 迁移的说明）方向相反，
--    理由：**这条路没有"半条记录"的合法形态** —— 没有实测值就谈不上量过；没有基准就**算不出偏差**。
--    宁可不建这条记录，也不许用某个默认幅宽替它猜基准（R6：算不出来就说算不出来）。
--
-- ★ 本仓迁移范式：**手写幂等 SQL**（`prisma migrate dev` 的 shadow DB 重放历史必崩 P3006）。
-- ★ 只做本地测试库；**生产迁移等使用方安排**（与 A1/A19/前两批同）。

CREATE TABLE IF NOT EXISTS "InspectionWidthMeasurement" (
  "id"              TEXT NOT NULL,
  "reportId"        TEXT NOT NULL,
  "orderId"         TEXT NOT NULL,
  "orderLineId"     TEXT NOT NULL,
  "measuredWidthCm" DECIMAL(8, 2) NOT NULL,
  "basisWidthCm"    DECIMAL(8, 2) NOT NULL,
  "note"            TEXT,
  "createdAt"       BIGINT NOT NULL,
  "updatedAt"       BIGINT NOT NULL,
  CONSTRAINT "InspectionWidthMeasurement_pkey" PRIMARY KEY ("id")
);

-- 一份验货报告里，同一订单行只留一条（修正 = 覆盖，不堆历史）
CREATE UNIQUE INDEX IF NOT EXISTS "InspectionWidthMeasurement_reportId_orderLineId_key"
  ON "InspectionWidthMeasurement" ("reportId", "orderLineId");
CREATE INDEX IF NOT EXISTS "InspectionWidthMeasurement_orderId_idx"
  ON "InspectionWidthMeasurement" ("orderId");
CREATE INDEX IF NOT EXISTS "InspectionWidthMeasurement_orderLineId_idx"
  ON "InspectionWidthMeasurement" ("orderLineId");

-- 外键：报告删 ⇒ 幅宽记录跟着删（Cascade，与 schema 声明一致）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InspectionWidthMeasurement_reportId_fkey'
  ) THEN
    ALTER TABLE "InspectionWidthMeasurement"
      ADD CONSTRAINT "InspectionWidthMeasurement_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "InspectionReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ⚠️ 幂等性：重复执行时 CREATE ... IF NOT EXISTS 全部跳过、外键用 DO 块判存在 ⇒ 结果不变。
-- 回滚 = `DROP TABLE "InspectionWidthMeasurement";`（只影响本表，其它表不受牵连）。
