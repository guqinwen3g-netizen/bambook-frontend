import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOrderLineConfirmedSource } from './orderLineService';
vi.mock('./apiService', () => ({ apiService: { buildApiUrl: (path: string) => path, getAuthHeaders: () => ({ 'X-Test-Auth': 'synthetic' }) } }));
afterEach(() => vi.unstubAllGlobals());
const source = { confirmedSourceType: 'Asset', confirmedSourceId: 'ASSET-1' } as const;
describe('existing order version command protocol', () => {
  it('writes only the explicit source to the encoded original line path', async () => {
    const line = { id: 'LINE/1', ...source, specSnapshot: { sku: 'ACTUAL-1' } };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, line }), { status: 200 })); vi.stubGlobal('fetch', fetch);
    expect(await setOrderLineConfirmedSource('LINE/1', source)).toEqual(line);
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledWith('/v1/order-lines/LINE%2F1/version', { method: 'PATCH', headers: { 'X-Test-Auth': 'synthetic' }, body: JSON.stringify(source) });
  });
  it('keeps the genuine rejection status and human message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: '当前权限已被回收' } }), { status: 403 })));
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toMatchObject({ status: 403, message: '当前权限已被回收' });
  });
  it.each([{ id: 'OTHER-LINE', ...source }, { id: 'LINE-1', confirmedSourceType: 'Asset', confirmedSourceId: 'OTHER-ASSET' }])('a success for another line or source cannot qualify this write', async line => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, line }), { status: 200 })));
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toThrow('保存结果暂时无法核对');
  });
});
