-- v1 合同条款字段 + 两处记录字段（2026-09-29）
-- 真源：docs/inventory/待使用方判清单.md §八/§九/§十一/§十二（使用方逐条口述并拍板）
--
-- 为什么加这几列：与 23 份真实销售合同对撞后发现，**软件生成的合同缺 8 条标准条款**
-- （真实合同 9 条里只有"支付方式"一条有）。其中 3 条纯法律文本已用模板常量补上
-- （见 server/src/templates/docTemplates/contract.ts 的 CONTRACT_FIXED_CLAUSES），
-- 另 4 条**需要数据才能印真实值** ⇒ 本迁移补它们的承载列。
--
-- ★★ 五列**全部可空、刻意不给默认值、不填哨兵** —— 与 A19（Quotation.paymentInstrument）
--    同一条纪律：**NULL 的语义是「未录」（= 不知道）**，不是任何一个合法取值。
--    填默认值会把「不知道」伪造成一个合法值（正是 A19 注释里点名要避免的事）。
--    ⚠️ 与 A1（补 createdAt）**正好相反** —— 那里必须填哨兵，因为空会让窗口计数造假残留。
--    ⇒ **判据：这一列的"空"是"未录"还是"未发生"？** 未录 ⇒ 可空无默认。
--
-- ★ 本仓迁移范式：**手写幂等 SQL**（`prisma migrate dev` 的 shadow DB 重放历史必崩 P3006）。
-- ★ 只做本地测试库；**生产迁移等使用方安排**（与 A1/A19 同）。
-- ★ 第 14 条 ③（加 DB CHECK / enum 约束）本轮不做（撞 §12.1 第 8 条未批的 ALTER TABLE 授权）。

-- ── ① Order：合同条款区的三个"未录"字段 ────────────────────────────────
-- 保险方式：二选一「出卖人按发票金额 110% 投保一切险及战争险」/「买受人自理」
--   （使用方决定：J-6「要，订单上能选」）
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "insuranceMode" TEXT;

-- 索赔期（天）：货到目的口岸后 N 天内可提异议（真实合同有 30 天、15 天两种）
--   （使用方决定：J-7「要，能填 + 到期提醒」）
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "claimPeriodDays" INTEGER;

-- 争议解决方式：二选一「中国国际经济贸易仲裁委员会仲裁」/「出卖人所在地人民法院诉讼」
--   （使用方决定：「加二选一」）
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "disputeResolution" TEXT;

-- ── ② Shipment：计费重量 ────────────────────────────────────────────────
-- 客户 PO 的规则是「不足 20 公斤按体积重（volume weight）算，不按实重」。
-- ★ 使用方决定（J-3）：「**只存字段，不自动算**」 ⇒ 本列**只承载人工填的值**，
--   **不实现任何折算逻辑**。（Shipment 已有 grossWeight/netWeight/volume，只缺这一列。）
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "chargeableWeight" DECIMAL(12, 3);

-- ── ③ TestRequest：缩水率实测值 ─────────────────────────────────────────
-- 客户 PO 要求「工厂必须提供所有面料的缩水率（rate of shrinkage）」，29/54 份有。
-- ★ 使用方决定（J-8）：「**给个可填字段，不绑死**」——QC 过程里登记一下即可，
--   **不做校验、不做提醒**（理由：平时登记这一块的并不多）。
ALTER TABLE "TestRequest" ADD COLUMN IF NOT EXISTS "shrinkageRate" DECIMAL(8, 4);

-- ⚠️ 幂等性：重复执行时 `ADD COLUMN IF NOT EXISTS` 全部跳过 ⇒ 结果不变。
-- 回滚 = 五句 `DROP COLUMN`（存量数据不受影响）。
