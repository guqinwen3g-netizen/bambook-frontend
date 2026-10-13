import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock apiService before importing services
vi.mock('./apiService', () => ({
  apiService: {
    getStoredConfig: () => ({ cloudEndpoint: 'https://test.example.com' }),
    getApiKey: () => 'test-api-key',
    getAuthHeaders: () => ({ 'Content-Type': 'application/json', 'X-Bambook-API-Key': 'test-api-key' }),
    buildApiUrl: (path: string, base: string) => `${base}/api${path}`,
  },
}));

vi.mock('./authService', () => ({
  getAuthState: () => ({ isAuthenticated: true, user: { id: 'route-fixture-user', roles: ['finance'], roleIds: [],
    permissions: ['invoices:write', 'orders:read', 'shipments:read', 'shipments:write'] } }),
  hasPermission: (scope: string) => ['invoices:write', 'orders:read', 'shipments:read', 'shipments:write'].includes(scope),
}));

import { shipmentService } from './shipmentService';
import { invoiceService } from './invoiceService';
import { paymentVoucherService } from './paymentVoucherService';

// This focused route control supplies the independently tested source read.
// Its original assertions continue to inspect the actual business request.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } });
  vi.spyOn(shipmentService, 'getPhysicalContext').mockResolvedValue({ kind: 'legacy', updatedAt: '1', allocationFingerprint: 'a'.repeat(64) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// 捕获 fetch 调用的辅助
const captureFetch = () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const mockRes = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
  });
  return {
    calls,
    mockRes,
    mockFetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      const isInvoiceWrite = url.includes('/v1/finance') && ['POST', 'PATCH'].includes(init?.method ?? '');
      return mockRes(isInvoiceWrite ? { id: init?.method === 'PATCH' ? 'inv_1' : 'inv_created', invoiceNumber: 'INV-1', status: 'Draft' } : {}) as any;
    }),
  };
};

describe('shipmentService route alignment', () => {
  it('listShipments calls GET /v1/shipping', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await shipmentService.listShipments();
    expect(calls[0].url).toContain('/v1/shipping');
    expect(calls[0].method).toBeUndefined(); // GET
    vi.unstubAllGlobals();
  });

  it('createShipment calls POST /v1/shipping', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await shipmentService.createShipment({ carrierName: 'DHL' });
    expect(calls[0].url).toContain('/v1/shipping');
    expect(calls[0].method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('updateShipment calls PATCH /v1/shipping/:id (not PUT)', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await shipmentService.updateShipment('shp_1', { status: 'Delivered' });
    expect(calls[0].url).toContain('/v1/shipping/shp_1');
    expect(calls[0].method).toBe('PATCH');
    vi.unstubAllGlobals();
  });

  it('deleteShipment calls DELETE /v1/shipping/:id', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await shipmentService.deleteShipment('shp_1');
    expect(calls[0].url).toContain('/v1/shipping/shp_1');
    expect(calls[0].method).toBe('DELETE');
    vi.unstubAllGlobals();
  });

  it('does NOT use /v1/shipments (old wrong path)', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await shipmentService.listShipments();
    expect(calls[0].url).not.toContain('/v1/shipments');
    vi.unstubAllGlobals();
  });
});

describe('invoiceService route alignment', () => {
  it('listInvoices calls GET /v1/finance and unwraps items', async () => {
    const { mockFetch } = captureFetch();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [{ id: 'inv_1' }] }) } as any);
    vi.stubGlobal('fetch', mockFetch);
    const result = await invoiceService.listInvoices();
    expect(result).toEqual([{ id: 'inv_1' }]);
    vi.unstubAllGlobals();
  });

  it('createInvoice calls POST /v1/finance', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await invoiceService.createInvoice({ invoiceNumber: 'INV-1' });
    expect(calls[0].url).toContain('/v1/finance');
    expect(calls[0].method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('updateInvoice calls PATCH /v1/finance/:id (not PUT)', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await invoiceService.updateInvoice('inv_1', { status: 'Paid' });
    expect(calls[0].url).toContain('/v1/finance/inv_1');
    expect(calls[0].method).toBe('PATCH');
    vi.unstubAllGlobals();
  });

  it('does NOT use /v1/invoices (old wrong path)', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await invoiceService.listInvoices();
    expect(calls[0].url).not.toContain('/v1/invoices');
    vi.unstubAllGlobals();
  });

  it('deleteInvoice calls DELETE /v1/finance/:id', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await invoiceService.deleteInvoice('inv_1');
    expect(calls[0].url).toContain('/v1/finance/inv_1');
    expect(calls[0].method).toBe('DELETE');
    vi.unstubAllGlobals();
  });
});

describe('paymentVoucherService route alignment', () => {
  it('listPaymentVouchers calls GET /v1/finance/vouchers and unwraps items', async () => {
    const { mockFetch } = captureFetch();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [{ id: 'pv_1' }] }) } as any);
    vi.stubGlobal('fetch', mockFetch);
    const result = await paymentVoucherService.listPaymentVouchers();
    expect(result).toEqual([{ id: 'pv_1' }]);
    vi.unstubAllGlobals();
  });

  it('createPaymentVoucher calls POST /v1/finance/vouchers', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await paymentVoucherService.createPaymentVoucher({ voucherNumber: 'PV-1' });
    expect(calls[0].url).toContain('/v1/finance/vouchers');
    expect(calls[0].method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('updatePaymentVoucher calls PATCH /v1/finance/vouchers/:id (not PUT)', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await paymentVoucherService.updatePaymentVoucher('pv_1', { amount: 100 });
    expect(calls[0].url).toContain('/v1/finance/vouchers/pv_1');
    expect(calls[0].method).toBe('PATCH');
    vi.unstubAllGlobals();
  });

  it('does NOT use /v1/payment-vouchers (old wrong path)', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await paymentVoucherService.listPaymentVouchers();
    expect(calls[0].url).not.toContain('/v1/payment-vouchers');
    vi.unstubAllGlobals();
  });

  it('deletePaymentVoucher calls DELETE /v1/finance/vouchers/:id', async () => {
    const { calls, mockFetch } = captureFetch();
    vi.stubGlobal('fetch', mockFetch);
    await paymentVoucherService.deletePaymentVoucher('pv_1');
    expect(calls[0].url).toContain('/v1/finance/vouchers/pv_1');
    expect(calls[0].method).toBe('DELETE');
    vi.unstubAllGlobals();
  });
});
