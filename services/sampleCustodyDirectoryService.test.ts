// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ actor: 'DIRECTORY_ACTOR', token: 'TOKEN_A', endpoint: 'http://directory-fixture.invalid/api', grants: ['products:read'], ceiling: ['products:read'], authenticated: true, loading: false, listeners: new Set<() => void>() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: seam.endpoint }), getAuthHeaders: () => ({ Authorization: 'Bearer ' + seam.token }), buildApiUrl: (p: string, e: string) => e + p } }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: seam.authenticated, isLoading: seam.loading, user: { id: seam.actor, permissions: seam.grants, permissionCeiling: seam.ceiling } }), hasPermission: (p: string) => seam.grants.includes(p) && seam.ceiling.includes(p), subscribe: (f: () => void) => { seam.listeners.add(f); return () => seam.listeners.delete(f); } }));
import { sampleCustodyDirectoryService as service, type CustodyDirectoryQuery, type CustodyLane } from './sampleCustodyDirectoryService';

// Contract fixtures are synthetic; these controls do not claim native PG visibility or MVCC proof.
function item(lane: CustodyLane, n = 0): any {
  const card = { id: 'CARD_' + n, code: 'SC-' + n, cardType: lane === 'garment' ? 'garment' : lane === 'trim' ? 'trim' : lane === 'other' ? 'other' : 'fabric', location: 'A-01', quantity: 3, availableQty: 2, unit: '张' };
  return lane === 'review'
    ? { visibility: 'catalog', card, businessContext: { status: 'unresolved', businessLine: null, reasons: ['OWNERSHIP_NOT_RECORDED'] } }
    : { visibility: 'full', card: { ...card, locationDetail: { zone: 'A', shelf: '03', level: '2', bin: 'B' }, name: '原实物 ' + n, status: 'borrowed', photos: [{ id: 'PHOTO_' + n, mimeType: 'image/jpeg', size: 12, uploadedAt: '2026-10-06T01:02:03.000Z', signature: 'a'.repeat(64), url: `/api/v1/samples/room/items/CARD_${n}/photos/PHOTO_${n}?sig=${'a'.repeat(64)}` }] }, businessContext: { status: 'resolved', businessLine: lane === 'fabric' ? 'fabric' : 'garment', reasons: [] }, receiptStatus: 'manual', ...(lane === 'fabric' ? { archive: {
      id: `physical-item:CARD_${n}`, identityKind: 'physical-item', name: '原实物 ' + n, code: 'SC-' + n, productAssetId: null, developmentSampleVersionId: null, sourceLabel: null,
      forms: [{ kind: '样卡', unit: '张', total: '3', available: '2', locations: [{ location: 'A-01', total: '3', available: '2', memberIds: ['CARD_' + n] }] }],
      members: [{ id: 'CARD_' + n, code: 'SC-' + n, name: '原实物 ' + n, cardType: 'fabric', status: 'borrowed', location: 'A-01', unit: '张', total: '3', available: '2', businessContext: { status: 'resolved', businessLine: 'fabric', reasons: [] }, receiptStatus: 'manual' }],
    } } : {}) };
}
function page(q: Partial<CustodyDirectoryQuery> = {}, total = 1): any {
  const lane = q.lane || 'fabric', limit = q.limit ?? 50, offset = q.offset ?? 0;
  return { ok: true, directoryVersion: lane === 'fabric' ? 4 : 3, lane, pagination: { limit, offset }, filters: { search: q.search?.trim() || '', cardType: q.cardType || '' }, snapshotAt: '1791091200000', total, items: Array.from({ length: Math.min(limit, Math.max(total - offset, 0)) }, (_, n) => item(lane, offset + n)) };
}
const response = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noWrite = () => expect(vi.mocked(fetch).mock.calls.every(c => (c[1] as any)?.method === 'GET' && String(c[0]).includes('/v1/samples/room/custody-directory?'))).toBe(true);
beforeEach(() => { Object.assign(seam, { actor: 'DIRECTORY_ACTOR', token: 'TOKEN_A', endpoint: 'http://directory-fixture.invalid/api', grants: ['products:read'], ceiling: ['products:read'], authenticated: true, loading: false }); seam.listeners.clear(); vi.stubGlobal('fetch', vi.fn(async () => response(page()))); });
afterEach(() => vi.unstubAllGlobals());

