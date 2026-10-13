/**
 * orderAmount.ts — 「订单金额」判据的**唯一真源**（纯函数，无业务副作用）
 *
 * ## 为什么必须有这一处（2026-09-18 真库实锤）
 *
 * 系统里曾存在 **5 个金额出口 + 3 组互相冲突的口径**：
 *   quoteAmount（报价额）/ contractAmount（合同额）/ totalNet（成交净额）
 *   / totalActual（实际额）/ Σ明细行 netValue
 *
 *   A 组 `contractAmount ?? quoteAmount`  → dashboardService / seasonService
 *   B 组 `totalNet ?? quoteAmount`        → reconciliationService / orderShipmentBatchService
 *   C 组 `quoteAmount`（裸用，无回退）     → components/Dashboard.tsx
 *
 * ⇒ 同一张单，前端概览页与订单详情/四单勾稽/出运批次/季节 ROI **显示不同值**。
 *   实测：改价审批通过后只改 quoteAmount，概览页显示 18000、其余页面显示 21150。
 *
 * ## Kevin 拍板口径（2026-09-18）
 *   **以明细行为准** —— 订单金额 = 明细行合计，主档金额由明细行派生，不手工填。
 *
 * 因此本函数的取值次序即真源次序：
 *   ① Σ明细行 netValue（有明细行时，**绝对优先**，这是 Kevin 拍板的真源）
 *   ② totalNet       （服务端 select 未带 lines 时的等价回退：totalNet ≡ Σ明细行，
 *                      已由「改单联动重算」保证，见 orderChangeRequestService）
 *   ③ quoteAmount    （最后回退，避免 0 值掩盖问题）
 *
 * ⚠️ 新增「取订单金额」的代码**必须**用本模块，不要再手写 `contractAmount ?? quoteAmount`
 *    之类的内联表达式（回归守卫见 `server/src/__tests__/orderAmountTruth.test.ts`）。
 */

/**
 * 数值形态：number / 数字字符串 / **Prisma.Decimal**（Decimal.js 实例，带 toNumber）。
 * 用 unknown 兜底：本真源要能同时吃下 Prisma 查询结果（Decimal）与前端 JSON（number），
 * 与其让调用方到处 `Number(x)`，不如在真源内部统一安全转换（见 num()）。
 */
import type { Prisma } from '@prisma/client';

export type NumericLike = unknown;

/** 明细行最小形态（只取本真源需要的字段，避免耦合整个 OrderLine 模型） */
export interface OrderAmountLine {
  netValue?: NumericLike;
  quantity?: NumericLike;
  unitPrice?: NumericLike;
}

/** 订单最小形态 */
export interface OrderAmountRow {
  totalNet?: NumericLike;
  quoteAmount?: NumericLike;
  contractAmount?: NumericLike;
  /**
   * 主档销售单价 + 主档数量。
   * ★ 2026-09-26（第 2 批 A）补：`salesPrice` 是设计里的「金额联动源」
   *   （`contractAmount = salesPrice × quantity`），明细行单价也由它派生
   *   （`lib/orderLineItems.ts` `unitPrice: order.salesPrice`）。
   *   ⇒ 自检不看它 ⇒「主档单价改了、明细行单价没跟」这种分叉**完全不可见**。
   */
  salesPrice?: NumericLike;
  quantity?: NumericLike;
  lines?: OrderAmountLine[] | null;
}

/**
 * 转数字：兼容 number / 数字字符串 / Prisma.Decimal（Decimal.js 实例）。
 * 非有限值一律返回 null，**不用 0 兜底** —— 0 会把「没取到」伪装成「金额是 0」。
 */
