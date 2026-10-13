-- ★ M1 口径落地（D7 已拍板 2026-09-20）：银行手续费 / 折让 进 P&L，费用承担方 OUR-BEN-SHA
-- 真源：docs/交付目标与验收标准-2026-09-20.md §8 M1 · §9 B4/B5 · §12 D7 · KB-1.7
-- 决策材料：docs/上线验收-2026-09-19.md §8.5（bankFee 口径分裂）· §8.6（折让不进利润表）
--
-- 三件事：
--   ① PaymentVoucher.feeBearer —— 手续费承担方（OUR / BEN / SHA）。
--      此前系统无法表达「谁付手续费」，收款侧 bankFee 全仓零消费（真库 37 条 / Σ880.00 静默无影响）。
--   ② OrderProfitSheet.bankFeeCost —— 收款侧手续费单列成本项（D7-①）。
--      不改核销额（牵连账龄/授信/批次结清），只在利润表新增一个成本维度。
--   ③ OrderProfitSheet.allowanceCost —— 折让/索赔单列成本项（D7-②，方案 A）。
--      收入口径不改（仍 = Σ应收发票面额），折让作为独立成本维度表达，可追溯。
--
-- ⚠️ 全部为**新增可空/带默认值列**，不改任何既有列语义 ⇒ 存量行自动为 0 / null，语义 = 未登记。
-- ⚠️ 沿用本仓范式：手写幂等 SQL（migrate dev 不可用：shadow DB 重放历史迁移必崩 P3006）。
--    回滚 = 三句 DROP COLUMN（存量数据不受影响）。

ALTER TABLE "PaymentVoucher" ADD COLUMN IF NOT EXISTS "feeBearer" TEXT;

ALTER TABLE "OrderProfitSheet" ADD COLUMN IF NOT EXISTS "bankFeeCost" DECIMAL(18, 4) NOT NULL DEFAULT 0;
ALTER TABLE "OrderProfitSheet" ADD COLUMN IF NOT EXISTS "allowanceCost" DECIMAL(18, 4) NOT NULL DEFAULT 0;
