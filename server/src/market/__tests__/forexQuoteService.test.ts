/**
 * forexQuoteService 守卫（2026-09-19 汇率收口）
 *
 * 背景：Dashboard 汇率原本直连 exchangerate-api.com，与财务侧 `ExchangeRate` 表
 * （fxRateSync 每日同步）是**两个源**，生产实测同日数值不同
 * （USD 6.72 vs 6.721785 / GBP 8.9840 vs 8.980369）⇒ 收口到财务表。
 *
 * 判据：
 *   1. 必须挑**每币种最新**的一条（挑错 = 页面显示过时汇率）
 *   2. 必须识别 `isStale`（当日没同步上要让界面把日期标出来，不能装作新鲜）
 *   3. 拿不到就 `rate=null`，**不得回落任何硬编码**
 *   4. 结构守卫：`/api/market/all` 不得再直连外部汇率 API（防止双源长回来）
 *
 * ⚠️ 每条断言都要能踩红 —— 改完请把期望值反过来跑一次确认会失败。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pickLatestPerCurrency,
  fetchForexQuotes,
  toForexPayload,
  FOREX_CURRENCIES,
} from '../forexQuoteService';

/** 真库形态的行（真实生产值：2026-09-18 各币种最新一条） */
const ROWS = [
  { currency: 'USD', rate: 6.721785, effectiveDate: '2026-09-18', source: 'api', createdAt: 2n },
  { currency: 'USD', rate: 6.718, effectiveDate: '2026-09-17', source: 'api', createdAt: 1n },
  { currency: 'EUR', rate: 7.711051, effectiveDate: '2026-09-18', source: 'api', createdAt: 2n },
  { currency: 'GBP', rate: 8.980369, effectiveDate: '2026-09-18', source: 'api', createdAt: 2n },
  { currency: 'HKD', rate: 0.856808, effectiveDate: '2026-09-18', source: 'api', createdAt: 2n },
];

