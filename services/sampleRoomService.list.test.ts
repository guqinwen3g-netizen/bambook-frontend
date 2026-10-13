// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ endpoint: 'http://private.invalid/api', actor: 'A', listeners: new Set<() => void>() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: seam.endpoint }), buildApiUrl: (p: string, e: string) => e + p, getAuthHeaders: () => ({ Authorization: 'Bearer test' }) } }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true, isLoading: false, user: { id: seam.actor, roleIds: [], roles: [], permissions: [], permissionCeiling: undefined } }), subscribe: (f: () => void) => { seam.listeners.add(f); return () => seam.listeners.delete(f); } }));
import { sampleRoomService } from './sampleRoomService';
const dto = (scope = 'garment', offset = 50) => ({ listVersion: 2, scope, pagination: { limit: 50, offset }, filters: { status: null, cardType: null, search: null, code: null, warehouseId: null, devCaseId: 'G', orderId: null, productAssetId: null, sampleId: null, sampleIds: [], lowStock: true }, items: [], total: 50, snapshotAt: '123' });
const res = (d: any) => ({ ok: true, status: 200, json: async () => d });
beforeEach(() => { seam.endpoint = 'http://private.invalid/api'; seam.actor = 'A'; seam.listeners.clear(); vi.stubGlobal('fetch', vi.fn(async () => res(dto()))); });
it('sends actual offset/scope/anchor/lowStock and verifies their applied echo', async () => { const r: any = await sampleRoomService.listItems({ scope: 'garment', offset: 50, limit: 50, devCaseId: 'G', lowStock: true } as any); const url = new URL(String(vi.mocked(fetch).mock.calls[0][0])); expect(url.searchParams.get('offset')).toBe('50'); expect(url.searchParams.get('scope')).toBe('garment'); expect(r.scope).toBe('garment'); });
it.each([{}, { ...dto(), scope: 'fabric' }, { ...dto(), total: '51' }, { ...dto(), pagination: { limit: 50, offset: 0 } }, { ...dto(), filters: { ...dto().filters, devCaseId: 'F' } }])('rejects old/incorrect response instead of pretending classified page: %j', async data => { vi.mocked(fetch).mockResolvedValue(res(data) as any); await expect(sampleRoomService.listItems({ scope: 'garment', offset: 50, limit: 50, devCaseId: 'G', lowStock: true } as any)).rejects.toThrow(); });
it('legacy scope omitted lookup remains usable', async () => { vi.mocked(fetch).mockResolvedValue(res({ items: [], total: 0 }) as any); expect(await sampleRoomService.listItems({ productAssetId: 'material', limit: 6 })).toMatchObject({ items: [], total: 0 }); });
it('explicit empty target list never becomes an unfiltered whole-room fetch', async () => { await expect(sampleRoomService.listItems({ sampleIds: [] })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
it.each([{ ids: [' '] }, { ids: [' S '] }, { ids: [''] }])('malformed target IDs fail before transport: %j', async ({ ids }) => { await expect(sampleRoomService.listItems({ sampleIds: ids })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
it('actor A→B→A invalidates a late source response permanently', async () => { let resolve!: (v: any) => void; vi.mocked(fetch).mockImplementation(() => new Promise(r => { resolve = r; })); const p = sampleRoomService.listItems({ scope: 'garment', offset: 50, limit: 50, devCaseId: 'G', lowStock: true } as any); seam.actor = 'B'; seam.listeners.forEach(f => f()); seam.actor = 'A'; seam.listeners.forEach(f => f()); resolve(res(dto())); await expect(p).rejects.toThrow(); });

it('actual scoped transport preserves product, scalar Sample and Sample-set anchors together', async () => {
  const data = { ...dto('fabric', 0), total: 0, filters: { ...dto().filters, devCaseId: null, productAssetId: 'material-reference', sampleId: 'S2', sampleIds: ['S1', 'S2'], lowStock: false } };
  vi.mocked(fetch).mockResolvedValue(res(data) as any);
  await sampleRoomService.listItems({ scope: 'fabric', productAssetId: 'material-reference', sampleId: 'S2', sampleIds: ['S2', 'S1', 'S2'], limit: 50, offset: 0 });
  const u = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
  expect(u.searchParams.get('productAssetId')).toBe('material-reference');
  expect(u.searchParams.get('sampleId')).toBe('S2');
  expect(u.searchParams.get('sampleIds')).toBe('S1,S2');
});
