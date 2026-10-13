/**
 * crossCurrency.ts — 跨币种折算的**唯一真源**（**纯函数，零依赖**）
 *
 * ── 为什么单独成文件 ──
 * 同 `thirdPartyPaymentGuard.ts` / `receiptAttribution.ts`：判定要被服务端报表内核、
 * 服务端门禁测试、前端同口径展示（驾驶舱毛利表）三方消费 ⇒ 不能带 @prisma/client。
 *
 * ── 业务问题（B2：双币种毛利算不出来）──
 * 面料外贸常态是「销售收 USD、采购付 CNY」。旧驾驶舱 `margin = 跨币种 ? null : revenue − cost`
 * ⇒ **采销币种一不一致，这笔单赚多少就永远看不见**（而恰恰这类单最需要盯汇率风险）。
 * 直接相减是**错的**（1000 USD − 5000 CNY = −4000 是个没有意义的数），
 * 所以之前选择「不算」；正确的做法是**折算**，不是放弃。
 *
 * ── 折算口径 ──
 *   ExchangeRate.rate 语义 = **1 单位外币兑 CNY**（schema 真源）。
 *   所以 A → B 必须**经 CNY 过桥**，不要自造直盘汇率：
 *       amount_B = amount_A × rate(A→CNY) ÷ rate(B→CNY)
 *   例：成本 5000 CNY、销售 USD、USD 汇率 7.1 ⇒ 5000 ÷ 7.1 = 704.23 USD。
 *   ⓘ CNY 自身 rate 恒为 1（表里没有 CNY→CNY 的行，也不该有）。
 *
 * ── 取数优先级（与 fxReconciliationService 同口径）──
 *   ① 锁汇（FxRateLock）：锁了就用锁定汇率 —— 这才是业务员心里那笔账
 *   ② 市场汇率（ExchangeRate）：effectiveDate ≤ 业务日期的最近一条；无则回退该币种最新一条
 *   ③ 取不到 → **返回 null，不猜、不按 1 折算**（猜出来的毛利比没有更危险）
 *
 * ⚠️ 汇率缺失时**必须**让调用方显示「无法折算」而不是 0 —— 后者会让老板以为这单毛利 100%。
 */

/** 汇率表：币种（大写）→ 1 单位该币种兑 CNY */
export type CnyRateTable = Record<string, number | null | undefined>;

export interface ConversionResult {
  /** 折后金额（目标币种） */
  amount: number;
  /** 实际使用的汇率：1 单位 from = ? 单位 to */
  rate: number;
}

const norm = (c?: string | null): string => (c || '').trim().toUpperCase();

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** CNY 自身汇率恒为 1（表里不存 CNY 行，硬编码是唯一正确解） */
const CNY_RATE = 1;

/**
 * 经 CNY 过桥折算。同币种 → 原值（rate=1）。
 * 任一侧汇率缺失 / 非正数 → **null**（不猜，见文件头）。
 */
export function convertViaCny(
  amount: number,
  from: string | null | undefined,
  to: string | null | undefined,
  rates: CnyRateTable,
): ConversionResult | null {
  const f = norm(from);
  const t = norm(to);
  if (!Number.isFinite(amount)) return null;
  if (f && f === t) return { amount: round4(amount), rate: 1 };

  const rFrom = f === 'CNY' ? CNY_RATE : Number(rates[f]);
  const rTo = t === 'CNY' ? CNY_RATE : Number(rates[t]);
  if (!Number.isFinite(rFrom) || !Number.isFinite(rTo) || rFrom <= 0 || rTo <= 0) return null;

  const rate = rFrom / rTo;
  return { amount: round4(amount * rate), rate: Math.round(rate * 1e8) / 1e8 };
}

export interface FxRateRow {
  currency: string;
  rate: number | string | null | undefined;
  effectiveDate?: string | null;
}

/**
 * 从汇率档案中取某币种在某日的汇率：effectiveDate ≤ onDate 的最近一条；
 * 一条都没有 → 回退该币种**最新**一条（兼容「档案尚未补录到业务日期」的历史数据）；
 * 再没有 → null。
 */
export function pickRateOn(rows: FxRateRow[], currency: string, onDate?: string | null): number | null {
  const c = norm(currency);
  if (c === 'CNY') return CNY_RATE;
  const mine = (rows ?? []).filter(r => norm(r.currency) === c && Number(r.rate) > 0);
  if (mine.length === 0) return null;

  if (onDate) {
    const eligible = mine.filter(r => (r.effectiveDate ?? '') <= onDate);
    if (eligible.length > 0) {
      eligible.sort((a, b) => String(b.effectiveDate ?? '').localeCompare(String(a.effectiveDate ?? '')));
      return Number(eligible[0].rate);
    }
  }
  mine.sort((a, b) => String(b.effectiveDate ?? '').localeCompare(String(a.effectiveDate ?? '')));
  return Number(mine[0].rate);
}
