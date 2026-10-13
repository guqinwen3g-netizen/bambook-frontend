import { beforeEach, describe, expect, it, vi } from 'vitest';
// fxSettlementService 模块级无可执行副作用（apiKey/config 全部调用时读取），
// 静态导入一次即可；beforeEach 的 stubGlobal 保证测试间隔离。
import { fxSettlementService } from './fxSettlementService';

const ENDPOINT = 'https://test.example.com';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

describe('fxSettlementService（F2 外汇核销闭环 contract）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('createFxSettlement POST 到 /v1/finance/fx-settlements，且绝不发送 cnyAmount（服务端计算不变量）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ id: 'FXS__1', settlementNumber: 'FXS-20260808-A1B2' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const input = { voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 5000, fxRate: 7.12345678, bank: 'BOC' };
    await fxSettlementService.createFxSettlement(input, ENDPOINT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/finance/fx-settlements');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject(input);
    expect(body).not.toHaveProperty('cnyAmount');
  });

  it('createFxSettlement 透出服务端阻断原因（OVER_SETTLEMENT 等 error.message）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'OVER_SETTLEMENT', message: 'over-settlement: foreignAmount 6000 exceeds remaining 5000 USD' } }),
    })));

    await expect(
      fxSettlementService.createFxSettlement({ voucherId: 'PAY__1', settleDate: '2026-08-08', foreignAmount: 6000, fxRate: 7.1 }, ENDPOINT),
    ).rejects.toThrow('over-settlement');
  });

  it('getVoucherSettlementSummary GET /v1/finance/vouchers/:id/settlements（id 编码）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ voucherId: 'PAY__1', fullySettled: false, settlements: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fxSettlementService.getVoucherSettlementSummary('PAY__1', ENDPOINT);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/finance/vouchers/PAY__1/settlements'),
      expect.any(Object),
    );
  });

  it('getFxLedger 拼接 from/to 查询参数', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ from: '2026-08-01', to: '2026-08-08', rows: [], unsettledVouchers: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fxSettlementService.getFxLedger({ from: '2026-08-01', to: '2026-08-08' }, ENDPOINT);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/finance/fx-settlements/ledger');
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('to=2026-08-08');
  });

  it('listFxSettlements 归一化 items/total 响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ id: 'FXS__1' }, { id: 'FXS__2' }], total: 2 }),
    })));

    const result = await fxSettlementService.listFxSettlements(ENDPOINT, { voucherId: 'PAY__1' });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('deleteFxSettlement 失败时透出服务端 error.message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'SETTLEMENT_NOT_FOUND', message: 'fx settlement not found' } }),
    })));

    await expect(fxSettlementService.deleteFxSettlement('FXS__x', ENDPOINT)).rejects.toThrow('fx settlement not found');
  });
});
