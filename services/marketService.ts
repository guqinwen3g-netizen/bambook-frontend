import { getApiBaseUrl } from './apiBase';

/**
 * Market Data Service —— Dashboard 行情卡的取数层
 *
 * ★ 数据诚实原则（2026-09-19 整改，Kevin：「全部要修复成真正实时的」）：
 *   1. **汇率**：来自后端**唯一真源** `ExchangeRate` 表（= 财务/单据换算用的那张表，
 *      `fxRateSync` 每日 08:30 同步）。ⓘ 它是**每日定盘**、不是逐笔实时 ⇒
 *      **非当日的数据必须把日期标出来**（`stale` 标记）。
 *      此前本文件还兜底直连 exchangerate-api.com —— 那是**第二个源**（实测同日
 *      USD 6.72 vs 表里 6.721785），已删除：宁可显示暂无，也不要两个口径并存。
 *   2. **棉花**：真实时（后端新浪财经郑棉 `nf_CF0` / 美棉 `hf_CT`）。
 *   3. **羊毛 / 亚麻**：**由外部源自动同步**（Kevin 2026-09-19 否掉人工录入）——
 *      · 羊毛 = **IMF 全球羊毛价格（23 微米，美分/公斤）**，经 FRED 公开 CSV，**月度**
 *      · 亚麻 = **欧洲亚麻联盟「Masters of FLAX FIBRE」长纤出厂均价（€/公斤）**，**季度**
 *      详见 `server/src/market/autoQuoteSources.ts`；调度任务 `market_quote_sync` 每日 09:10 跑。
 *      ⚠️ 两个源都**不是实时**（市场本身就没有实时价）⇒ 角标必须显示数据所属月份。
 *   4. ★ **拿不到就是 `null`**：`price === null` 时 UI 必须显示「暂无数据」，
 *      **不得回落到硬编码数字**（此前 `BASE_RATES` 里写死的 15839/97500/87500
 *      会让业务员把写死的常量当成行情 —— 这是本次整改要消灭的东西）。
 */

export interface Ticker {
    symbol: string;
    /** null = 暂无数据（不编造） */
    price: number | null;
    change: number;
    prefix: string;
    /** 是否来自真实外部行情源（实时=true；人工录入=false） */
    isReal: boolean;
    /** 数据所属日期 YYYY-MM-DD */
    asOf?: string | null;
    /**
     * 新鲜度：
     *   realtime（逐笔实时）| daily（汇率每日定盘）| auto（外部源自动同步，月度/季度发布）
     *   | manual（人工应急覆盖）| unavailable（无数据）
     */
    freshness?: 'realtime' | 'daily' | 'auto' | 'manual' | 'unavailable';
    /** 数据已过期（如汇率不是当日的）⇒ 界面必须把日期标出来，不能装作新鲜 */
    stale?: boolean;
    /** 自动同步源的发布节奏（角标文案用） */
    cadence?: 'monthly' | 'quarterly' | null;
}

const REFRESH_DEBOUNCE_MS = 30_000;
const BACKEND_API = getApiBaseUrl();

/** 初始骨架：只有 symbol 与展示前缀，**不带任何价格**（价格必须来自真源） */
const TICKER_SKELETON: Array<Pick<Ticker, 'symbol' | 'prefix'>> = [
    { symbol: 'USD/CNY', prefix: '¥' },
    { symbol: 'EUR/CNY', prefix: '¥' },
    { symbol: 'GBP/CNY', prefix: '¥' },
    { symbol: 'COTTON (CN)', prefix: '¥' },
    { symbol: 'WOOL (CN)', prefix: '¥' },
    { symbol: 'LINEN (CN)', prefix: '¥' },
];

class MarketService {
    private tickers: Ticker[] = TICKER_SKELETON.map(t => ({
        ...t,
        price: null,
        change: 0,
        isReal: false,
        asOf: null,
        freshness: 'unavailable' as const,
    }));

    private isInitialized = false;
    private lastMarketUpdate = 0;
    private marketCache: any = null;
    /** 上一次真实价（仅用于算涨跌 %，不是兜底数据） */
    private lastPrice = new Map<string, number>();

    async init() {
        if (this.isInitialized) return;
        this.isInitialized = true;
        await this.refreshCommodities();
    }

