-- A19: Quotation.paymentInstrument —— 报价侧「付款方式」
--
-- 背景（§9 B51 / 拍板件 §2.2 A19）：`convertToOrder` 原先只拷 `paymentTerms`（自由文本）、
-- 不拷付款方式 ⇒ 转出的订单 `paymentInstrument` 恒 null ⇒ `isLcInstrument(null)=false`
-- ⇒ L/C 门禁对**整条报价转单路径 100% 免检**（fail-open）。补上报价侧这一列，
-- 转单时才能继承（见 server/src/quotations/quotationService.ts 的 convertToOrder）。
--
-- ★ 可空列、**刻意不给默认值、不填哨兵**：
--   NULL 的语义是「未录」（= 不知道），**不是**「非信用证」。
--   这与 A1 的 createdAt 正好相反 —— 那里必须填哨兵，否则窗口计数造假残留；
--   这里「空」本身就是门禁第三分支要表达的信息，填任何默认值都会把
--   「不知道」伪造成一个合法值（拍板件 §2.2 硬条件 1）。
--
-- ★ 本仓迁移范式：**手写幂等 SQL**（`prisma migrate dev` 的 shadow DB 重放历史迁移必崩 P3006）。
-- ★ 只做本地测试库；**生产迁移等 Kevin 安排**（拍板件 §2.2 硬条件末条）。
-- ★ 第 14 条 ③（加 DB CHECK / enum 约束）**本轮不做**（撞 §12.1 第 8 条未批的 ALTER TABLE 授权）。

ALTER TABLE "Quotation" ADD COLUMN IF NOT EXISTS "paymentInstrument" TEXT;
