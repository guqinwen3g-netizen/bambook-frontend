import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrderLine, updateOrderLineFields } from './orderLineService';

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

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorage());
  vi.stubGlobal('sessionStorage', createStorage());
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, line: { id: 'L1', itemNo: '0010' } }),
  })));
});

describe('orderLineService', () => {
  it('creates one fabric item', async () => {
    await createOrderLine({ poNumber: 'PO-1', itemNo: '0010', quantity: 1 });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-lines'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"poNumber":"PO-1"'),
      }),
    );
  });

  it('keeps the exact internal parent when two orders share an external PO', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, line: { id: 'L2', orderId: 'GARMENT-ID' } }) } as Response);
    await createOrderLine({ orderId: 'GARMENT-ID', itemNo: '0010', quantity: 1 });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.orderId).toBe('GARMENT-ID');
    expect(body.poNumber).toBeUndefined();
  });
  it('rejects a successful-looking response for another internal parent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, line: { id: 'L2', orderId: 'OTHER-ID' } }) } as Response);
    await expect(createOrderLine({ orderId: 'GARMENT-ID', quantity: 1 })).rejects.toThrow('刷新原订单');
  });

  it('updates one fabric item', async () => {
    await updateOrderLineFields('L1', { status: 'Shipping' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-lines/L1'),
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"status":"Shipping"'),
      }),
    );
  });
});
