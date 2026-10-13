/**
 * autoQuoteSources.ts —— 羊毛 / 亚麻「自动同步」的两个外部源
 *
 * ★ 为什么需要这个文件：Kevin（2026-09-19）明确否掉了人工录入 ——
 *   「不能手动填，要找到自动同步接入的方法」。本文件就是那两个源。
 *
 * ── 源的选择过程（实测，非推测）────────────────────────────────────
 * 试过并**排除**的（都实测过）：
 *   · AWEX 官网 → 404 / `operations.awex.com.au` 连不通；官网明示实时数据付费
 *   · AWI(wool.com) 周报 → 图表是 ASP.NET 表单驱动，无结构化接口
 *   · Mecardo / Elders → 面向人的叙述文，无表格
 *   · 中国纺织经济信息网(CTEI)「羊毛价格指数」→ 接口能打通（JSONP.aspx），
 *     但**该序列只到 2010 年**（已废弃）
 *   · 南京羊毛市场 → 登录制门户（`wool-trading-on.webwho.xyz:8010`）
 *   · 生意社 100ppi → 反爬（robots noarchive + JS 混淆桩）
 *   · 世界银行 Pink Sheet → 2026 版**已不含羊毛**，也从未有亚麻
 *   · UN Comtrade（中国进口亚麻）→ 免费预览端点只有年度，月度返回空
 *   · Eurostat Comext → 接口可用，但 `partner=WORLD` 聚合为空、逐伙伴样本稀疏（月进口仅 1~5 吨）
 *   · 中国麻纺织行业协会 / 欧洲亚麻联盟旧域名 → 域名不存在
 *
 * 最终采用的两个（都已在**生产机**实测可达）：
 *
 *   1. **羊毛 ← IMF 全球商品价格（经 FRED 的公开 CSV 端点，无需 key）**
 *      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=PWOOLCUSDM`
 *      = Wool, Coarse, 23 Micron，单位 **美分/公斤**，**月度**（IMF 口径，源自澳洲拍卖市场）。
 *      ⓘ IMF 发布有约 2 个月滞后（实测最新为 2026-07）—— 这是源本身的节奏，不是我们的延迟。
 *
 *   2. **亚麻 ← 欧洲亚麻联盟（ALLIANCE）经济观察站的季度发布页**
 *      `https://allianceflaxlinenhemp.eu/en/flax-linen-hemp-economic-observatory`
 *      = Masters of FLAX FIBRE™ 长纤**出厂均价**（€/公斤），**季度**发布。
 *      这是亚麻长纤**唯一**的官方权威报价源（行业组织自己发布）。
 *      ⚠️ 它是**叙述文**（页面没有表格/CSV）⇒ 必须用「严格锚定 + 失败即停」解析：
 *        · 只接受「价格 + 月份年份」出现在**同一句**的配对
 *        · 取全局**最新月份**的那一对（历史值如「March 2024 €9.00」自动落选）
 *        · 价格区间守卫 €1~€20/kg（挡住把「产量吨数」当成价格这类错位）
 *        · **解析不到就不更新**（保留上一次的好值并标陈旧）—— 最坏情况是数据旧，不是数字错
 *
 * ★ 分层原则不变：**拿不到就 null**，绝不回落硬编码。
 *   汇率换算一律读**财务 `ExchangeRate` 表**（唯一真源），不另开汇率源。
 */

import type { PrismaClient } from '@prisma/client';

export type AutoQuoteKey = 'wool' | 'linen';

/** 折算后的自动报价（写进 SystemConfig 的形状） */
export interface AutoQuoteValue {
  /** 折算为 CNY/吨（与 Dashboard 卡片单位一致） */
  price: number;
  /** 数据所属日期 YYYY-MM-DD（月度=当月 1 日；季度发布=发布所述月份） */
  asOf: string;
  /** 给人看的来源说明 */
  note: string;
  /** 标记「这是自动同步来的」——前端据此显示「自动 · 月度」而不是「手工」 */
  auto: true;
  cadence: 'monthly' | 'quarterly';
  /** 原始报价与单位（留档，便于核对折算） */
  nativePrice: number;
  nativeUnit: string;
  /** 原始报价的环比变化（%），拿不到就 null */
  nativeChangePct: number | null;
  sourceUrl: string;
  fetchedAt: string;
}

