-- 2026-09-29 · 公差标准机制（使用方拍板选 A：照抄 MOQ 先例，不新增表）
-- 设计真源：docs/inventory/公差标准机制-设计-2026-09-29.md
--
-- 两列，全部可空、**刻意不给默认值**、**不填哨兵**：
--   ① Relation.customerAgreementTolerance —— 客户协议公差标准（★ P0），分档表 JSONB
--   ② OrderLine.toleranceSource           —— 本行 tolerancePercent 的来源白名单
--
-- ★★ 与 A19 同一条纪律：NULL 的语义是「未录 / 不是人定的」，
--    填默认值会把「不知道」伪造成一个合法值。
-- ★★ 本迁移 **不回填任何数据**：
--    · customerAgreementTolerance 留 NULL = 「该客户尚未录标准」⇒ 取数链落到第 ④ 层报「未判定」；
--    · toleranceSource 留 NULL = 「这个 tolerancePercent 不是人定的」⇒ ★ 不进 override 层。
--      （若把存量 106 行标成覆盖值，第 ① 层会永远命中 ⇒ 新机制对存量单永不生效。）
--
-- 幂等：ADD COLUMN IF NOT EXISTS（可重复执行）

ALTER TABLE "Relation"
  ADD COLUMN IF NOT EXISTS "customerAgreementTolerance" JSONB;

ALTER TABLE "OrderLine"
  ADD COLUMN IF NOT EXISTS "toleranceSource" TEXT;
