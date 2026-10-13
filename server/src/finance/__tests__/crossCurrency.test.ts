/**
 * crossCurrency.test.ts — ★ B2 真源单测：跨币种折算（经 CNY 过桥，缺汇率不猜）
 *
 * 真源是**纯函数**，这里钉死口径分支；驾驶舱毛利表的行为守卫在
 * `dashboard/__tests__/dashboardService.test.ts`（折算接线 + 锁汇优先 + 合计）。
 */
import { describe, expect, it } from 'vitest';
import { convertViaCny, pickRateOn } from '../crossCurrency';

const RATES = { USD: 7.1, EUR: 7.8, HKD: 0.9 } as Record<string, number | null>;

describe('convertViaCny（经 CNY 过桥）', () => {
  it('同币种 → 原值，rate=1', () => {
    expect(convertViaCny(1234.5678, 'USD', 'USD', RATES)).toEqual({ amount: 1234.5678, rate: 1 });
  });

  it('CNY → USD：除以 USD 汇率（1 USD = 7.1 CNY）', () => {
    const r = convertViaCny(7100, 'CNY', 'USD', RATES)!;
    expect(r.amount).toBe(1000);
    expect(r.rate).toBeCloseTo(1 / 7.1, 8);
  });

  it('USD → CNY：乘以 USD 汇率', () => {
    const r = convertViaCny(1000, 'USD', 'CNY', RATES)!;
    expect(r.amount).toBe(7100);
    expect(r.rate).toBeCloseTo(7.1, 8);
  });

  it('USD → EUR：两侧都经 CNY（不自造直盘）', () => {
    const r = convertViaCny(1000, 'USD', 'EUR', RATES)!;
    // 1000 USD = 7100 CNY = 7100 / 7.8 EUR
    expect(r.amount).toBeCloseTo(7100 / 7.8, 4);
    expect(r.rate).toBeCloseTo(7.1 / 7.8, 8);
  });

  it('CNY → CNY：恒等（表里没有也不该有 CNY 行）', () => {
    expect(convertViaCny(5000, 'CNY', 'CNY', {})).toEqual({ amount: 5000, rate: 1 });
  });

  it('大小写/空格不敏感', () => {
    expect(convertViaCny(7100, ' cny ', 'usd', RATES)!.amount).toBe(1000);
  });

  it('★ 缺汇率 → null（不猜、不按 1 折算 —— 猜出来的毛利比没有更危险）', () => {
    expect(convertViaCny(1000, 'USD', 'JPY', RATES)).toBeNull();
    expect(convertViaCny(1000, 'JPY', 'USD', RATES)).toBeNull();
  });

  it('汇率为 0 / 负 / NaN → null（脏数据不产生 Infinity）', () => {
    expect(convertViaCny(1000, 'USD', 'CNY', { USD: 0 })).toBeNull();
    expect(convertViaCny(1000, 'USD', 'CNY', { USD: -7.1 })).toBeNull();
    expect(convertViaCny(Number.NaN, 'USD', 'CNY', RATES)).toBeNull();
  });
});

describe('pickRateOn（市场汇率取数）', () => {
  const rows = [
    { currency: 'USD', rate: 7.0, effectiveDate: '2026-01-01' },
    { currency: 'USD', rate: 7.1, effectiveDate: '2026-06-01' },
    { currency: 'USD', rate: 7.2, effectiveDate: '2026-09-01' },
  ];

  it('取 effectiveDate ≤ 业务日的最近一条', () => {
    expect(pickRateOn(rows, 'USD', '2026-07-15')).toBe(7.1);
    expect(pickRateOn(rows, 'USD', '2026-09-01')).toBe(7.2);
  });

  it('业务日早于所有档案 → 回退该币种最新一条（历史数据兜底）', () => {
    expect(pickRateOn(rows, 'USD', '2025-01-01')).toBe(7.2);
  });

  it('无业务日 → 取最新一条', () => {
    expect(pickRateOn(rows, 'USD', null)).toBe(7.2);
  });

  it('该币种无档案 → null；CNY 恒为 1', () => {
    expect(pickRateOn(rows, 'JPY', '2026-07-15')).toBeNull();
    expect(pickRateOn([], 'CNY', '2026-07-15')).toBe(1);
  });

  it('脏行（rate ≤ 0 / null）被跳过', () => {
    const dirty = [{ currency: 'USD', rate: 0, effectiveDate: '2026-09-01' }, { currency: 'USD', rate: null, effectiveDate: '2026-08-01' }];
    expect(pickRateOn(dirty, 'USD', '2026-09-01')).toBeNull();
  });
});