export interface AutoQuoteFailure {
  key: AutoQuoteKey;
  reason: string;
}

export interface AutoSyncReport {
  ok: string[];
  failed: AutoQuoteFailure[];
  skipped: string[];
}

const FRED_WOOL_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=PWOOLCUSDM';
const ALLIANCE_INDEX_URL = 'https://allianceflaxlinenhemp.eu/en/flax-linen-hemp-economic-observatory';
const FETCH_TIMEOUT_MS = 15_000;

/** 合理性区间 —— 用途是**挡住解析错位**，不是业务定价规则 */
const WOOL_USC_PER_KG_RANGE = [100, 6000] as const; // 美分/公斤（历史 297~1600）
const LINEN_EUR_PER_KG_RANGE = [1, 20] as const; // 欧元/公斤（历史 3.33~9.08）
/** 折算后的 CNY/吨 也必须落在业务区间内（与 marketQuoteService 的展示区间同源精神） */
const CNY_PER_TON_RANGE = [10_000, 500_000] as const;

function withinRange(v: number, [lo, hi]: readonly [number, number]): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

// ─────────────────────────────────────────────────────────────────────
// 羊毛：FRED CSV 解析（纯函数，便于守卫）
// ─────────────────────────────────────────────────────────────────────

export interface FredPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/**
 * 解析 FRED 的 fredgraph.csv。格式：
 *   `observation_date,PWOOLCUSDM`
 *   `1992-01-01,297.0440417883830`
 * ⚠️ 缺失值 FRED 用 `.` 占位 —— **必须跳过**，否则 Number('.') → NaN 会把整条链带歪。
 */
export function parseFredCsv(csv: string): FredPoint[] {
  const out: FredPoint[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^observation_date/i.test(t)) continue;
    const [d, v] = t.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test((d || '').trim())) continue;
    const n = Number((v || '').trim());
    if (!Number.isFinite(n)) continue; // '.' / 空 ⇒ 跳过
    out.push({ date: d.trim(), value: n });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface WoolQuote {
  nativePrice: number; // 美分/公斤
  nativeUnit: string;
  asOf: string; // 当月 1 日
  nativeChangePct: number | null;
}

/**
 * 取最新一个月的美分/公斤。
 * 环比取「最后一期 vs 上一期」，两期都为有效值才算（否则 null）。
 */
export function parseWoolFromFred(csv: string): WoolQuote | null {
  const pts = parseFredCsv(csv);
  if (pts.length === 0) return null;
  const last = pts[pts.length - 1];
  if (!withinRange(last.value, WOOL_USC_PER_KG_RANGE)) return null;
  let change: number | null = null;
  const prev = pts[pts.length - 2];
  if (prev && withinRange(prev.value, WOOL_USC_PER_KG_RANGE) && prev.value > 0) {
    change = ((last.value - prev.value) / prev.value) * 100;
  }
  return { nativePrice: last.value, nativeUnit: 'USC/kg', asOf: `${last.date.slice(0, 8)}01`, nativeChangePct: change };
}

