import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiService } from './apiService';

describe('product detail response boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('sessionStorage', { getItem: () => null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the asset shape and the authorized top-level order projection', async () => {
    const asset = { id: 'fabric-1', sku: 'F-1', name: '织物', mainCategory: 'Fabric', fabricProfile: { widthValue: 0 }, images: [] };
    const lines = [{ id: 'line-1', orderId: 'order-1', itemNo: '0010', lineNumber: 1, description: '准确行', quantity: '12.5000', unit: 'M', order: { id: 'order-1', poNumber: 'PO-1', dueDate: '', status: 'Pending' } }];
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, asset, relatedOrderLines: lines }) }));
    vi.stubGlobal('fetch', fetch);
    const result = await apiService.getProductAsset('fabric-1', 'https://example.test');
    expect(result).toEqual({ ...asset, relatedOrderLines: lines });
    expect(result.fabricProfile?.widthValue).toBe(0);
    expect(asset).not.toHaveProperty('relatedOrderLines');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/products/assets/fabric-1'), expect.objectContaining({ method: 'GET' }));
  });

  it('preserves the product when the authorized server projection is empty', async () => {
    const asset = { id: 'asset-no-order', sku: 'A-2' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, asset, relatedOrderLines: [] }) })));
    await expect(apiService.getProductAsset('asset-no-order', 'https://example.test')).resolves.toEqual({ ...asset, relatedOrderLines: [] });
  });

  it('propagates order scope failure instead of showing a successful empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'PRODUCT_DETAIL_FAILED', message: '订单范围暂不可核验' }) })));
    await expect(apiService.getProductAsset('fabric-1', 'https://example.test')).rejects.toThrow('订单范围暂不可核验');
  });
});