function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const anyV = v as { toNumber?: () => number };
  if (typeof anyV?.toNumber === 'function') {
    try {
      const n = anyV.toNumber();
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 订单金额真源。**唯一**取值入口。
 *
 * @param order 订单行；传了 `lines` 就以明细行为准（Kevin 口径），否则按 totalNet → quoteAmount 回退。
 */
export function orderAmountOf(order: OrderAmountRow | null | undefined): number {
  if (!order) return 0;

  // ① 明细行优先（真源）
  const lines = order.lines;
  if (Array.isArray(lines) && lines.length > 0) {
    let sum = 0;
    let any = false;
    for (const l of lines) {
      const v = num(l?.netValue);
      if (v != null) { sum += v; any = true; }
    }
    if (any) return round2(sum);
  }

  // ② 成交净额（≡ Σ明细行；select 未带 lines 时的等价回退）
  const tn = num(order.totalNet);
  if (tn != null) return round2(tn);

  // ③ 报价额
  const q = num(order.quoteAmount);
  return round2(q ?? 0);
}

/** Financial writes use the same line → totalNet → quoteAmount precedence,
 * retaining every native decimal digit and an unknown value as null. The
 * server supplies its actual Decimal constructor; importing this pure module
 * into the frontend must never import Prisma runtime. Display
 * helpers below retain their historical two-decimal Number representation. */
export function orderAmountDecimalOrNull(order: OrderAmountRow | null | undefined, Decimal: typeof Prisma.Decimal): Prisma.Decimal | null {
  if (!order) return null;
  const decimal = (value: unknown): Prisma.Decimal | null => {
    if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
    try { const result = new Decimal(String(value)); return result.isFinite() ? result : null; }
    catch { return null; }
  };
  if (Array.isArray(order.lines)) {
    let sum = new Decimal(0), known = false;
    for (const line of order.lines) {
      const value = decimal(line?.netValue);
      if (value !== null) { sum = sum.plus(value); known = true; }
    }
    if (known) return sum;
  }
  const total = decimal(order.totalNet);
  if (total !== null) return total;
  return decimal(order.quoteAmount);
}

/**
 * 订单金额的**可空**形态：真源三步都取不到数时返回 `null`，而不是 `0`。
 *
 * 为什么必须有这一条（2026-09-26 E 批）：
 *   `orderAmountOf` 的 ③ 是 `round2(q ?? 0)` —— 对**参与计算**的调用方是对的（金额缺省按 0 记账），
 *   但**单据渲染 / xlsx 导出 / 登记进 TradeDocument.totalAmount** 这三类落点吃不下这个 0：
 *   ★ 作用域（本批复核收回的一半）：`Order.quoteAmount` 是 `Decimal @db.Decimal(18,4)` **NOT NULL**，
 *     所以「整行加载后三步全空」在真实订单上到不了 —— 本函数**真正防的是行没带这些列**
 *     （select 被收窄 ⇒ 真源静默降级），以及 `order` 为空。次序对撞已有尺：
 *     `server/src/__tests__/orderAmountTruth.test.ts` 的「of/orNull 只能差在 null-vs-0」那一格。
 *     · 模板侧 `money(v)` 把 `null` 渲染成「—」（= 未知），`0` 渲染成「0.00 USD」（= 已知是零）；
 *     · 落库的 `totalAmount` 一旦写 0，事后没人能区分「这单真的是 0 元」与「装配时没取到数」。
 *   本仓已有同族红线（月结对比缺快照一律 null，不得回落 0；§9 B142「文本框兜到 0」那族），
 *   ⇒ 取不到数就**照实说不知道**，别让它伪装成一个金额。
 *
 * 取值次序与 `orderAmountOf` **完全一致**（① 明细行 → ② totalNet → ③ quoteAmount），
 * 只在"三步全空"这一个分叉上返回 null。
 */
export function orderAmountOrNull(order: OrderAmountRow | null | undefined): number | null {
  if (!order) return null;

  const lines = order.lines;
  const hasLineValue = Array.isArray(lines) && lines.some((l) => num(l?.netValue) != null);
  if (hasLineValue) return orderAmountOf(order);

  if (num(order.totalNet) != null) return orderAmountOf(order);

  const q = num(order.quoteAmount);
  return q == null ? null : round2(q);
}

/**
 * 金额口径自检：主档金额与明细行合计是否自相矛盾。
 *
 * 用途：改单/导入/审批等**写路径**收口处的断言，以及验收演练的对撞。
 * 返回 null = 一致（或无足够信息判断）；返回对象 = 不一致，调用方应视为**错账风险**。
 *
 * ## 对撞的五条（2026-09-26 第 2 批 A 由三条扩到五条）
 *   ① Σ明细行 ↔ totalNet
 *   ② Σ明细行 ↔ contractAmount
 *   ③ Σ明细行 ↔ quoteAmount
 *   ④ salesPrice ↔ 明细行单价（★ 新增）—— 单价是「金额联动源」，改了主档没改明细行即分叉
 *   ⑤ salesPrice × quantity ↔ totalNet（★ 新增）—— 三列内部自洽也可能单价/数量与金额打架
 *
 * ★ ④ 的归因纪律：多行且单价**各不相同**时主档单价无法归因（可能是混合均价）
 *   ⇒ **不下结论**（与「无明细行 → 不误报」同一条纪律：信息不足不猜）。
 * ★ 所有「空」都视为**信息不足**而非「0」⇒ 不参与对撞（不制造假冲突）。
 */
export function findOrderAmountConflict(order: OrderAmountRow | null | undefined): {
  lineSum: number;
  totalNet: number | null;
  quoteAmount: number | null;
  contractAmount: number | null;
  salesPrice: number | null;
  conflicts: string[];
} | null {
  if (!order) return null;
  const hasLines = Array.isArray(order.lines) && order.lines.length > 0;
  const lineSum = hasLines
    ? round2((order.lines as OrderAmountLine[]).reduce((s, l) => s + (num(l?.netValue) ?? 0), 0))
    : null;
  const totalNet = num(order.totalNet);
  const quoteAmount = num(order.quoteAmount);
  const contractAmount = num(order.contractAmount);
  const salesPrice = num(order.salesPrice);
  const quantity = num(order.quantity);

  const conflicts: string[] = [];
  if (lineSum != null && totalNet != null && Math.abs(lineSum - totalNet) > 0.005) {
    conflicts.push(`Σ明细行(${lineSum}) ≠ totalNet(${totalNet})`);
  }
  if (lineSum != null && contractAmount != null && Math.abs(lineSum - contractAmount) > 0.005) {
    conflicts.push(`Σ明细行(${lineSum}) ≠ contractAmount(${contractAmount})`);
  }
  if (lineSum != null && quoteAmount != null && Math.abs(lineSum - quoteAmount) > 0.005) {
    conflicts.push(`Σ明细行(${lineSum}) ≠ quoteAmount(${quoteAmount})`);
  }

  // ④ salesPrice ↔ 明细行单价（只在能归因时判：有明细行 + 各行单价唯一 + 主档有单价）
  if (salesPrice != null && hasLines) {
    const unitPrices = (order.lines as OrderAmountLine[])
      .map((l) => num(l?.unitPrice))
      .filter((v): v is number => v != null);
    const distinct = [...new Set(unitPrices)];
    if (distinct.length === 1 && Math.abs(distinct[0] - salesPrice) > 0.005) {
      conflicts.push(`salesPrice(${salesPrice}) ≠ 明细行单价(${distinct[0]})`);
    }
  }

  // ⑤ salesPrice × quantity ↔ totalNet
  if (salesPrice != null && quantity != null && totalNet != null) {
    const product = round2(salesPrice * quantity);
    if (Math.abs(product - totalNet) > 0.005) {
      conflicts.push(`salesPrice×quantity(${product}) ≠ totalNet(${totalNet})`);
    }
  }

  if (conflicts.length === 0) return null;
  return { lineSum: lineSum as number, totalNet, quoteAmount, contractAmount, salesPrice, conflicts };
}
