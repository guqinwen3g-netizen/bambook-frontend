/**
 * marketQuoteService.ts —— Dashboard 行情（汇率之外的大宗商品）的**唯一真源**
 *
 * ★ 分层原则：按「市场上到底有没有这个东西」分层，**拿不到就返回 null，绝不编造**。
 *
 *   1. **棉花 cotton —— 真实时**
 *      新浪财经期货接口（`hq.sinajs.cn`）：郑棉连续 `nf_CF0`（元/吨）+ 美棉 `hf_CT`（美分/磅）。
 *      两个市场都有连续交易，所以"实时"是成立的。
 *      ⚠️ 需带 `Referer: https://finance.sina.com.cn`，否则 403；响应是 GBK（只取数字字段，不受影响）。
 *      ⚠️ 国内盘夜间休市时，`nf_CF0` 显示的是**当日收盘价**（属正常，`asOf` 会带出交易日期）。
 *
 *   2. **羊毛 wool —— 没有实时（物理上没有）**
 *      羊毛是**拍卖市场**（每周二/三/四拍卖），业界基准 AWEX EMI 是**周度指数**；
 *      AWEX 官网明示实时数据为付费服务（"premium real-time access"）。
 *      ⇒ 读系统配置 `market.wool`（人工录入，带 asOf）。**不抓第三方新闻页**。
 *
 *   3. **亚麻 linen —— 没有公开源**
 *      全球亚麻无公开连续报价 ⇒ 读系统配置 `market.linen`（人工录入，带 asOf）。
 *
 * ★ 为什么不去抓 Elders / 生意社这类页面：它们是**面向人的自然语言**，
 *   例如 "the benchmark EMI lost 28 cents ... closing at 1,873 cents" ——
 *   正则极易把「跌了 28 分」当成「指数 = 28」抓下来。**抓错数字比没有数字更糟**
 *   （本仓纪律：误报比漏报更伤信任）。所以宁可显式标注「手工录入」。
 *
 * ⓘ 前端展示约定：`isReal === false` 或 `freshness !== 'realtime'` 时，
 *   界面必须显示新鲜度标签（如「周度」「手工 · 09-18」），不得让业务员误以为是实时行情。
 */

export type QuoteFreshness = 'realtime' | 'auto' | 'manual' | 'unavailable';

// ── 羊毛 / 亚麻报价 ──────────────────────────────────────────────────
// 真源 = 系统配置 `global::market.<key>`，值见 `autoQuoteSources.AutoQuoteValue`。
// ★ 2026-09-19 起**默认由自动同步写入**（羊毛=IMF 月度 / 亚麻=欧洲亚麻联盟季度，
//   见 `market/autoQuoteSources.ts`）；人工写入降级为**应急覆盖**。
// 读写共用下面这套常量：写入口的区间校验与这里的读取校验必须是**同一份**，
// 否则会出现「录入端接受、展示端却当成脏数据丢掉」的哑巴故障。

/** 报价键（自动同步 + 应急覆盖共用） */
export const MANUAL_QUOTE_KEYS = ['wool', 'linen'] as const;
export type ManualQuoteKey = (typeof MANUAL_QUOTE_KEYS)[number];

/**
 * 合理性区间（CNY/吨）。用途是**挡住数量级笔误**（多敲一个 0、误填澳分/公斤），
 * 不是业务定价规则 —— 所以取得宽，业务真值不会碰到边界。
 */
export const MANUAL_QUOTE_RANGES: Record<ManualQuoteKey, readonly [number, number]> = {
  wool: [10_000, 500_000],
  linen: [10_000, 500_000],
};

/** 配置键名（读 / 写唯一出处） */
export function manualQuoteConfigKey(key: ManualQuoteKey): string {
  return `market.${key}`;
}

export interface MarketQuote {
  /** 业务键：cotton / wool / linen（前端按此映射到原有 ticker symbol） */
  key: 'cotton' | 'wool' | 'linen';
  /** 显示名 */
  label: string;
  /** 报价；**null = 无数据**（前端显示「暂无数据」，不得回落成硬编码数字） */
  price: number | null;
  currency: string;
  unit: string;
  /** 数据所属日期 YYYY-MM-DD（真实时=交易日；手工=录入时填的日期） */
  asOf: string | null;
  freshness: QuoteFreshness;
  /** 来源描述（给人看的） */
  source: string;
  /** 是否来自真实外部行情源（realtime / auto ⇒ true；人工覆盖 / 无数据 ⇒ false） */
  isReal: boolean;
  /** 自动同步的发布节奏（月度 / 季度）；人工覆盖与实时源为 null */
  cadence?: 'monthly' | 'quarterly' | null;
  /** 原始报价的环比变化（%）。**来自数据源本身**，比前端自算更准（首次加载不会恒为 0） */
  changePct?: number | null;
  /** 原始报价（未折算），如「美分/公斤」「欧元/公斤」——留档便于核对 */
  nativePrice?: number | null;
  nativeUnit?: string | null;
  /** 失败原因（不对外当数据用，用于诊断） */
  error?: string;
}

