/**
 * marketQuoteService 守卫（2026-09-19 行情整改）
 *
 * 夹具是**生产实测抓样**（2026-09-19 00:5x 从 hq.sinajs.cn 抓的真实响应，GBK 已转 UTF-8）。
 * 判据：解析必须准（字段位置错一位 ⇒ 业务员看到错价），越界必须拒（宁可无数据不给错数据）。
 * ⚠️ 每条断言都要能踩红 —— 改完请把期望值反过来跑一次确认会失败。
 */
import { describe, it, expect } from 'vitest';
import {
  parseSinaPayload,
  parseZhengCotton,
  parseUsCotton,
  fetchCommodityQuotes,
} from '../marketQuoteService';

/** 真实抓样（郑棉连续 + 美棉），字段顺序即生产实际 */
const SAMPLE = [
  'var hq_str_nf_CF0="棉花连续,225959,15705.000,15785.000,15705.000,0.000,15735.000,15745.000,15745.000,0.000,15795.000,78,134,558550.000,95791,郑,棉花,2026-09-18,1,,,,,,,,,15745.000,0.000,0,0.000,0,0.000,0";',
  'var hq_str_hf_CT="81.041,,81.060,81.080,82.520,80.710,00:40:16,82.170,82.250,0,5,5,2026-09-19,美国棉花,26701";',
].join('\n');

describe('parseSinaPayload', () => {
  it('阳性对照：能从真实响应里取出逗号分段', () => {
    const p = parseSinaPayload(SAMPLE, 'nf_CF0');
    expect(p).not.toBeNull();
    expect(p!.length).toBeGreaterThan(20);
    expect(p![0]).toBe('棉花连续');
  });

  it('变量不存在 ⇒ null（不猜、不返回空数组）', () => {
    expect(parseSinaPayload(SAMPLE, 'nf_XX0')).toBeNull();
  });
});

describe('parseZhengCotton — 郑棉 nf_CF0', () => {
  it('阳性对照：取字段[8]为最新价、[17]为交易日', () => {
    const r = parseZhengCotton(SAMPLE);
    expect(r).toEqual({ price: 15745, asOf: '2026-09-18' });
  });

  it('★ 价格超出合理区间 ⇒ null（字段错位时不返回垃圾值）', () => {
    const bad = SAMPLE.replace('15735.000,15745.000,15745.000', '15735.000,15745.000,9999999.000');
    expect(parseZhengCotton(bad)).toBeNull();
  });

  it('空响应 / 结构缺失 ⇒ null', () => {
    expect(parseZhengCotton('')).toBeNull();
    expect(parseZhengCotton('var hq_str_nf_CF0="";')).toBeNull();
  });

  it('★ 交叉校验：最新价落在 [最低, 最高] 之外 ⇒ null（防字段错位抓成别的数）', () => {
    // 把最新价改成高于当日最高价（模拟"读错了字段"）
    const bad = SAMPLE.replace('15735.000,15745.000,15745.000', '15735.000,15745.000,19999.000');
    expect(parseZhengCotton(bad)).toBeNull();
  });
});

describe('parseUsCotton — 美棉 hf_CT', () => {
  it('阳性对照：取字段[0]为最新价、[12]为交易日', () => {
    const r = parseUsCotton(SAMPLE);
    expect(r).toEqual({ price: 81.041, asOf: '2026-09-19' });
  });

  it('★ 价格超出合理区间（美分/磅 30~300）⇒ null', () => {
    const bad = SAMPLE.replace('var hq_str_hf_CT="81.041,', 'var hq_str_hf_CT="9999,');
    expect(parseUsCotton(bad)).toBeNull();
  });
});

