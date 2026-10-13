-- ★ A1（口径拍板件 §2.1，2026-09-25）：OrderLine / Relation 补「创建时间」
-- 真源：.workbuddy-ai/audit/口径拍板-交付件-2026-09-25.md §2.1 · §一 第 1 条（卡主线）
--
-- 为什么必须补：整链演练（scripts/acceptance-e2e-business-chain.mjs）用 `createdAt` 做
-- 「本次窗口造了几行」的窗口计数 —— scripts/lib/acceptance-selfcheck.mjs:1008
--   `delegate.count({ where: { createdAt: { gte: bound } } })`
-- 而这两张表原先**没有任何创建时间列** ⇒ 链按 id 删过它们的行却「没被问过」
-- ⇒ 归因层（snapshotIdSets 的分母）与窗口层都判不了 ⇒ M3 整链判决恒 `unproven`。
-- 取证：docs/M3真跑取证-第十七程-2026-09-25-HEAD-96f5e67c.md（红因第一条点名这两张表）
--
-- ⚠️⚠️ 硬条件（拍板件 §2.1 第 2 条，**不遵守会比现在更坏**）：
--   存量行必须填「明显早于任何演练」的时间。**绝不能填 `now()`** ——
--   窗口计数把 `createdAt >= 本程起点` 的行算成「本次演练自造的」，
--   存量行若为 now() 就会**制造假残留**（判决从"判不了"变成"判成脏"）。
--   故本迁移分两句：① 带哨兵默认值加列（存量行吃哨兵）；② 再把默认值换成 CURRENT_TIMESTAMP（新行用 now()）。
--
-- 哨兵值 = `1970-01-01 00:00:00`（Unix epoch）。它是**固定字面量**（不是"迁移执行前的时刻"），
-- 因此可复现、且在任何窗口判据下都必然落在窗口之外。
--
-- 本仓范式：**手写幂等 SQL**（`prisma migrate dev` 不可用：shadow DB 重放历史迁移必崩 P3006）。
-- 类型与 `Order.createdAt` 同型（`TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`，见
-- 20260418002201_add_order_lines_and_po_fields/migration.sql:12）。
-- 回滚 = 两句 `DROP COLUMN`（存量数据不受影响）。
--
-- ⚠️ 幂等性：重复执行时 `ADD COLUMN IF NOT EXISTS` 跳过、`SET DEFAULT` 重设同值 ⇒ 结果不变。
-- ⚠️ 生产迁移**等 Kevin 安排**（拍板件 §2.1 硬条件 1）；部署前仍走
--    `server/scripts/fix-migration-ledger.ts` 的 dry-run。

ALTER TABLE "OrderLine" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT TIMESTAMP '1970-01-01 00:00:00';
ALTER TABLE "OrderLine" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Relation" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT TIMESTAMP '1970-01-01 00:00:00';
ALTER TABLE "Relation" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