export interface SystemConfigLike {
  get(key: string, opts?: { scope?: string }): Promise<{ value: unknown; row: unknown } | null>;
}

const SINA_URL = 'https://hq.sinajs.cn/list=nf_CF0,hf_CT';
const SINA_REFERER = 'https://finance.sina.com.cn';
const DEFAULT_TIMEOUT_MS = 8000;

/** 合理区间守卫：抓到的值必须落在这个范围，否则视为解析错误（不返回） */
const COTTON_CN_RANGE = [8000, 40000] as const; // 元/吨
const COTTON_US_RANGE = [30, 300] as const; // 美分/磅

function withinRange(v: number, [lo, hi]: readonly [number, number]): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

/** 从 `var hq_str_xxx="a,b,c";` 里取出逗号分段 */
export function parseSinaPayload(raw: string, varName: string): string[] | null {
  const m = new RegExp(`var\\s+hq_str_${varName}\\s*=\\s*"([^"]*)"`).exec(raw);
  if (!m) return null;
  return m[1].split(',');
}

/**
 * 解析郑棉连续 `nf_CF0`。
 * 实测字段（2026-09-19 抓样）：
 *   [0]名称 [1]时间HHMMSS [2]开盘 [3]最高 [4]最低 [5]- [6]买价 [7]卖价
 *   [8]**最新价** [9]结算 [10]昨结算 [11]买量 [12]卖量 [13]持仓 [14]成交量
 *   ... [15]交易所 [16]品种 [17]**日期 YYYY-MM-DD**
 */
export function parseZhengCotton(raw: string): { price: number; asOf: string | null } | null {
  const p = parseSinaPayload(raw, 'nf_CF0');
  if (!p) return null;
  const price = Number(p[8]);
  if (!withinRange(price, COTTON_CN_RANGE)) return null;
  // ★ 交叉校验：最新价必须落在当日 [最低, 最高] 区间内。
  //   为什么需要：字段位置只能靠实测对照确认，而 [7]卖价 与 [8]最新价 在样本里**同值**
  //   ⇒ 单点断言分不出错位。这条能挡住"抓成持仓量/成交量"这类灾难性错位（那些值远在区间外）。
  const high = Number(p[3]);
  const low = Number(p[4]);
  if (withinRange(high, COTTON_CN_RANGE) && withinRange(low, COTTON_CN_RANGE)) {
    if (price > high || price < low) return null;
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(p[17] || '') ? p[17] : null;
  return { price, asOf: d };
}

/**
 * 解析美棉 `hf_CT`。实测字段：
 *   [0]**最新价(美分/磅)** [1]- [2]买价 [3]卖价 [4]最高 [5]最低 [6]时间
 *   [7]昨收 [8]开盘 ... [12]**日期**
 */
export function parseUsCotton(raw: string): { price: number; asOf: string | null } | null {
  const p = parseSinaPayload(raw, 'hf_CT');
  if (!p) return null;
  const price = Number(p[0]);
  if (!withinRange(price, COTTON_US_RANGE)) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(p[12] || '') ? p[12] : null;
  return { price, asOf: d };
}

/**
 * 读一条羊毛/亚麻报价（配置里没有 ⇒ price=null 的 unavailable）。
 * ★ 自动同步写入的值带 `auto: true` ⇒ freshness='auto'（前端显示「月度/季度」角标）；
 *   人工应急覆盖 ⇒ freshness='manual'。两者共用同一份区间校验。
 */
async function readStoredQuote(
  svc: SystemConfigLike | null,
  key: ManualQuoteKey,
  label: string,
  fallbackSource: string,
  error?: string,
  unit = 'CNY/ton',
): Promise<MarketQuote> {
  const base: MarketQuote = {
    key,
    label,
    price: null,
    currency: 'CNY',
    unit,
    asOf: null,
    freshness: 'unavailable',
    source: fallbackSource,
    isReal: false,
  };
  if (!svc) return { ...base, error: error ?? 'config-service-unavailable' };
  try {
    const row = await svc.get(manualQuoteConfigKey(key));
    const v = row?.value as {
      price?: unknown; asOf?: unknown; note?: unknown;
      auto?: unknown; cadence?: unknown; nativePrice?: unknown; nativeUnit?: unknown; nativeChangePct?: unknown;
    } | undefined;
    const price = Number(v?.price);
    if (!Number.isFinite(price) || price <= 0) {
      return { ...base, error: error ?? 'no-quote-configured' };
    }
    // 越界值也走 unavailable：宁可显示「暂无数据」，也不能把一个数量级错误的数字当行情亮出来
    const [lo, hi] = MANUAL_QUOTE_RANGES[key];
    if (price < lo || price > hi) {
      return { ...base, error: `quote-out-of-range(${lo}~${hi})` };
    }
    const asOf = typeof v?.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.asOf) ? v.asOf : null;
    const isAuto = v?.auto === true;
    const cadence = v?.cadence === 'monthly' || v?.cadence === 'quarterly' ? v.cadence : null;
    // ⚠️ 显式判 null/undefined：`Number(null) === 0` 且 isFinite ⇒ 会把「无环比」显示成 0%
    const nativePrice = v?.nativePrice != null ? Number(v.nativePrice) : NaN;
    const changePct = v?.nativeChangePct != null ? Number(v.nativeChangePct) : NaN;
    return {
      ...base,
      price,
      asOf,
      // 自动同步 ⇒ 'auto'（前端显示「月度/季度」角标）；人工应急覆盖 ⇒ 'manual'
      freshness: isAuto ? 'auto' : 'manual',
      source: typeof v?.note === 'string' && v.note ? v.note : fallbackSource,
      isReal: isAuto,
      cadence,
      changePct: Number.isFinite(changePct) ? changePct : null,
      nativePrice: Number.isFinite(nativePrice) ? nativePrice : null,
      nativeUnit: typeof v?.nativeUnit === 'string' ? v.nativeUnit : null,
    };
  } catch (e: any) {
    return { ...base, error: `config-read-failed: ${String(e?.message || e)}` };
  }
}

