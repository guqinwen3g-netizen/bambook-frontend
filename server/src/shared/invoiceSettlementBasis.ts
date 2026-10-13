/**
 * invoiceSettlementBasis.ts —— 发票「结清基准额」判据的**唯一真源**（零 import，前后端可引）
 *
 * ★ 为什么必须存在（2026-09-18 复核 CLM 索赔 S2 / S6 —— 两条都成立且同源）：
 *
 *   供应商索赔确认时会生成一张**负向 Payable 发票**（`amount: -Math.abs(row.amount)`，
 *   见 `procurement/materialReturnService.ts` 的 confirmReturn），语义 = 供应商索赔贷项、冲减应付。
 *
 *   而结清判据原本内联在两处：
 *     ① `recalcInvoiceStatus`：`amount.gt(0) && Σapplied >= amount`
 *     ② `applyAllocation`：`remaining = amount − Σapplied`，且 `applied > amount` 直接拒
 *
 *   代入负数后：
 *     ① `(-500).gt(0)` **恒假** ⇒ 核销到满也永远判不出 Paid —— **S2 负额票永不结清**
 *     ② remaining = `-500 − 0` = **-500** ⇒ 任何正数核销都撞
 *        `AMOUNT_EXCEEDS_INVOICE` / `AMOUNT_EXCEEDS_INVOICE_REMAINING` ⇒ **根本核销不进去** —— **S6 无结清路径**
 *
 *   ★ 两者叠加 = 死结：发票状态是**纯派生**（手工改被 `STATUS_NOT_MANUAL_SETTABLE` 硬挡），
 *     而派生判据对负额恒假 ⇒ 负额票**永远挂在未结清应付列表**，且没有任何自动出口。
 *
 * 判据定义：
 *   结清基准额 basis = |amount| —— 负额票的「面额」是它冲减额度的**绝对值**，不是负数本身。
 *     正额票：basis === amount（改前后**逐字节一致**，历史数据零影响）
 *     负额票：basis === |amount|（用掉多少算多少，用满即结清）
 *   已结清 ⟺ `basis > 0` 且 `Σapplied >= basis`
 *
 * ⚠️ 刻意保留的边界：`basis === 0`（0 元票）**不**判结清 —— 与收口前行为一致。
 *   0 元票的「伪逾期」问题由 `openReceivableWhere` 的 `amount > 0` 守卫解决，不在这里扩大改动面。
 *
 * ⓘ Decimal 优先：入参若是 Prisma.Decimal（有 `.abs/.gt/.gte`）则走 Decimal 路径、**精度无损**；
 *   否则退化为 number。调用点请保证 `amount` 与 `applied` **同类型**。
 *
 * ⓘ 未覆盖（需业务拍板，本轮不做）：用负额票**抵减**另一张正额应付票（「付 9500 抵 10000」那类
 *   贷项抵应付）。那需要独立的抵减明细与双向占用语义；本模块只解决「面额不能是负数」这层算术正确性。
 */

/** 金额入参：Prisma.Decimal / number / string 都吃（不 import Prisma，用 duck typing） */
export type MoneyLike = any;

function toNumber(v: MoneyLike): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v.toNumber === 'function') {
    const n = v.toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 结清基准额 = |amount|。
 * 负额票（贷项/冲减单）的面额是它的冲减额度 —— 拿负数当面额会让
 * 「已核销 0 ≥ 面额 -500」这类比较恒真/恒假，判据直接失效。
 * Decimal 入参返回 Decimal（精度无损），其余返回 number。
 */
export function settlementBasisOf(amount: MoneyLike): MoneyLike {
  if (amount != null && typeof amount.abs === 'function') return amount.abs();
  return Math.abs(toNumber(amount));
}

/** 该票是否已被结清。basis = 0（0 元票）刻意返回 false，保持历史行为。 */
export function isSettledByApplied(amount: MoneyLike, applied: MoneyLike): boolean {
  const basis = settlementBasisOf(amount);
  if (basis != null && typeof basis.gt === 'function') {
    // Decimal 路径：精度无损（与 allocationService 的 Decimal-safe 纪律一致）
    const a = applied != null && typeof applied.gte === 'function' ? applied : new (basis.constructor as any)(applied);
    return basis.gt(0) && a.gte(basis);
  }
  const b = toNumber(basis);
  if (b <= 0) return false;
  return toNumber(applied) >= b;
}

/** 剩余可核销额 = basis − Σapplied（负额票同样适用，不会算出负数导致「任何核销都超额」） */
export function remainingByApplied(amount: MoneyLike, applied: MoneyLike): number {
  return toNumber(settlementBasisOf(amount)) - toNumber(applied);
}

/**
 * ── 消费点登记（改本模块前请先读这段）────────────────────────────────
 *
 * ★ 用真源（面额 = |amount|，负额票必须能核销/结清）：
 *   1. `finance/allocationService.recalcInvoiceStatus`  —— 结清判定（S2 修复点）
 *   2. `finance/allocationService.applyAllocation`       —— 票面/剩余额校验（S6 修复点）
 *   3. `finance/invoiceMutationService.updateInvoice`    —— 改金额不低于已核销（索赔金额协商调小）
 *
 * ⓘ **刻意不用真源**（语义不是「核销额度」，改成 basis 会引入新错账）：
 *   4. `finance/writeOffService` 的 `open = amount − applied` —— 它是「**未结额**」（还欠多少），
 *      负数正是「不欠了 ⇒ 拒绝销账」的正确表达；且该服务已用 `type === 'Receivable'` 隔离。
 *   5. `credit/creditService` 的 `net = Σ(amount − applied)` —— 它是**聚合**（客户净应收）。
 *      ★ 聚合类判据**不能**装符号守卫：负数（贷项）必须计入，否则净额虚高。
 *   6. `finance/allocationService` 的 `remainingVoucher` —— 凭证侧，凭证金额恒为正。
 *   7. `events/linkages/L5AutoAllocate` —— 面向「未结清**应收**」自动核销，负额票会被
 *      `remaining.lte(0)` 天然跳过（安全，但也不会主动结清负额票）。
 *
 * ⚠️ 判定点唯一性：全 `server/src` 非测试代码里，「把票判成 Paid」只有
 *   `allocationService.recalcInvoiceStatus` 一处（其余 `=== 'Paid'` 都是**读**已定状态）。
 *   回归守卫见 `server/src/__tests__/invoiceSettlementBasisTruth.test.ts`。
 */