describe('pickLatestPerCurrency', () => {
  it('阳性对照：挑出每个币种最新一条（USD 取 09-18 而非 09-17）', () => {
    const m = pickLatestPerCurrency(ROWS);
    expect(m.get('USD')!.rate).toBe(6.721785);
    expect(m.get('USD')!.asOf).toBe('2026-09-18');
    expect(m.get('EUR')!.rate).toBe(7.711051);
    expect(m.get('GBP')!.rate).toBe(8.980369);
  });

  it('不消费未展示的币种（HKD 不在 FOREX_CURRENCIES 里也不报错）', () => {
    const m = pickLatestPerCurrency(ROWS);
    expect([...m.keys()].sort()).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('乱序输入也必须取最新（不依赖查询返回顺序）', () => {
    const shuffled = [ROWS[1], ROWS[4], ROWS[0], ROWS[2], ROWS[3]];
    const m = pickLatestPerCurrency(shuffled);
    expect(m.get('USD')!.rate).toBe(6.721785); // 若按顺序取到 6.718 ⇒ 红
  });

  it('同一天多条 ⇒ 取 createdAt 更大的那条', () => {
    const m = pickLatestPerCurrency([
      { currency: 'USD', rate: 6.7, effectiveDate: '2026-09-18', createdAt: 100n },
      { currency: 'USD', rate: 6.8, effectiveDate: '2026-09-18', createdAt: 200n },
    ]);
    expect(m.get('USD')!.rate).toBe(6.8);
  });

  it('坏行（0 / 负数 / NaN / 空币种）跳过，不污染结果', () => {
    const m = pickLatestPerCurrency([
      { currency: 'USD', rate: 0, effectiveDate: '2026-09-18' },
      { currency: 'EUR', rate: -1, effectiveDate: '2026-09-18' },
      { currency: 'GBP', rate: 'abc', effectiveDate: '2026-09-18' },
      { currency: '', rate: 6.9, effectiveDate: '2026-09-18' },
    ]);
    expect(m.size).toBe(0);
  });

  it('日期不是 YYYY-MM-DD ⇒ asOf=null（宁可没有日期也不给错的）', () => {
    const m = pickLatestPerCurrency([{ currency: 'USD', rate: 6.72, effectiveDate: '上个月' }]);
    expect(m.get('USD')!.asOf).toBeNull();
    expect(m.get('USD')!.rate).toBe(6.72);
  });
});

/** 假 Prisma：只实现 exchangeRate.findMany（真源读取唯一的 DB 依赖） */
const fakePrisma = (rows: unknown[]) => ({
  exchangeRate: { findMany: async () => rows as any[] },
});

describe('fetchForexQuotes', () => {
  it('阳性对照：读表成功 ⇒ freshness=daily + isReal=true + asOf 带出', async () => {
    const qs = await fetchForexQuotes(fakePrisma(ROWS) as any);
    expect(qs.map(q => q.currency)).toEqual([...FOREX_CURRENCIES]);
    for (const q of qs) {
      expect(q.rate).not.toBeNull();
      expect(q.freshness).toBe('daily');
      expect(q.isReal).toBe(true);
      expect(q.asOf).toBe('2026-09-18');
    }
  });

  it('★ 拿不到就 null —— 不得回落硬编码（这是本次整改的核心判据）', async () => {
    const qs = await fetchForexQuotes(fakePrisma([]) as any);
    for (const q of qs) {
      expect(q.rate).toBeNull();
      expect(q.freshness).toBe('unavailable');
      expect(q.isReal).toBe(false);
      expect(q.error).toBe('no-exchange-rate-row');
    }
    // 反向断言：绝不能出现旧实现那种"抓不到就用 7.25"的兜底数字
    expect(qs.map(q => q.rate)).not.toContain(7.25);
  });

  it('读表抛错 ⇒ 全部 null 且带 error，不抛异常（行情卡不能把整页拖挂）', async () => {
    const broken = { exchangeRate: { findMany: async () => { throw new Error('db down'); } } };
    const qs = await fetchForexQuotes(broken as any);
    expect(qs.every(q => q.rate === null)).toBe(true);
    expect(qs[0].error).toContain('exchange-rate-read-failed');
  });

  it('prisma 不可用（未注入）⇒ 不抛，标记 prisma-unavailable', async () => {
    const qs = await fetchForexQuotes(null);
    expect(qs.every(q => q.rate === null && q.error === 'prisma-unavailable')).toBe(true);
  });
});

describe('toForexPayload（保持前端既有扁平键）', () => {
  it('键名仍是 USD_CNY / EUR_CNY / GBP_CNY（前端 marketService 按此消费）', async () => {
    const qs = await fetchForexQuotes(fakePrisma(ROWS) as any);
    const p = toForexPayload(qs, '2026-09-19');
    expect(p.USD_CNY).toBe(6.721785);
    expect(p.EUR_CNY).toBe(7.711051);
    expect(p.GBP_CNY).toBe(8.980369);
    expect(p.freshness).toBe('daily');
  });

  it('★ 非当日 ⇒ isStale=true（界面必须把日期标出来）', async () => {
    const qs = await fetchForexQuotes(fakePrisma(ROWS) as any);
    expect(toForexPayload(qs, '2026-09-19').isStale).toBe(true); // 表里是 09-18
    expect(toForexPayload(qs, '2026-09-18').isStale).toBe(false); // 同日 ⇒ 不打扰
  });

  it('全空 ⇒ freshness=unavailable + isStale=true（不能显示成"新鲜的"）', async () => {
    const qs = await fetchForexQuotes(fakePrisma([]) as any);
    const p = toForexPayload(qs, '2026-09-19');
    expect(p.freshness).toBe('unavailable');
    expect(p.isStale).toBe(true);
    expect(p.USD_CNY).toBeNull();
  });

  it('混了日期 ⇒ asOf 取最早的那个（保守，不美化）', async () => {
    const qs = await fetchForexQuotes(fakePrisma([
      { currency: 'USD', rate: 6.72, effectiveDate: '2026-09-18' },
      { currency: 'EUR', rate: 7.7, effectiveDate: '2026-09-15' },
      { currency: 'GBP', rate: 8.9, effectiveDate: '2026-09-18' },
    ]) as any);
    expect(toForexPayload(qs, '2026-09-19').asOf).toBe('2026-09-15');
  });
});

describe('结构守卫：汇率只能有一个源', () => {
  const SRC = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
  /** 剥掉块注释与行注释，避免"注释里提到旧源"被误判（也避免守卫被注释绕过） */
  const STRIPPED = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('★ /api/market/all 不再直连外部汇率 API', () => {
    expect(STRIPPED).not.toContain('api.exchangerate-api.com');
    expect(STRIPPED).not.toContain('open.er-api.com');
  });

  it('阳性对照：确实改用了真源（否则上面那条可能因为整段被删而"空过"）', () => {
    expect(STRIPPED).toContain('fetchForexQuotes');
    expect(STRIPPED).toContain('toForexPayload');
  });

  it('阳性对照：确实存在 /api/market/all 路由（防止路由被整体删掉后守卫空过）', () => {
    expect(STRIPPED).toContain("'/api/market/all'");
  });
});
