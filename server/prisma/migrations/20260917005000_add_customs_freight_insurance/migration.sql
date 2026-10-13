-- 报关单「运费 / 保费」（2026-09-17）
--
-- 为什么要这两个字段：
--   退税 = FOB × 退税率。CIF/CFR 报关时，申报总额 totalValue 是**含运费（+保费）**的，
--   直接拿它当 FOB 会让退税额**系统性虚高**。
--   此前 taxRefundCalcService 就是这么错的（变量名还叫 exportAmountFob，实为 CIF）。
--
-- 为什么登记在报关单而不是复用运单的 freightAmount：
--   退税是报给税务局的数，税务认的是**报关单上填的**运费保费；
--   运单上记的是实际付给货代的钱，两者常不一致（报关时常按预估填）。以报关单为准。
--
-- 币种沿用报关单自身 currency（与 T7-3「币种不一致则不参与」的既有口径自然兼容）。
-- 存量数据：两列均为 NULL，语义 = 未登记（算退税时按成交方式判定是否需要，缺则不给数，不猜）。

ALTER TABLE "CustomsDeclaration" ADD COLUMN IF NOT EXISTS "freightAmount" DECIMAL(18, 4);
ALTER TABLE "CustomsDeclaration" ADD COLUMN IF NOT EXISTS "insuranceAmount" DECIMAL(18, 4);