it('physical material determines its lane while garment business ownership remains visible', async () => {
  const garmentOwnedFabric = page({ lane: 'fabric' }); garmentOwnedFabric.items[0].businessContext.businessLine = 'garment';
  vi.mocked(fetch).mockResolvedValueOnce(response(garmentOwnedFabric) as any)
    .mockResolvedValueOnce(response(page({ lane: 'garment' })) as any)
    .mockResolvedValueOnce(response(page({ lane: 'review' })) as any);
  const fabricItem = (await service.list({ lane: 'fabric' })).items[0], garmentItem = (await service.list({ lane: 'garment' })).items[0], catalog = (await service.list({ lane: 'review' })).items[0];
  expect(fabricItem.card.cardType).toBe('fabric'); expect(fabricItem.businessContext.businessLine).toBe('garment');
  expect(garmentItem.card.cardType).toBe('garment'); expect(garmentItem.businessContext.businessLine).toBe('garment');
  expect(catalog.visibility).toBe('catalog'); expect(catalog.businessContext.businessLine).toBeNull(); noWrite();
});
it('accepts trim as its own physical lane with secure photos visible only on full records', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(page({ lane: 'trim' })) as any).mockResolvedValueOnce(response(page({ lane: 'review' })) as any);
  const trim = await service.list({ lane: 'trim' }), review = await service.list({ lane: 'review' });
  expect(trim.items[0].card.cardType).toBe('trim'); expect((trim.items[0] as any).card.photos).toHaveLength(1);
  expect(review.items[0].visibility).toBe('catalog'); expect((review.items[0].card as any).photos).toBeUndefined(); noWrite();
});
it.each(['full', 'catalog'])('preserves fractional meter custody amounts for %s physical cards', async visibility => {
  const p = page({ lane: 'fabric' });
  if (visibility === 'catalog') p.items[0] = item('review');
  Object.assign(p.items[0].card, { quantity: 2.75, availableQty: 1.25, unit: '米' });
  if (visibility === 'full') {
    const archive = p.items[0].archive;
    Object.assign(archive.members[0], { total: '2.75', available: '1.25', unit: '米' });
    Object.assign(archive.forms[0], { kind: '库存米样', total: '2.75', available: '1.25', unit: '米' });
    Object.assign(archive.forms[0].locations[0], { total: '2.75', available: '1.25' });
  }
  vi.mocked(fetch).mockResolvedValueOnce(response(p) as any);
  expect((await service.list({ lane: 'fabric' })).items[0].card).toMatchObject({ quantity: 2.75, availableQty: 1.25, unit: '米' });
  noWrite();
});
it('rejects meter quantities beyond the stored decimal precision', async () => {
  const p = page(); Object.assign(p.items[0].card, { quantity: 2.75, availableQty: 1.25001, unit: '米' });
  vi.mocked(fetch).mockResolvedValueOnce(response(p) as any);
  await expect(service.list({ lane: 'fabric' })).rejects.toThrow(); noWrite();
});
it.each([
  { physicalLengthQty: null, availableLengthQty: null },
  { physicalLengthQty: '10.5000', availableLengthQty: '8.2500' },
  { physicalLengthQty: '0', availableLengthQty: '0.0000' },
  { physicalLengthQty: '99999999999999.9999', availableLengthQty: '99999999999999.9998' },
])('accepts the native length balance %j without converting physical item counts to meters', async balance => {
  const p = page(); Object.assign(p.items[0].card, balance);
  vi.mocked(fetch).mockResolvedValueOnce(response(p) as any);
  expect((await service.list({ lane: 'fabric' })).items[0].card).toMatchObject({ ...balance, quantity: 3, availableQty: 2, unit: '张' });
  noWrite();
});
it.each([
  { physicalLengthQty: '1' },
  { availableLengthQty: '1' },
  { physicalLengthQty: null, availableLengthQty: '0' },
  { physicalLengthQty: '1', availableLengthQty: null },
  { physicalLengthQty: '1', availableLengthQty: '1.0001' },
  { physicalLengthQty: '99999999999999.9998', availableLengthQty: '99999999999999.9999' },
  { physicalLengthQty: '1.00001', availableLengthQty: '1' },
  { physicalLengthQty: '100000000000000', availableLengthQty: '1' },
  { physicalLengthQty: '01', availableLengthQty: '1' },
  { physicalLengthQty: '-1', availableLengthQty: '0' },
  { physicalLengthQty: '1e3', availableLengthQty: '1' },
  { physicalLengthQty: 1, availableLengthQty: 1 },
])('rejects an incomplete, imprecise or inconsistent length balance %j', async balance => {
  const p = page(); Object.assign(p.items[0].card, balance);
  vi.mocked(fetch).mockResolvedValueOnce(response(p) as any);
  await expect(service.list({ lane: 'fabric' })).rejects.toThrow(); noWrite();
});
it('keeps length balances out of identity-only catalog responses', async () => {
  const p = page({ lane: 'review' }); Object.assign(p.items[0].card, { physicalLengthQty: null, availableLengthQty: null });
  vi.mocked(fetch).mockResolvedValueOnce(response(p) as any);
  await expect(service.list({ lane: 'review' })).rejects.toThrow(); noWrite();
});
it('rejects a photo array attached to an identity-only catalog card', async () => {
  const p = page({ lane: 'review' }); p.items[0].card.photos = [];
  vi.mocked(fetch).mockResolvedValue(response(p) as any); await expect(service.list({ lane: 'review' })).rejects.toThrow(); noWrite();
});
it('keeps identity-only physical records discoverable in their material category without detail fields', async () => {
  const p = page({ lane: 'fabric' }); p.items[0] = item('review');
  vi.mocked(fetch).mockResolvedValue(response(p) as any);
  const card = (await service.list({ lane: 'fabric' })).items[0];
  expect(card.visibility).toBe('catalog'); expect(card.card).toMatchObject({ cardType: 'fabric', code: 'SC-0' });
  expect(card.card).not.toHaveProperty('photos'); expect(card.card).not.toHaveProperty('locationDetail'); noWrite();
});
it.each(['unresolved', 'conflict'])('keeps full authorized physical items in their category when ownership is %s', async status => {
  const p = page({ lane: 'fabric' });
  Object.assign(p.items[0].businessContext, { status, businessLine: null, reasons: ['PHYSICAL_SOURCE_MISSING'] });
  vi.mocked(fetch).mockResolvedValue(response(p) as any);
  const item = (await service.list({ lane: 'fabric' })).items[0];
  expect(item.visibility).toBe('full'); expect(item.businessContext.status).toBe(status); noWrite();
});
it('rejects malformed structured warehouse coordinates', async () => {
  const p = page(); p.items[0].card.locationDetail = { zone: 'A', shelf: '03', level: {}, bin: 'B' };
  vi.mocked(fetch).mockResolvedValue(response(p) as any); await expect(service.list({ lane: 'fabric' })).rejects.toThrow(); noWrite();
});
it.each(['name', 'notes', 'status', 'receiptSnapshot', 'activeLoans', 'devCaseId', 'sampleId', 'receiptStatus'])('catalog rejects forbidden %s even when null, rather than silently sanitizing excess disclosure', async key => {
  const p = page({ lane: 'review' }); if (key === 'receiptStatus') p.items[0][key] = null; else p.items[0].card[key] = null;
  vi.mocked(fetch).mockResolvedValue(response(p) as any); await expect(service.list({ lane: 'review' })).rejects.toThrow(); noWrite();
});
it.each(['lane', 'version', 'page', 'filter', 'snapshot', 'cardinality', 'duplicate', 'top-extra', 'context-extra'])('rejects malformed %s and cannot report a fake empty result', async kind => {
  const p = page({}, 2);
  if (kind === 'lane') p.lane = 'garment'; if (kind === 'version') delete p.directoryVersion;
  if (kind === 'page') p.pagination.offset = 200; if (kind === 'filter') p.filters.search = 'HIDDEN_NAME';
  if (kind === 'snapshot') p.snapshotAt = 123; if (kind === 'cardinality') p.items.pop();
  if (kind === 'duplicate') p.items[1].card.id = p.items[0].card.id;
  if (kind === 'top-extra') p.rawParents = []; if (kind === 'context-extra') p.items[0].businessContext.customer = 'hidden';
  vi.mocked(fetch).mockResolvedValue(response(p) as any); await expect(service.list({ lane: 'fabric' })).rejects.toThrow(); noWrite();
});
it.each(['catalog-wrong-material-lane', 'wrong-material-lane', 'resolved-review', 'review-full-with-line', 'catalog-wrong-reason'])('refuses %s without reclassifying by business owner', async kind => {
  const requested: CustodyLane = kind.startsWith('review') || kind.includes('review') || kind === 'catalog-wrong-reason' ? 'review' : 'fabric';
  const p = page({ lane: requested });
  if (kind === 'catalog-wrong-material-lane') { p.items[0] = item('review'); p.items[0].card.cardType = 'garment'; }
  if (kind === 'wrong-material-lane') p.items[0].card.cardType = 'garment';
  if (kind === 'resolved-review') p.items[0] = item('fabric');
  if (kind === 'review-full-with-line') { p.items[0] = item('fabric'); p.items[0].businessContext.status = 'conflict'; p.items[0].businessContext.businessLine = 'fabric'; }
  if (kind === 'catalog-wrong-reason') p.items[0].businessContext.reasons = ['PHYSICAL_SOURCE_MISSING'];
  vi.mocked(fetch).mockResolvedValue(response(p) as any); await expect(service.list({ lane: requested })).rejects.toThrow(); noWrite();
});
it('a full conflict is valid in review while native receipt status remains only a summary', async () => {
  const p = page({ lane: 'review' }); p.items[0] = item('fabric'); delete p.items[0].archive; Object.assign(p.items[0].businessContext, { status: 'conflict', businessLine: null, reasons: ['PHYSICAL_CASE_SOURCE_CONFLICT'] }); p.items[0].receiptStatus = 'legacyUnverified';
  vi.mocked(fetch).mockResolvedValue(response(p) as any); expect((await service.list({ lane: 'review' })).items[0]).toMatchObject({ visibility: 'full', receiptStatus: 'legacyUnverified', businessContext: { status: 'conflict' } }); noWrite();
});
it.each([null, '张', 'M', 'SET', ''])('preserves original nullable unit %j without substituting PC', async unit => {
  const p = page(); p.items[0].card.unit = unit; vi.mocked(fetch).mockResolvedValue(response(p) as any);
  expect((await service.list({ lane: 'fabric' })).items[0].card.unit).toBe(unit); noWrite();
});
it('unbounded legal Text display fields and legacy material/status survive without changing identifiers', async () => {
  const p = page({ lane: 'other' }), c = p.items[0].card; Object.assign(c, { locationDetail: { zone: null, shelf: null, level: null, bin: null }, name: '  ' + '长名称'.repeat(300), location: '  ' + '库位'.repeat(300), status: 'historic-status', cardType: 'other' });
  vi.mocked(fetch).mockResolvedValue(response(p) as any); expect((await service.list({ lane: 'other' })).items[0].card).toEqual(c); noWrite();
});
it.each(['quantity-object', 'fraction', 'negative', 'available-over-total', 'unsafe', 'unit-object', 'name-object', 'location-object', 'status-object', 'material-object', 'bad-id'])('malformed %s never reaches rendering', async kind => {
  const p = page(), c = p.items[0].card;
  if (kind === 'quantity-object') c.quantity = {}; if (kind === 'fraction') c.availableQty = 1.5;
  if (kind === 'negative') c.quantity = -1; if (kind === 'available-over-total') c.availableQty = 4;
  if (kind === 'unsafe') c.quantity = Number.MAX_SAFE_INTEGER + 1; if (kind === 'unit-object') c.unit = {};
  if (kind === 'name-object') c.name = {}; if (kind === 'location-object') c.location = {};
  if (kind === 'status-object') c.status = {}; if (kind === 'material-object') c.cardType = {};
  if (kind === 'bad-id') c.id = ' CARD ';
  vi.mocked(fetch).mockResolvedValue(response(p) as any); await expect(service.list({ lane: 'fabric' })).rejects.toThrow(); noWrite();
});
it.each([403, 404, 500])('HTTP %i propagates failure, never falls back to legacy full-reader or sends a write', async status => {
  vi.mocked(fetch).mockResolvedValue(response({ error: { code: 'DIRECTORY_UNAVAILABLE', message: '台账服务未就绪' } }, status) as any);
  await expect(service.list({ lane: 'fabric' })).rejects.toMatchObject({ status, code: 'DIRECTORY_UNAVAILABLE', message: '台账服务未就绪' }); expect(fetch).toHaveBeenCalledTimes(1); noWrite();
});
it('a code filter is sent normalized with exact empty material, not applied after a truncated fetch', async () => {
  vi.mocked(fetch).mockResolvedValue(response(page({ search: 'SC-25' })) as any);
  await service.list({ lane: 'fabric', search: '  SC-25  ' });
  const u = new URL(String(vi.mocked(fetch).mock.calls[0][0])); expect(Object.fromEntries(u.searchParams)).toEqual({ lane: 'fabric', limit: '50', offset: '0', search: 'SC-25', cardType: '' }); noWrite();
});
it('complete count beyond 200 and a tail page are preserved; limit0 is count-only rather than zero stock', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(page({ offset: 250 }, 253)) as any).mockResolvedValueOnce(response(page({ limit: 0 }, 253)) as any);
  const tail = await service.list({ lane: 'fabric', offset: 250 }), onlyCount = await service.list({ lane: 'fabric', limit: 0 });
  expect(tail.items.map(x => x.card.id)).toEqual(['CARD_250', 'CARD_251', 'CARD_252']); expect(tail.total).toBe(253);
  expect(onlyCount.items).toEqual([]); expect(onlyCount.total).toBe(253); noWrite();
});
it.each([{ lane: 'bad' }, { lane: 'fabric', offset: '0' }, { lane: 'fabric', limit: null }, { lane: 'fabric', limit: 101 }, { lane: 'fabric', offset: -1 }, { lane: 'fabric', limit: 1.5 }, { lane: 'fabric', search: {} }, { lane: 'fabric', cardType: ['fabric'] }, { lane: 'fabric', hiddenName: 'person' }])('raw invalid query %j sends zero requests', async q => { await expect(service.list(q as any)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
it.each(['grant', 'ceiling', 'loading', 'authenticated', 'actor'])('missing current %s sends zero requests', async kind => {
  if (kind === 'grant') seam.grants = []; if (kind === 'ceiling') seam.ceiling = []; if (kind === 'loading') seam.loading = true; if (kind === 'authenticated') seam.authenticated = false; if (kind === 'actor') seam.actor = '';
  await expect(service.list({ lane: 'review' })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it.each(['actor', 'token', 'ceiling', 'endpoint'])('permanent %s A → B → A rejects a delayed read after original values return', async kind => {
  let finish!: (r: any) => void; vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; })); const old = service.list({ lane: 'fabric' });
  if (kind === 'actor') { seam.actor = 'OTHER'; seam.listeners.forEach(f => f()); seam.actor = 'DIRECTORY_ACTOR'; }
  if (kind === 'token') { seam.token = 'TOKEN_B'; window.dispatchEvent(new Event('storage')); seam.token = 'TOKEN_A'; }
  if (kind === 'ceiling') { seam.ceiling = []; seam.listeners.forEach(f => f()); seam.ceiling = ['products:read']; }
  if (kind === 'endpoint') { seam.endpoint = 'http://other.invalid/api'; window.dispatchEvent(new Event('focus')); seam.endpoint = 'http://directory-fixture.invalid/api'; }
  seam.listeners.forEach(f => f()); finish(response(page())); await expect(old).rejects.toThrow('已变化'); noWrite();
});
it('caller ticket and aborted signal are checked before GET, and context events cannot revive a ticket', async () => {
  await expect(service.list({ lane: 'fabric' }, { current: () => false })).rejects.toThrow(); const controller = new AbortController(); controller.abort(); await expect(service.list({ lane: 'fabric' }, { signal: controller.signal })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  let finish!: (r: any) => void; vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; })); const old = service.list({ lane: 'fabric' }); window.dispatchEvent(new Event('bambook:email-context-changed')); finish(response(page())); await expect(old).rejects.toThrow('已变化');
});
it('identity changes during JSON parsing cannot publish a previously authorized payload', async () => {
  let finish!: (v: any) => void; vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) } as any);
  const old = service.list({ lane: 'fabric' }); await Promise.resolve(); seam.grants = []; seam.listeners.forEach(f => f()); finish(page()); await expect(old).rejects.toThrow('已变化');
});
