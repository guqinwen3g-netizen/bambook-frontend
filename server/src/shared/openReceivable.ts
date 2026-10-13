/**
 * openReceivable.ts — 「未结清应收」判据的**唯一真源**
 *
 * 为什么必须收成一处（2026-09-17 真库演练实锤）：
 *   原先 6 个消费点各自手写 `type: 'Receivable' && status ∈ {Issued, PartiallyPaid'}`，
 *   **不看金额、也不看未结额（open）**。而 `amount` 的符号守卫只禁「负数」、**放行 0**
 *   （invoiceMutationService.validateAmountAndCurrencyFields：`NON_NEGATIVE_FIELDS = {amount}`）。
 *   → 一张 **0 元应收票**（真 API 可建，实测 201）被当成「未结清逾期应收」：
 *       · creditService.maxOverdueDays 计入它的账龄 → 虚增最大逾期天数
 *       · checkCreditAvailable 命中 `maxOverdueDays > 60` → **blocked / OVERDUE_60_DAYS**
 *       · riskService 客户风险画像 + 坏账扫描同样误判
 *       · receivableOverdueDetector 给它发「逾期未收清」催办通知
 *   而 `recalcInvoiceStatus` 的 Paid 判据是 `amount.gt(0) && Σapplied ≥ amount`
 *   → amount ≤ 0 的票**永远不可能 Paid** → 虚增的逾期**永不清零**：
 *     客户被永久挡单，且没有任何自动路径能解除（自动解冻要求 maxOverdueDays ≤ 60）。
 *
 *   ★ 这也是 L2 高危 5 号「客户索赔模型」的**地基**：客户索赔/折让在实务上就是
 *     「负向应收（贷项）」，判据不放行 → 贷项票会立刻制造虚假逾期 + 永久冻结。
 *
 * 判据定义：
 *   「未结清应收」= type='Receivable' 且 status ∈ {Issued, PartiallyPaid} 且 **amount > 0**
 *   为什么 `amount > 0` 已足够（不必真去算 Σapplied）：
 *     在状态机成立的前提下（见 allocationService.recalcInvoiceStatus），
 *     `Issued / PartiallyPaid` 蕴含 `open > 0`；而 `open = amount − Σapplied ≤ amount`，
 *     所以 `amount ≤ 0 ⇒ open ≤ 0`（不欠钱）。反过来 `amount > 0` 且状态为未结清 ⇒ open > 0。
 *   真源脚本：`scripts/acceptance-zero-amount-invoice-credit-gate.ts`（真库 + 真实服务 + 自回滚）。
 *
 * ⚠️ 新增「按未结清应收筛选发票」的代码时**必须**用本模块，不要再手写 status 集合
 *    （回归守卫见 `server/src/__tests__/openReceivableJudgment.test.ts`）。
 */

/** 未结清状态集合（Issued = 已开票未收；PartiallyPaid = 部分核销） */
export const RECEIVABLE_OPEN_STATUSES = ['Issued', 'PartiallyPaid'] as const;

/** SQL 侧：未结清应收的 where 片段（含金额守卫）。可传 extra 叠加业务过滤。 */
export function openReceivableWhere(extra: Record<string, unknown> = {}): Record<string, unknown> {
  // ⚠️ 核心判据写在 extra **之后**：调用方传进来的同名字段**不能**覆盖掉守卫
  //   （否则 `openReceivableWhere({ amount: { lt: 0 } })` 会把守卫悄悄关掉）。
  return {
    ...extra,
    type: 'Receivable',
    status: { in: [...RECEIVABLE_OPEN_STATUSES] },
    deletedAt: null,
    amount: { gt: 0 },
  };
}

/**
 * JS 侧：单行金额守卫（**循环内的兜底**）。
 * 为什么要双保险：mock prisma / 手写 SQL / 已取回内存的行 —— where 条件不会自动生效，
 * 少了这个守卫，单元测试里的 0 元票仍会被当成逾期，回归就钉不住。
 */
export function hasOpenAmount(amount: unknown): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}
