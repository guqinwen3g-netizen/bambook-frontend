import {businessError} from '../shared/errorCodes';
import {summarizeOrderQuantity} from '../shared/orderQuantitySummary';
/**
 * orderAmountRecalc.ts — 改单（改数量 / 改价）后，**明细行 + 派生金额**的联动重算
 *
 * ## 为什么必须有这个（2026-09-18 真库实锤 + Kevin 拍板）
 *
 * 改单 apply 原本只写主档那一个字段（ORDER_FIELD_MAP），**明细行一律不动**：
 *   · 客户把 1800 件砍到 1500 件 → 主档 quantity=1500，明细行仍是 1800，
 *     金额仍是按 1800 件算的 21150 —— **客户要 1500 件，我们按 1800 件收钱**。
 *   · 改价同理：只改 quoteAmount，明细行单价与 totalNet 不动 ⇒
 *     概览页（quoteAmount）与订单详情/四单勾稽/出运批次（totalNet）显示两个值。
 *
 * Kevin 2026-09-18 拍板口径：
 *   ① **以明细行为准** —— 订单金额 = 明细行合计，主档金额由明细行派生，不手工填；
 *   ② **跟着改，金额重算** —— 改数量/改价后明细行同步改、金额重算。
 *
 * ## 设计要点
 * - **收口，不逐点补**：所有「改单影响金额」的路径都走本模块，避免再漂移
 *   （本仓最高产的一类 bug：收口点错位）。
 * - **尾差兜底在最后一行**：比例分摊必然产生分位误差，若各行独立取整，
 *   ΣnetValue 会 ≠ 目标值，反过来破坏「Σ明细行 = totalNet」这条硬恒等。
 *   故最后一行 = 目标值 − Σ(其余行)，**保证恒等成立**。
 * - **totalActual 不动**：它是「实际出运金额」实绩，改单改的是计划，不能覆盖实绩。
 */
import { logger } from '../lib/logger';

export type RecalcMode = 'quantity' | 'price';

export interface RecalcOutcome {
  linesUpdated: number;
  quantity: string | null;
  totalNet: number;
  contractAmount: number;
  quoteAmount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/**
 * 单价精度 —— **对齐 DB**：`OrderLine.unitPrice` 是 `Decimal(18, 4)`（schema 已定）。
 *
 * ⚠️ 因此「总额精确」与「行内 qty × 单价 = netValue 完全相等」**不可兼得**：
 *   反算出的单价存盘时被截到 4 位，`q × round4(up)` 与目标分位会有 ≤ 几分/行的残差。
 *   本实现**选择总额精确**（总额是对客户的承诺、开票与收款的依据，必须等于审批通过的数），
 *   行内自洽则退让到分位残差 —— 这是精度权衡，**不是逻辑错**。
 */
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * 改单后联动重算。
 *
 * @param tx    Prisma 事务客户端（必须，保证订单与明细行同生共死）
 * @param orderId 订单 ID
 * @param mode  'quantity' = 改总数量；'price' = 改总金额（反算单价）
 * @param value 目标值（数量 > 0；金额 >= 0）
 * @param opts  ★ 第 2 批 B：**同改「数量 + 单价」** 时一并传入目标单价。
 *   只对 `mode='quantity'` 有意义；不给 ⇒ 沿用各行原单价（既有行为，逐字不变）。
 *   ★ 为什么必须支持组合（而不是"先改数量、再改价"分两次）：前端一次保存只发一个 PUT，
 *     两样都在 patch 里；若只认其中一样，另一样就会被**静默丢弃**（本仓最贵的一类 bug）。
 * @returns 重算结果；无明细行或无法分摊时返回 null（**调用方保持原行为，不报错**）
 */
export async function recalcOrderAmountFromLines(
  tx: any,
  orderId: string,
  mode: RecalcMode,
  value: number,
  opts?: { unitPrice?: number },
): Promise<RecalcOutcome | null> {
  if (!Number.isFinite(value) || (mode === 'quantity' ? value <= 0 : value < 0)) {
    logger.warn('[OrderAmountRecalc] 目标值非法，跳过联动', { orderId, mode, value });
    return null;
  }

  const lines = await tx.orderLine.findMany({
    where: { orderId },
    orderBy: { lineNumber: 'asc' },
    select: { id: true, quantity: true, unit: true, unitPrice: true, netValue: true },
  });

  // 无明细行：没有可分摊的载体，保持主档单点写入（既有行为），不制造假一致
  if (!lines || lines.length === 0) {
    logger.warn('[OrderAmountRecalc] 订单无明细行，跳过联动（主档单点写入）', { orderId, mode });
    return null;
  }

  const qtySummary=summarizeOrderQuantity({activeOrderLines:lines.map((l:any)=>({quantity:l.quantity.toString(),unit:l.unit}))});
  if(qtySummary.state!=='single_unit')throw businessError('CONFLICT','混单位或未录单位的价格分摊需要明确逐行金额方案');
  const oldTotalQty = lines.reduce((s: number, l: any) => s + num(l?.quantity), 0);

  // ★ 同改单价：用户显式给的单价**压过**各行原单价（`salesPrice` 是主档唯一单价，
  //   与「contractAmount = salesPrice × quantity」同一口径）。
  //   未给 ⇒ unitPriceOf() 退化为各行原单价 ⇒ 与改动前逐字等价。
  const overrideUnitPrice =
    opts?.unitPrice != null && Number.isFinite(opts.unitPrice) && opts.unitPrice >= 0
      ? opts.unitPrice
      : null;
  const unitPriceOf = (l: any): number => (overrideUnitPrice != null ? overrideUnitPrice : num(l?.unitPrice));

  if(mode==='quantity')throw businessError('CONFLICT','数量变更必须通过原批准的逐行精确计划，禁止自动比例取整');

  // ── 改价：目标总额 → 反算单价 → 各行 netValue，最后一行兜底尾差 ──
  if (oldTotalQty <= 0) {
    logger.warn('[OrderAmountRecalc] 原总数量为 0，无法反算单价', { orderId });
    return null;
  }
  const unitPrice = value / oldTotalQty;
  let assigned = 0;
  const plan: { id: string; unitPrice: number; netValue: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] as any;
    const isLast = i === lines.length - 1;
    const q = num(l?.quantity);
    const net = isLast ? round2(value - assigned) : round2(q * unitPrice);
    assigned += net;
    // ★ 单价由金额反算（而不是先给单价再算金额）：
    //   若把 unitPrice 独立四舍五入到 2 位，`Σ(qty × unitPrice)` 会 ≠ `ΣnetValue`
    //   —— 硬恒等被破坏，明细行会自己跟自己打架。反算则两个恒等同时成立。
    const up = q > 0 ? round4(net / q) : unitPrice;
    plan.push({ id: String(l.id), unitPrice: up, netValue: net });
  }
  await Promise.all(
    plan.map((p) => tx.orderLine.update({ where: { id: p.id }, data: { unitPrice: p.unitPrice, netValue: p.netValue } })),
  );
  const totalNet = round2(plan.reduce((s, p) => s + p.netValue, 0));
  await tx.order.update({
    where: { id: orderId },
    data: {
      totalNet,
      contractAmount: totalNet,
      quoteAmount: totalNet,
    },
  });
  const orderAfter = await tx.order.findUnique({ where: { id: orderId }, select: { quantity: true } });
  return {
    linesUpdated: plan.length,
    quantity: orderAfter?.quantity?.toString() ?? null,
    totalNet,
    contractAmount: totalNet,
    quoteAmount: totalNet,
  };
}
