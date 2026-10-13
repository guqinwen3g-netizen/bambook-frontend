/**
 * M4 汇率外部行情同步调度任务单元测试
 *
 * 覆盖：
 *   1. 正常同步：base=CNY 牌价折算为「1 单位外币兑 CNY」（1/rate），source='api' 入库
 *   2. 日内幂等：当日已有 source='api' 记录 → 跳过
 *   3. 行情源缺少某币种 → 该币种跳过，不影响其余
 *   4. 离线兜底（硬约束）：fetch 拒绝 / HTTP 非 2xx / 返回结构异常 → offline=true + 不抛错 + 不入库
 *   5. shouldRun：08:30 前不跑，之后按 6 小时桶去重
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockAddRate = vi.fn().mockResolvedValue({ id: 'FXR_1' });

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../risk/riskService', () => ({
  createRiskService: vi.fn(() => ({
    addExchangeRate: mockAddRate,
  })),
}));

import { syncFxRatesFromExternal, createFxRateSyncTask } from '../tasks/fxRateSync';

const TODAY = new Date(2026, 7, 10, 12, 0, 0);

function makePrisma(existingCurrencies: string[] = [], apiSyncedToday: string[] = []) {
  return {
    exchangeRate: {
      findMany: vi.fn().mockResolvedValue(existingCurrencies.map((currency) => ({ currency }))),
      findFirst: vi.fn(async ({ where }: any) =>
        apiSyncedToday.includes(where.currency) ? { id: 'FXR_EXIST' } : null,
      ),
    },
  } as any;
}

function okFetch(rates: Record<string, number>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ result: 'success', rates }),
  }) as any;
}

describe('fxRateSync · syncFxRatesFromExternal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddRate.mockResolvedValue({ id: 'FXR_1' });
  });

  it('正常同步：牌价折算为 1 外币兑 CNY，source=api，目标=档案币种 ∪ 默认集', async () => {
    const prisma = makePrisma(['USD', 'CHF']); // CHF 档案已有但不在默认集
    const res = await syncFxRatesFromExternal(prisma, {
      today: TODAY,
      fetchImpl: okFetch({ USD: 0.14, EUR: 0.128, HKD: 1.0937, GBP: 0.1092, JPY: 20.55, CHF: 0.112 }),
    });
    expect(res.offline).toBe(false);
    expect(res.synced).toContain('USD');
    expect(res.synced).toContain('CHF');
    const usdCall = mockAddRate.mock.calls.find((c) => c[0].currency === 'USD');
    expect(usdCall[0].rate).toBeCloseTo(1 / 0.14, 6);
    expect(usdCall[0].source).toBe('api');
    expect(usdCall[0].effectiveDate).toBe('2026-08-10');
    expect(usdCall[1]).toBe('system_fx_sync');
  });

  it('日内幂等：当日已同步 source=api 的币种跳过', async () => {
    const prisma = makePrisma([], ['USD', 'EUR', 'HKD', 'GBP', 'JPY']);
    const res = await syncFxRatesFromExternal(prisma, {
      today: TODAY,
      fetchImpl: okFetch({ USD: 0.14, EUR: 0.128, HKD: 1.09, GBP: 0.109, JPY: 20.5 }),
    });
    expect(res.synced).toEqual([]);
    expect(res.skipped.sort()).toEqual(['EUR', 'GBP', 'HKD', 'JPY', 'USD']);
    expect(mockAddRate).not.toHaveBeenCalled();
  });

  it('行情源缺少某币种 → 该币种跳过，其余照常', async () => {
    const prisma = makePrisma([], []);
    const res = await syncFxRatesFromExternal(prisma, {
      today: TODAY,
      fetchImpl: okFetch({ USD: 0.14 }), // 仅 USD
    });
    expect(res.synced).toEqual(['USD']);
    expect(res.skipped).toContain('EUR');
    expect(mockAddRate).toHaveBeenCalledTimes(1);
  });

  it('离线兜底：fetch 拒绝 → offline=true + 不抛错 + 不入库', async () => {
    const prisma = makePrisma(['USD']);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND open.er-api.com')) as any;
    const res = await syncFxRatesFromExternal(prisma, { today: TODAY, fetchImpl });
    expect(res).toEqual({ offline: true, synced: [], skipped: [] });
    expect(mockAddRate).not.toHaveBeenCalled();
  });

  it('离线兜底：HTTP 非 2xx → offline=true + 不抛错', async () => {
    const prisma = makePrisma(['USD']);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }) as any;
    const res = await syncFxRatesFromExternal(prisma, { today: TODAY, fetchImpl });
    expect(res.offline).toBe(true);
    expect(mockAddRate).not.toHaveBeenCalled();
  });

  it('离线兜底：返回结构异常（缺 result=success）→ offline=true + 不抛错', async () => {
    const prisma = makePrisma(['USD']);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'error', 'error-type': 'unsupported-code' }),
    }) as any;
    const res = await syncFxRatesFromExternal(prisma, { today: TODAY, fetchImpl });
    expect(res.offline).toBe(true);
    expect(mockAddRate).not.toHaveBeenCalled();
  });
});

describe('fxRateSync · shouldRun', () => {
  it('08:30 前不跑，之后按 6 小时桶去重', () => {
    const task = createFxRateSyncTask();
    expect(task.shouldRun(new Date(2026, 7, 20, 8, 0))).toBe(false); // 08:00 < 08:30
    expect(task.shouldRun(new Date(2026, 7, 20, 9, 0))).toBe(true);
    expect(task.shouldRun(new Date(2026, 7, 20, 11, 0))).toBe(false); // 同 6 小时桶（06-12）
    expect(task.shouldRun(new Date(2026, 7, 20, 13, 0))).toBe(true); // 下一桶（12-18，离线重试）
    expect(task.shouldRun(new Date(2026, 7, 21, 9, 0))).toBe(true); // 次日
  });
});