    private setQuote(symbol: string, price: number | null, opts: {
        isReal: boolean;
        asOf?: string | null;
        freshness?: Ticker['freshness'];
        stale?: boolean;
        cadence?: 'monthly' | 'quarterly' | null;
        /** 数据源自带的环比（%）。给了就用它 —— 首次加载时前端拿不到上一期，自算会恒为 0 */
        changePct?: number | null;
    }) {
        const target = this.tickers.find(t => t.symbol === symbol);
        if (!target) return;
        if (price === null || !Number.isFinite(price)) {
            target.price = null;
            target.change = 0;
            target.isReal = false;
            target.asOf = opts.asOf ?? null;
            target.freshness = opts.freshness ?? 'unavailable';
            target.stale = false;
            target.cadence = null;
            return;
        }
        const prev = this.lastPrice.get(symbol);
        target.change = typeof opts.changePct === 'number' && Number.isFinite(opts.changePct)
            ? opts.changePct
            : (prev && prev > 0 ? ((price - prev) / prev) * 100 : 0);
        target.price = price;
        target.isReal = opts.isReal;
        target.asOf = opts.asOf ?? null;
        target.freshness = opts.freshness ?? (opts.isReal ? 'realtime' : 'manual');
        target.stale = opts.stale ?? false;
        target.cadence = opts.cadence ?? null;
        this.lastPrice.set(symbol, price);
    }

    /** 从后端单一真源拉取（汇率 + 大宗商品一次取回） */
    async refreshCommodities() {
        const now = Date.now();
        if (now - this.lastMarketUpdate < REFRESH_DEBOUNCE_MS && this.marketCache) {
            return this.tickers;
        }

        try {
            const res = await fetch(`${BACKEND_API}/market/all`);
            if (res.ok) {
                const data = await res.json();
                this.marketCache = data;
                this.lastMarketUpdate = now;

                if (data.status === 'success') {
                    // ── 汇率（后端唯一真源 = 财务 ExchangeRate 表；每日定盘）──
                    //    取不到就是 null ⇒ 显示「暂无数据」；表里没有说明同步没跑，那是要被看见的问题。
                    const fx = data.forex || {};
                    const fxAsOf: string | null = typeof fx.asOf === 'string' ? fx.asOf : null;
                    const fxStale: boolean = fx.isStale === true;
                    for (const [currency, symbol] of [['USD', 'USD/CNY'], ['EUR', 'EUR/CNY'], ['GBP', 'GBP/CNY']] as const) {
                        const raw = fx[`${currency}_CNY`];
                        const rate = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
                        this.setQuote(symbol, rate, {
                            isReal: rate !== null,
                            asOf: fxAsOf,
                            freshness: rate === null ? 'unavailable' : 'daily',
                            stale: fxStale,
                        });
                    }

                    // ── 大宗商品（棉花实时；羊毛/亚麻外部源自动同步；拿不到 = null）──
                    const map: Array<[string, string]> = [
                        ['cotton', 'COTTON (CN)'],
                        ['wool', 'WOOL (CN)'],
                        ['linen', 'LINEN (CN)'],
                    ];
                    for (const [key, symbol] of map) {
                        const q = data.commodities?.[key];
                        const price = typeof q?.price === 'number' ? q.price : null;
                        this.setQuote(symbol, price, {
                            isReal: !!q?.freshness && q.freshness !== 'unavailable',
                            asOf: typeof q?.asOf === 'string' ? q.asOf : null,
                            freshness: price === null ? 'unavailable' : (q?.freshness || 'auto'),
                            cadence: q?.cadence === 'monthly' || q?.cadence === 'quarterly' ? q.cadence : null,
                            changePct: typeof q?.changePct === 'number' ? q.changePct : null,
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('Backend market API failed:', e);
        }

        // ★ 刻意**不再**做「后端不可达就本机直连外部汇率 API」的兜底：
        //   那个兜底是汇率历史上的第二个源（实测同日 USD 6.72 vs 财务表 6.721785）。
        //   现在汇率只有 `ExchangeRate` 表一个真源 —— 后端不可达时整站本来也打不开，
        //   在前端偷偷换一个口径反而会让「跨页数字不一致」重新长回来。

        return this.tickers;
    }

    /** 展示值即最近一次真源刷新的值，不叠加随机抖动 */
    getTickers(): Ticker[] {
        return this.tickers;
    }

    /**
     * 跳过防抖立即重取（录入羊毛/亚麻后调用）——
     * 否则用户存完要等防抖窗口过去才看到新值，会以为「没保存上」。
     */
    async forceRefresh(): Promise<Ticker[]> {
        this.lastMarketUpdate = 0;
        return this.refreshCommodities();
    }

    /** 数据源说明（给人看） */
    getDataSource() {
        return {
            forex: 'Daily (财务 ExchangeRate 表 · fxRateSync 每日同步)',
            cotton: 'Real-time (新浪财经 · 郑棉 nf_CF0)',
            wool: 'Auto · Monthly (IMF 全球羊毛价格 23 微米，经 FRED 同步)',
            linen: 'Auto · Quarterly (欧洲亚麻联盟 · Masters of FLAX FIBRE 长纤均价)',
        };
    }

    /** USD/CNY 汇率（供业务工具使用）；无数据时返回 null，调用方需自行处理 */
    getUsdCnyRate(): number | null {
        const usdCny = this.tickers.find(t => t.symbol === 'USD/CNY');
        return usdCny?.price ?? null;
    }
}

export const marketService = new MarketService();