describe('fetchCommodityQuotes — 分层取数（拿不到就是 null，不回落到硬编码）', () => {
  const okFetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => SAMPLE,
  })) as unknown as typeof fetch;

  const failFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  it('★ 棉花实时成功 ⇒ freshness=realtime 且 isReal=true', async () => {
    const quotes = await fetchCommodityQuotes(null, okFetch);
    const cn = quotes.find(q => q.label === 'COTTON (CN)')!;
    expect(cn.price).toBe(15745);
    expect(cn.freshness).toBe('realtime');
    expect(cn.isReal).toBe(true);
    expect(cn.asOf).toBe('2026-09-18');
  });

  it('★★ 抓取失败 ⇒ price=null（**不得**回落成 15839 之类的硬编码）', async () => {
    const quotes = await fetchCommodityQuotes(null, failFetch);
    const cn = quotes.find(q => q.label === 'COTTON (CN)')!;
    expect(cn.price).toBeNull();
    expect(cn.freshness).toBe('unavailable');
    expect(cn.isReal).toBe(false);
    expect(cn.error).toContain('sina-fetch-failed');
  });

  it('★ 羊毛/亚麻无配置 ⇒ price=null，且**不得**出现 97500 / 87500 这类写死值', async () => {
    const quotes = await fetchCommodityQuotes(null, okFetch);
    const wool = quotes.find(q => q.key === 'wool')!;
    const linen = quotes.find(q => q.key === 'linen')!;
    expect(wool.price).toBeNull();
    expect(linen.price).toBeNull();
    for (const q of [wool, linen]) {
      expect([97500, 87500]).not.toContain(q.price);
    }
  });

  it('应急覆盖写入的值（无 auto 标记）⇒ 标为 manual + 带 asOf（真实但非自动）', async () => {
    const fakeConfig = {
      get: async (key: string) =>
        key === 'market.wool'
          ? { value: { price: 92000, asOf: '2026-09-17', note: '临时按谈定口径' }, row: {} }
          : { value: { price: 86000, asOf: '2026-09-10' }, row: {} },
    };
    const quotes = await fetchCommodityQuotes(fakeConfig as any, okFetch);
    const wool = quotes.find(q => q.key === 'wool')!;
    const linen = quotes.find(q => q.key === 'linen')!;
    expect(wool.price).toBe(92000);
    expect(wool.freshness).toBe('manual');
    expect(wool.asOf).toBe('2026-09-17');
    expect(linen.price).toBe(86000);
    expect(linen.freshness).toBe('manual');
  });

  it('★ 自动同步写入的值（auto=true）⇒ 标为 auto，并带出 cadence / 原始值 / 环比', async () => {
    const cfg = {
      get: async () => ({
        value: {
          price: 99635.63, asOf: '2026-07-01', note: 'IMF 全球羊毛价格（23 微米）',
          auto: true, cadence: 'monthly',
          nativePrice: 1483.99, nativeUnit: 'USC/kg', nativeChangePct: -4.3,
        },
        row: {},
      }),
    };
    const quotes = await fetchCommodityQuotes(cfg as any, okFetch);
    const wool = quotes.find(q => q.key === 'wool')!;
    expect(wool.freshness).toBe('auto');
    expect(wool.isReal).toBe(true);
    expect(wool.cadence).toBe('monthly');
    expect(wool.nativePrice).toBeCloseTo(1483.99, 2);
    expect(wool.nativeUnit).toBe('USC/kg');
    expect(wool.changePct).toBeCloseTo(-4.3, 3);
  });

  it('★ 环比为 null 时必须保持 null，不能变成 0%（`Number(null) === 0` 且 isFinite ⇒ 陷阱）', async () => {
    const cfg = {
      get: async () => ({
        value: {
          price: 45356.19, asOf: '2026-03-01', note: '欧洲亚麻联盟长纤均价',
          auto: true, cadence: 'quarterly',
          nativePrice: 5.89, nativeUnit: 'EUR/kg', nativeChangePct: null,
        },
        row: {},
      }),
    };
    const quotes = await fetchCommodityQuotes(cfg as any, okFetch);
    const linen = quotes.find(q => q.key === 'linen')!;
    expect(linen.freshness).toBe('auto');
    expect(linen.cadence).toBe('quarterly');
    expect(linen.changePct).toBeNull();
    expect(linen.changePct).not.toBe(0);
  });

  it('★ 自动值越界（同步解析错位）⇒ 读侧也要拒 ⇒ 显示「暂无数据」而不是错价', async () => {
    const cfg = {
      get: async () => ({
        value: { price: 9_750_000, asOf: '2026-07-01', auto: true, cadence: 'monthly' },
        row: {},
      }),
    };
    const quotes = await fetchCommodityQuotes(cfg as any, okFetch);
    const wool = quotes.find(q => q.key === 'wool')!;
    expect(wool.price).toBeNull();
    expect(wool.freshness).toBe('unavailable');
    expect(wool.error).toContain('quote-out-of-range');
  });
});
