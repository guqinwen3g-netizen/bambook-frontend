/**
 * forexQuoteService.ts —— Dashboard 汇率的**唯一真源**
 *
 * ★ 为什么不再直连 exchangerate-api.com（2026-09-19 收口）：
 *   系统里汇率原本有**两个来源**：
 *     · Dashboard 卡 → `api.exchangerate-api.com/v4/latest/USD`（USD 基准交叉换算）
 *     · 财务 / 单据换算 → `ExchangeRate` 表（`fxRateSync` 每日 08:30 从 `open.er-api.com/v6/latest/CNY` 同步）
 *   生产实测**同一天两处数值不同**：USD 6.72 vs 6.721785 · GBP 8.9840 vs 8.980369（差异 <0.06%）。
 *   这正是 Kevin 提过的「跨页数字一致」问题 ⇒ 收口到**财务表这一个真源**。
 *
 * ★ 口径天然一致（无需交叉换算）：
 *   `ExchangeRate.rate` 的 schema 注释即「1 单位外币兑 CNY」，与 Dashboard 需要的
 *   `USD_CNY / EUR_CNY / GBP_CNY` **完全同义**。旧实现是拿 base=USD 的牌价反算，属于绕路。
 *
 * ★ 分层原则同 `marketQuoteService`：**拿不到就 `rate=null`，绝不回落硬编码，
 *   也不偷偷去抓第二个源。** 表里没有 = 同步没跑，那是需要被看见的问题，不是需要糊过去的。
 *
 * ⓘ 展示约定：本源的数值是**每日定盘**（不是逐笔实时）。界面按 `asOf` 显示日期角标；
 *   数据当天有效时不打扰用户，**过期（asOf ≠ 今天）时必须标出**。
 */

/** Dashboard 汇率卡实际展示的币种（与前端 `TICKER_SKELETON` 一致） */
export const FOREX_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type ForexCurrency = (typeof FOREX_CURRENCIES)[number];

export type ForexFreshness = 'daily' | 'unavailable';

export interface ForexQuote {
  /** 币种代码（ExchangeRate.currency 归一化大写） */
  currency: ForexCurrency;
  /** 前端 ticker symbol，如 `USD/CNY` */
  symbol: string;
  /** 1 单位外币兑 CNY；**null = 表里没有**（不回落硬编码） */
  rate: number | null;
  /** 数据所属日期（ExchangeRate.effectiveDate） */
  asOf: string | null;
  source: string;
  freshness: ForexFreshness;
  isReal: boolean;
  /** 失败原因（诊断用，不当作数据） */
  error?: string;
}

const SOURCE_LABEL = 'ExchangeRate 表 · fxRateSync 每日同步';

/** 只依赖用到的那一点 Prisma 能力，便于单测注入 */
export interface ExchangeRateReader {
  exchangeRate: {
    findMany(args: {
      where?: unknown;
      orderBy?: unknown;
      take?: number;
      select?: unknown;
    }): Promise<Array<Record<string, unknown>>>;
  };
}

export interface ExchangeRateRowLike {
  currency?: unknown;
  rate?: unknown;
  effectiveDate?: unknown;
  source?: unknown;
  /** 同一天多条时用它定先后（BigInt 或 number 都可以） */
  createdAt?: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 单纯函数：从任意顺序的行里挑出每个币种的**最新一条**（按 effectiveDate、再按 createdAt）。
 * 抽出来是为了能直接喂夹具做守卫（不依赖真库）。
 */
export function pickLatestPerCurrency(
  rows: ExchangeRateRowLike[],
  currencies: readonly string[] = FOREX_CURRENCIES,
): Map<string, { rate: number; asOf: string | null; source: string }> {
  const out = new Map<string, { rate: number; asOf: string | null; source: string }>();
  // 行可能乱序 ⇒ 显式排序，不依赖调用方
  const sorted = [...rows].sort((a, b) => {
    const da = typeof a.effectiveDate === 'string' ? a.effectiveDate : '';
    const db = typeof b.effectiveDate === 'string' ? b.effectiveDate : '';
    if (da !== db) return db.localeCompare(da); // 日期降序
    const ca = Number(a.createdAt ?? 0);
    const cb = Number(b.createdAt ?? 0);
    return cb - ca;
  });
  for (const r of sorted) {
    const cur = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : '';
    if (!cur || !currencies.includes(cur) || out.has(cur)) continue;
    const rate = Number(r.rate);
    if (!Number.isFinite(rate) || rate <= 0) continue; // 坏行跳过，继续找下一条
    const asOf = typeof r.effectiveDate === 'string' && DATE_RE.test(r.effectiveDate) ? r.effectiveDate : null;
    out.set(cur, {
      rate,
      asOf,
      source: typeof r.source === 'string' && r.source ? r.source : SOURCE_LABEL,
    });
  }
  return out;
}

/** 取汇率（真源 = ExchangeRate 表）。任何异常 ⇒ 全部 `rate=null`，不抛。 */
export async function fetchForexQuotes(
  prisma: ExchangeRateReader | null,
  currencies: readonly ForexCurrency[] = FOREX_CURRENCIES,
): Promise<ForexQuote[]> {
  const base = (c: ForexCurrency): ForexQuote => ({
    currency: c,
    symbol: `${c}/CNY`,
    rate: null,
    asOf: null,
    source: SOURCE_LABEL,
    freshness: 'unavailable',
    isReal: false,
  });

  if (!prisma) {
    return currencies.map((c) => ({ ...base(c), error: 'prisma-unavailable' }));
  }

  let rows: ExchangeRateRowLike[] = [];
  try {
    rows = (await prisma.exchangeRate.findMany({
      where: { currency: { in: [...currencies] } },
      orderBy: [{ effectiveDate: 'desc' }],
      take: 200,
    })) as ExchangeRateRowLike[];
  } catch (e: any) {
    const error = `exchange-rate-read-failed: ${String(e?.message || e)}`;
    return currencies.map((c) => ({ ...base(c), error }));
  }

  const latest = pickLatestPerCurrency(rows, currencies);
  return currencies.map((c) => {
    const hit = latest.get(c);
    if (!hit) return { ...base(c), error: 'no-exchange-rate-row' };
    return { ...base(c), rate: hit.rate, asOf: hit.asOf, source: hit.source, freshness: 'daily', isReal: true };
  });
}

/**
 * 汇总成 `/api/market/all` 的 `forex` 载荷（保持旧的扁平键 `USD_CNY` 等，向前兼容）。
 * `asOf` 取**各组中最早的那个**：只要有任意一个币种没跟上，就把较早的日期显示出来（保守，不美化）。
 */
export function toForexPayload(quotes: ForexQuote[], todayIso: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const dates: string[] = [];
  for (const q of quotes) {
    payload[`${q.currency}_CNY`] = q.rate;
    if (q.asOf) dates.push(q.asOf);
  }
  const asOf = dates.length ? dates.slice().sort()[0] : null;
  const available = quotes.filter((q) => q.rate !== null);
  payload.source = SOURCE_LABEL;
  payload.freshness = available.length ? 'daily' : 'unavailable';
  payload.asOf = asOf;
  payload.isEstimate = false;
  /** 当日已同步 = 正常；否则界面必须把日期标出来 */
  payload.isStale = asOf !== null ? asOf !== todayIso : true;
  payload.currencies = Object.fromEntries(
    quotes.map((q) => [q.currency, { rate: q.rate, asOf: q.asOf, source: q.source, ...(q.error ? { error: q.error } : {}) }]),
  );
  return payload;
}

export const __internal = { pickLatestPerCurrency, toForexPayload };