/**
 * 取棉花报价（真实时）。失败 ⇒ price=null（**不回落硬编码**）。
 * `fetchImpl` 可注入，便于单测与守卫。
 */
export async function fetchCottonQuotes(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ cn: MarketQuote; us: MarketQuote }> {
  const cnBase: MarketQuote = {
    key: 'cotton',
    label: 'COTTON (CN)',
    price: null,
    currency: 'CNY',
    unit: 'CNY/ton',
    asOf: null,
    freshness: 'unavailable',
    source: '新浪财经 · 郑棉连续 nf_CF0',
    isReal: false,
  };
  const usBase: MarketQuote = {
    ...cnBase,
    label: 'COTTON (US)',
    currency: 'USD',
    unit: 'USC/lb',
    source: '新浪财经 · ICE 美棉 hf_CT',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let raw = '';
  try {
    const res = await fetchImpl(SINA_URL, {
      headers: { Referer: SINA_REFERER },
      signal: controller.signal,
    } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
  } catch (e: any) {
    const error = `sina-fetch-failed: ${String(e?.message || e)}`;
    return { cn: { ...cnBase, error }, us: { ...usBase, error } };
  } finally {
    clearTimeout(timer);
  }

  const cn = parseZhengCotton(raw);
  const us = parseUsCotton(raw);
  return {
    cn: cn
      ? { ...cnBase, price: cn.price, asOf: cn.asOf, freshness: 'realtime', isReal: true }
      : { ...cnBase, error: 'nanjie-parse-failed-or-out-of-range' },
    us: us
      ? { ...usBase, price: us.price, asOf: us.asOf, freshness: 'realtime', isReal: true }
      : { ...usBase, error: 'meimian-parse-failed-or-out-of-range' },
  };
}

/** 取全部大宗商品报价（棉花实时 + 羊毛/亚麻自动同步，配置缺失时降级为无数据） */
export async function fetchCommodityQuotes(
  config: SystemConfigLike | null,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketQuote[]> {
  const [cotton, wool, linen] = await Promise.all([
    fetchCottonQuotes(fetchImpl),
    readStoredQuote(config, 'wool', 'WOOL (CN)', 'IMF 全球羊毛价格（月度，自动同步）'),
    readStoredQuote(config, 'linen', 'LINEN (CN)', '欧洲亚麻联盟长纤均价（季度，自动同步）'),
  ]);
  return [cotton.cn, cotton.us, wool, linen];
}

export const __internal = { parseZhengCotton, parseUsCotton, withinRange, COTTON_CN_RANGE, COTTON_US_RANGE };