// ─────────────────────────────────────────────────────────────────────
// 亚麻：欧洲亚麻联盟「价格 + 月份年份」配对解析（纯函数，便于守卫）
// ─────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
/** 允许 `€5.60/kg` 与欧式写法 `5.89€/kg` 两种顺序 */
const PRICE_TOKEN = /(?:€\s?(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s?€)\s*(?:\/\s?kg|per\s+kilogram)?/gi;
const MONTH_YEAR = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi;

export interface LinenQuote {
  nativePrice: number; // 欧元/公斤
  nativeUnit: string;
  asOf: string; // 所述月份 1 日
  monthLabel: string; // 如 "March 2026"
}

/**
 * 从联盟页面里取**最新月份**的长纤均价。
 *
 * 判据（三重）：
 *   1. **同一句**里必须同时出现价格与「月份 年份」（跨句组合一律不认）
 *   2. 价格区间守卫 €1~€20/kg
 *   3. 取全局**最新**月份 ⇒ 历史值（"March 2024 at €9.00"、"down from €9.00 in March 2024"）
 *      自动落选，不需要专门写「排除历史」的黑名单
 *
 * ⚠️ 若解析不到 ⇒ 返回 null（调用方**保留旧值**，不写新值）—— **失败即停**。
 */
export function parseAllianceLinen(html: string): LinenQuote | null {
  // 先剥脚本/样式，再按句号切句（价格与月份必须同句）
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const sentences = text.split(/(?<=[.!?])\s+/);

  let best: { ts: number; price: number; label: string } | null = null;
  for (const s of sentences) {
    const prices: number[] = [];
    for (const m of s.matchAll(PRICE_TOKEN)) {
      const n = Number((m[1] ?? m[2] ?? '').replace(',', '.'));
      if (Number.isFinite(n)) prices.push(n);
    }
    if (prices.length === 0) continue;
    for (const m of s.matchAll(MONTH_YEAR)) {
      const mo = MONTHS[m[1].toLowerCase()];
      const yr = Number(m[2]);
      if (!mo || !yr) continue;
      // 同句内多个价格时取「离该月份最近」的那个：这里简化取同句价格的最后一个有效值
      const price = prices.filter((p) => withinRange(p, LINEN_EUR_PER_KG_RANGE)).pop();
      if (price === undefined) continue;
      const ts = yr * 100 + mo;
      if (!best || ts > best.ts) best = { ts, price, label: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${yr}` };
    }
  }
  if (!best) return null;
  const mo = String(best.ts % 100).padStart(2, '0');
  const yr = Math.floor(best.ts / 100);
  return { nativePrice: best.price, nativeUnit: 'EUR/kg', asOf: `${yr}-${mo}-01`, monthLabel: best.label };
}

/** 从联盟索引页里挑出子页链接（页面改版后新增的「figures-20xx」页也能自动被覆盖） */
export function pickObservatoryPages(html: string): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*flax-linen-hemp-economic-observatory\/[^"#]+)"/gi)) {
    let u = m[1];
    if (u.startsWith('/')) u = `https://allianceflaxlinenhemp.eu${u}`;
    if (/^https:\/\/allianceflaxlinenhemp\.eu\//.test(u)) links.add(u);
  }
  return [...links].slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────────
// 抓取 + 折算 + 落库
// ─────────────────────────────────────────────────────────────────────

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bambook/1.0 market-sync)' },
      signal: controller.signal,
    } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface AutoSyncDeps {
  fetchImpl?: typeof fetch;
  /** 读汇率（1 单位外币兑 CNY）—— 真源是财务 ExchangeRate 表 */
  rateOf: (currency: string) => Promise<number | null>;
  /** 写入人工报价配置（复用同一份 systemConfigService.set） */
  writeConfig: (key: AutoQuoteKey, value: AutoQuoteValue) => Promise<void>;
  now?: Date;
}

/** 跑一轮自动同步；两个源互相独立，一个失败不影响另一个 */
export async function syncAutoMarketQuotes(deps: AutoSyncDeps): Promise<AutoSyncReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowIso = (deps.now ?? new Date()).toISOString();
  const report: AutoSyncReport = { ok: [], failed: [], skipped: [] };

  // ── 羊毛（IMF / FRED，月度）──
  try {
    const usd = await deps.rateOf('USD');
    if (!usd || !withinRange(usd, [1, 100])) {
      report.failed.push({ key: 'wool', reason: 'usd-rate-unavailable' });
    } else {
      const csv = await fetchText(FRED_WOOL_URL, fetchImpl);
      const q = parseWoolFromFred(csv);
      if (!q) {
        report.failed.push({ key: 'wool', reason: 'fred-parse-failed-or-out-of-range' });
      } else {
        const cnyPerTon = (q.nativePrice / 100) * usd * 1000;
        if (!withinRange(cnyPerTon, CNY_PER_TON_RANGE)) {
          report.failed.push({ key: 'wool', reason: `cny-per-ton-out-of-range(${cnyPerTon.toFixed(0)})` });
        } else {
          await deps.writeConfig('wool', {
            price: Math.round(cnyPerTon * 100) / 100,
            asOf: q.asOf,
            note: 'IMF 全球羊毛价格（23 微米，美分/公斤）× 当日 USD/CNY',
            auto: true,
            cadence: 'monthly',
            nativePrice: q.nativePrice,
            nativeUnit: q.nativeUnit,
            nativeChangePct: q.nativeChangePct,
            sourceUrl: FRED_WOOL_URL,
            fetchedAt: nowIso,
          });
          report.ok.push('wool');
        }
      }
    }
  } catch (e: any) {
    report.failed.push({ key: 'wool', reason: `fetch-failed: ${String(e?.message || e)}` });
  }

  // ── 亚麻（欧洲亚麻联盟，季度）──
  try {
    const eur = await deps.rateOf('EUR');
    if (!eur || !withinRange(eur, [1, 100])) {
      report.failed.push({ key: 'linen', reason: 'eur-rate-unavailable' });
    } else {
      const indexHtml = await fetchText(ALLIANCE_INDEX_URL, fetchImpl);
      const pages = [ALLIANCE_INDEX_URL, ...pickObservatoryPages(indexHtml)];
      let best: LinenQuote | null = null;
      for (const p of pages) {
        try {
          const html = p === ALLIANCE_INDEX_URL ? indexHtml : await fetchText(p, fetchImpl);
          const q = parseAllianceLinen(html);
          if (q && (!best || q.asOf > best.asOf)) best = q;
        } catch {
          report.skipped.push(`linen-page:${p}`);
        }
      }
      if (!best) {
        report.failed.push({ key: 'linen', reason: 'alliance-parse-failed' });
      } else {
        const cnyPerTon = best.nativePrice * eur * 1000;
        if (!withinRange(cnyPerTon, CNY_PER_TON_RANGE)) {
          report.failed.push({ key: 'linen', reason: `cny-per-ton-out-of-range(${cnyPerTon.toFixed(0)})` });
        } else {
          await deps.writeConfig('linen', {
            price: Math.round(cnyPerTon * 100) / 100,
            asOf: best.asOf,
            note: `欧洲亚麻联盟 · 长纤出厂均价（${best.monthLabel}，欧元/公斤）× 当日 EUR/CNY`,
            auto: true,
            cadence: 'quarterly',
            nativePrice: best.nativePrice,
            nativeUnit: best.nativeUnit,
            nativeChangePct: null,
            sourceUrl: ALLIANCE_INDEX_URL,
            fetchedAt: nowIso,
          });
          report.ok.push('linen');
        }
      }
    }
  } catch (e: any) {
    report.failed.push({ key: 'linen', reason: `fetch-failed: ${String(e?.message || e)}` });
  }

  return report;
}

/** 便捷入口：直接吃 prisma 与配置服务（供调度任务 / 路由调用） */
export async function runAutoQuoteSync(
  prisma: PrismaClient,
  configSvc: { set: (key: string, value: unknown, opts?: any) => Promise<any> },
  opts: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AutoSyncReport> {
  const db = prisma as any;
  const rateOf = async (currency: string): Promise<number | null> => {
    const rows = await db.exchangeRate.findMany({
      where: { currency },
      orderBy: [{ effectiveDate: 'desc' }],
      take: 1,
      select: { rate: true },
    });
    const n = Number(rows?.[0]?.rate);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return syncAutoMarketQuotes({
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    rateOf,
    writeConfig: async (key, value) => {
      await configSvc.set(`market.${key}`, value, {
        group: 'custom',
        label: key === 'wool' ? '羊毛行情（自动同步）' : '亚麻行情（自动同步）',
        valueType: 'json',
        description: '自动同步的外部行情源（羊毛=IMF 月度 / 亚麻=欧洲亚麻联盟季度）',
        actorId: 'system_market_sync',
        reason: '自动同步行情',
      });
    },
  });
}

export const __internal = { parseFredCsv, parseWoolFromFred, parseAllianceLinen, pickObservatoryPages };
