// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ actor: 'ACTOR', token: 'token-A', endpoint: 'http://card-fixture.invalid/api', grants: ['products:read', 'sample:room:write'], ceiling: ['products:read', 'sample:room:write'], listeners: new Set<() => void>() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: seam.endpoint }), getAuthHeaders: () => ({ Authorization: 'Bearer ' + seam.token }), buildApiUrl: (p: string, e: string) => e + p } }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true, isLoading: false, user: { id: seam.actor, permissions: seam.grants, permissionCeiling: seam.ceiling } }), hasPermission: (s: string) => seam.grants.includes(s) && seam.ceiling.includes(s), subscribe: (f: () => void) => { seam.listeners.add(f); return () => seam.listeners.delete(f); } }));
import { sampleCardSampleLinkService as service, cardLinkNamespace, readPendingCardSampleLink, savePendingCardSampleLink, clearPendingCardSampleLink, type PendingCardSampleLink } from './sampleCardSampleLinkService';
import nativeWire from './__fixtures__/sampleCardSampleLinkWire.json';
const native = nativeWire.wires.find(x => x.family === 'garment')!;
const wire = { actorId: native.actorId, cardId: native.cardId, targetSampleId: native.sampleId, input: native.command, reverse20: native.reverse, reverse1: { ...native.reverse, pagination: { limit: 1, cursor: null } }, context: native.context, candidates: native.candidates, success: native.linked, recoveryAfterReturn: native.recovered };
const protocol = { ok: true, linkVersion: 1, operation: 'link_received_card_to_sample', mode: 'v2-receipt-exact-origin', persistentReceipt: true, supportsBorrowed: true, createsInventory: false, autoApproval: false, matchedComponentOnly: true, directSourcesOnly: true, inheritedSourcesSupported: false };
const H = 'a'.repeat(64);
const page = () => ({ ...protocol, readerVersion: 1, queryMode: 'target-sample-exact-unlinked-v2', anchorSampleId: 'S', snapshotAt: '123', pagination: { limit: 20, cursor: null }, targetEligibility: { eligible: false, reasons: ['NO_EXACT_ORIGIN'] }, expectedTargetIdentityHash: null, expectedBindingSetHash: null, items: [], hasMore: false, nextCursor: null });
const review = () => ({ ...protocol, readerVersion: 1, queryMode: 'same-sample-linked-review', anchorSampleId: 'S', snapshotAt: '123', pagination: { limit: 20, cursor: null }, items: [{ card: { id: 'C', code: 'SC-C', name: '原卡', sampleId: 'S', cardType: 'fabric', location: null, unit: 'PC', quantity: 3, availableQty: 2, status: 'retired' }, businessContext: { status: 'conflict', businessLine: null, reasons: ['PHYSICAL_CASE_SOURCE_CONFLICT'] }, receiptStatus: 'manual', linkEligibility: { eligible: false, reasons: ['CARD_ALREADY_LINKED'] }, activeLoans: [{ id: 'L', itemId: 'C', loanType: 'borrow', loanQuantity: 1, returnedAt: null, borrowerName: '真实借出记录', dueAt: null }], overdue: false, links: { sample: { id: 'S', code: 'SMP-S' }, warehouse: null } }], hasMore: false, nextCursor: null });
const pending = (): PendingCardSampleLink => ({ version: 1, actorId: seam.actor, endpoint: seam.endpoint, cardId: 'C', preservedCardHash: H, attempts: 0, command: { linkVersion: 1, requestKey: 'original-link-request', targetSampleId: 'S', matchedSampleSourceId: 'SOURCE', expectedCardUpdatedAt: '10', expectedReceiptHash: H, expectedTargetIdentityHash: H, expectedBindingSetHash: H } });
const response = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
beforeEach(() => { sessionStorage.clear(); seam.actor = 'ACTOR'; seam.token = 'token-A'; seam.endpoint = 'http://card-fixture.invalid/api'; seam.grants = ['products:read', 'sample:room:write']; seam.ceiling = [...seam.grants]; seam.listeners.clear(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn(async () => response(page()))); });
afterEach(() => vi.unstubAllGlobals());
const noPost = () => expect(vi.mocked(fetch).mock.calls.every(c => (c[1] as any)?.method !== 'POST')).toBe(true);
it('accurate source absent is an explicit blocked target, not invented zero inventory or an alternate create route', async () => { expect((await service.receivedCards('S')).targetEligibility).toEqual({ eligible: false, reasons: ['NO_EXACT_ORIGIN'] }); noPost(); });
it.each([{}, { ...page(), readerVersion: 0 }, { ...page(), anchorSampleId: 'OTHER' }, { ...page(), queryMode: 'legacy-room' }, { ...page(), pagination: { limit: 200, cursor: null } }, { ...page(), hasMore: true, nextCursor: 'C' }])('old or misanchored reader cannot substitute for the full capability: %j', async body => { vi.mocked(fetch).mockResolvedValue(response(body) as any); await expect(service.receivedCards('S')).rejects.toThrow(); noPost(); });
it.each([403, 404, 500])('HTTP %i never triggers a fallback POST', async status => { vi.mocked(fetch).mockResolvedValue(response({ error: { code: 'UNAVAILABLE', message: '不可读取' } }, status) as any); await expect(service.receivedCards('S')).rejects.toThrow('不可读取'); expect(fetch).toHaveBeenCalledTimes(1); noPost(); });
it('read-only grant can inspect the same Sample legacy/terminal review without promoting proof', async () => { seam.grants = ['products:read']; seam.ceiling = ['products:read']; vi.mocked(fetch).mockResolvedValue(response(review()) as any); expect((await service.linkedReview('S')).items[0]).toMatchObject({ receiptStatus: 'manual', card: { status: 'retired', quantity: 3 }, linkEligibility: { eligible: false } }); noPost(); });
it.each(['foreign-sample', 'resolved-lane', 'write-token', 'wrong-loan'])('review rejects %s instead of exposing another subject or inferred facts', async kind => { const r = review(); const x = r.items[0]; if (kind === 'foreign-sample') x.card.sampleId = 'OTHER'; if (kind === 'resolved-lane') Object.assign(x.businessContext, { status: 'resolved', businessLine: 'fabric' }); if (kind === 'write-token') x.linkEligibility.eligible = true; if (kind === 'wrong-loan') x.activeLoans[0].loanQuantity = 1.5; vi.mocked(fetch).mockResolvedValue(response(r) as any); await expect(service.linkedReview('S')).rejects.toThrow(); noPost(); });
it.each(['actor', 'token', 'ceiling', 'endpoint'])('permanent %s ABA fence rejects late reads after values return', async kind => { let finish!: (r: any) => void; vi.mocked(fetch).mockImplementation(() => new Promise(r => { finish = r; })); const old = service.receivedCards('S'); if (kind === 'actor') { seam.actor = 'OTHER'; seam.listeners.forEach(f => f()); seam.actor = 'ACTOR'; } if (kind === 'token') { seam.token = 'token-B'; window.dispatchEvent(new Event('storage')); seam.token = 'token-A'; } if (kind === 'ceiling') { seam.ceiling = []; seam.listeners.forEach(f => f()); seam.ceiling = [...seam.grants]; } if (kind === 'endpoint') { seam.endpoint = 'http://other.invalid/api'; window.dispatchEvent(new Event('bambook:email-context-changed')); seam.endpoint = 'http://card-fixture.invalid/api'; } seam.listeners.forEach(f => f()); finish(response(page())); await expect(old).rejects.toThrow(); noPost(); });
it('caller target ticket is checked before a transport starts', async () => { await expect(service.receivedCards('S', {}, { current: () => false })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
it('no current read grant means zero requests, regardless of a prior namespace', async () => { seam.grants = []; await expect(service.receivedCards('S')).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
it('immutable intent cannot replace tokens, target or original stock hash under the same key', () => { const p = pending(); savePendingCardSampleLink(p); for (const next of [{ ...p, command: { ...p.command, targetSampleId: 'OTHER' } }, { ...p, command: { ...p.command, expectedCardUpdatedAt: '11' } }, { ...p, preservedCardHash: 'b'.repeat(64) }]) expect(() => savePendingCardSampleLink(next)).toThrow(); expect(readPendingCardSampleLink()).toEqual(p); expect(sessionStorage.getItem(cardLinkNamespace().key)).not.toContain(seam.token); });
it('corrupt command hints stay blocked and are not silently deleted', () => { const n = cardLinkNamespace(); sessionStorage.setItem(n.key, '{broken'); expect(() => readPendingCardSampleLink()).toThrow(); expect(sessionStorage.getItem(n.key)).toBe('{broken'); });
it('lost-result recovery is a read even after Room write is revoked', async () => { const p = pending(); savePendingCardSampleLink(p); seam.grants = ['products:read']; seam.ceiling = ['products:read']; vi.mocked(fetch).mockResolvedValue(response({ ...protocol, state: 'not_confirmed', cardId: p.cardId, requestKey: p.command.requestKey, retryOriginalRequest: true }) as any); expect(await service.recover(p)).toEqual({ state: 'not_confirmed', retryOriginalRequest: true }); expect(readPendingCardSampleLink()).toEqual(p); noPost(); });
it('different actor cannot recover or post another namespace hint', async () => { const p = pending(); seam.actor = 'OTHER'; await expect(service.recover(p)).rejects.toThrow(); await expect(service.link(p)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); });
it('partial committed ACK never clears the stored immutable request', async () => { const p = pending(); savePendingCardSampleLink(p); vi.mocked(fetch).mockResolvedValue(response({ ...protocol, state: 'committed', ack: { cardId: 'C', targetSampleId: 'S' } }) as any); await expect(service.recover(p)).rejects.toThrow(); expect(readPendingCardSampleLink()).toEqual(p); noPost(); });

it.each(['loan-borrower', 'loan-date', 'warehouse-name', 'card-location', 'material-object'])('malformed consumed %s is rejected before React can render an object', async kind => {
  const data: any = review(), item = data.items[0];
  if (kind === 'loan-borrower') item.activeLoans[0].borrowerName = {};
  if (kind === 'loan-date') item.activeLoans[0].dueDate = {};
  if (kind === 'warehouse-name') item.links.warehouse = { id: 'W', name: {} };
  if (kind === 'card-location') item.card.location = {};
  if (kind === 'material-object') item.card.cardType = {};
  vi.mocked(fetch).mockResolvedValue(response(data) as any);
  await expect(service.linkedReview('S')).rejects.toThrow(); noPost();
});

it('actual producer exact reverse wire is usable without inventing tokens or source hashes', async () => {
  seam.actor = wire.actorId;
  vi.mocked(fetch).mockResolvedValue(response(structuredClone(wire.reverse20)) as any);
  const p = await service.receivedCards(wire.targetSampleId);
  expect(p.items[0].card.id).toBe(wire.cardId);
  expect(p.items[0].businessContext.businessLine).toBe('garment');
  expect(p.items[0].card.cardType).toBe('fabric'); noPost();
});

function actualProducerTransport(transform?: (body: any, url: URL, init: any) => any) {
  seam.actor = wire.actorId;
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => wire.input.requestKey });
  vi.mocked(fetch).mockImplementation(async (raw: any, init: any) => {
    const url = new URL(raw), path = url.pathname;
    let data: any;
    if (init?.method === 'POST') data = wire.success;
    else if (path.endsWith('/received-cards')) data = url.searchParams.get('limit') === '1' ? wire.reverse1 : wire.reverse20;
    else if (path.endsWith('/context')) data = wire.context;
    else if (path.endsWith('/candidates')) data = wire.candidates;
    else if (path.includes('/requests/')) data = wire.recoveryAfterReturn;
    else throw Error('Unexpected fixture route: ' + path);
    return response(transform ? await transform(structuredClone(data), url, init) : structuredClone(data)) as any;
  });
}
async function originalIntent() {
  const p = await service.receivedCards(wire.targetSampleId);
  return service.prepare(p.items[0], wire.targetSampleId);
}
const posts = () => vi.mocked(fetch).mock.calls.filter(c => (c[1] as any)?.method === 'POST');

it('actual producer continuous read → original intent → one exact POST validates full ACK and preserves borrowed stock', async () => {
  actualProducerTransport();
  const p = await originalIntent();
  expect(p.command).toEqual(wire.input); expect(readPendingCardSampleLink()).toEqual(p); noPost();
  const result = await service.link(p);
  expect(result.state).toBe('committed'); expect(result.ack.originalCard).toMatchObject({ quantity: 3, availableQty: 2, sampleId: wire.targetSampleId });
  expect(posts()).toHaveLength(1); expect(JSON.parse((posts()[0][1] as any).body)).toEqual(wire.input);
  expect(Object.keys(JSON.parse((posts()[0][1] as any).body))).toHaveLength(8);
  expect(readPendingCardSampleLink()).toEqual({ ...p, attempts: 1 });
});
it('lost ACK retains exact original intent; read-only recovery validates original stock 2 separately from returned current stock 3', async () => {
  actualProducerTransport((_data, _url, init) => { if (init?.method === 'POST') throw Error('Response lost after commit'); return _data; });
  const p = await originalIntent(); await expect(service.link(p)).rejects.toMatchObject({ uncertain: true });
  const stored = readPendingCardSampleLink()!; expect(stored.command).toEqual(wire.input); expect(stored.attempts).toBe(1);
  seam.grants = ['products:read']; seam.ceiling = [...seam.grants];
  const result = await service.recover(stored);
  expect(result.state).toBe('committed');
  if (result.state === 'committed') { expect(result.ack.originalCard.availableQty).toBe(2); expect(result.currentCard.availableQty).toBe(3); }
  expect(posts()).toHaveLength(1); expect(readPendingCardSampleLink()).toEqual(stored);
});
it('not-confirmed read never resubmits automatically; explicit retry keeps all eight immutable fields and the original key', async () => {
  let lost = true;
  actualProducerTransport((data, url, init) => {
    if (init?.method === 'POST' && lost) { lost = false; throw Error('Transport interrupted before an observable ACK'); }
    if (url.pathname.includes('/requests/')) return { ...protocol, state: 'not_confirmed', cardId: wire.cardId, requestKey: wire.input.requestKey, retryOriginalRequest: true };
    return data;
  });
  const p = await originalIntent(); await expect(service.link(p)).rejects.toMatchObject({ uncertain: true });
  const stored = readPendingCardSampleLink()!;
  expect((await service.recover(stored)).state).toBe('not_confirmed'); expect(posts()).toHaveLength(1);
  expect((await service.link(stored)).state).toBe('committed'); expect(posts()).toHaveLength(2);
  expect(posts().map(x => JSON.parse((x[1] as any).body))).toEqual([wire.input, wire.input]);
  expect(readPendingCardSampleLink()!.attempts).toBe(2);
});
it.each(['binding-hash', 'audit-proof', 'actor', 'original-stock', 'current-stock-object', 'current-stock-negative', 'current-stock-over-total', 'current-unit-object', 'target'])('actual producer %s corruption cannot be accepted as a committed ACK or erase original intent', async kind => {
  actualProducerTransport(); const p = await originalIntent();
  actualProducerTransport((data, url) => {
    if (!url.pathname.includes('/requests/')) return data;
    if (kind === 'binding-hash') data.ack.sourceBindings[0].sourceFingerprint = H;
    if (kind === 'audit-proof') delete data.ack.auditProof.binding;
    if (kind === 'actor') data.ack.actorId = 'OTHER';
    if (kind === 'original-stock') data.ack.originalCard.availableQty = 3;
    if (kind === 'current-stock-object') data.currentCard.availableQty = {};
    if (kind === 'current-stock-negative') data.currentCard.availableQty = -1;
    if (kind === 'current-stock-over-total') data.currentCard.availableQty = data.currentCard.quantity + 1;
    if (kind === 'current-unit-object') data.currentCard.unit = {};
    if (kind === 'target') data.currentSample.id = 'OTHER';
    return data;
  });
  await expect(service.recover(p)).rejects.toThrow(); expect(readPendingCardSampleLink()).toEqual(p); noPost();
});
it('fresh source CAS change rejects before POST and keeps the original immutable version', async () => {
  actualProducerTransport(); const p = await originalIntent();
  actualProducerTransport((data, url) => { if (url.pathname.endsWith('/context')) { data.card.updatedAt = '9999999999999'; data.expectedCardUpdatedAt = data.card.updatedAt; } return data; });
  await expect(service.link(p)).rejects.toThrow(); expect(readPendingCardSampleLink()).toEqual(p); noPost();
});
it('complete reverse capability missing on an otherwise old four-endpoint backend gives zero POST', async () => {
  actualProducerTransport(); const p = await originalIntent();
  vi.mocked(fetch).mockImplementation(async raw => new URL(String(raw)).pathname.endsWith('/received-cards') ? response({ error: { message: '新读取能力未安装' } }, 404) as any : response(structuredClone(wire.context)) as any);
  await expect(service.link(p)).rejects.toMatchObject({ status: 404 }); expect(readPendingCardSampleLink()).toEqual(p); noPost();
});
it('the exact current Sample may be beyond the first 100 candidates without selecting a different Sample', async () => {
  actualProducerTransport((data, url) => {
    if (url.pathname.endsWith('/candidates') && !url.searchParams.get('cursor')) {
      data.items = Array.from({ length: 100 }, (_, n) => ({ ...structuredClone(wire.candidates.items[0]), sample: { id: 'A' + String(n).padStart(3, '0') } }));
      data.hasMore = true; data.nextCursor = 'A099';
    }
    return data;
  });
  const p = await originalIntent(); expect(p.command.targetSampleId).toBe(wire.targetSampleId);
  expect((await service.link(p)).state).toBe('committed'); expect(posts()).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.filter(c => String(c[0]).includes('/candidates?')).some(c => String(c[0]).includes('cursor=A099'))).toBe(true);
});
it('products write without Room write cannot prepare or POST; read-only reverse still works', async () => {
  actualProducerTransport(); seam.grants = ['products:read', 'products:write']; seam.ceiling = [...seam.grants];
  const p = await service.receivedCards(wire.targetSampleId);
  await expect(service.prepare(p.items[0], wire.targetSampleId)).rejects.toMatchObject({ status: 403 });
  expect(readPendingCardSampleLink()).toBeNull(); noPost();
});
it.each(['actor', 'token', 'ceiling', 'endpoint'])('original command %s ABA during fresh source read gives zero POST and retains immutable intent', async kind => {
  actualProducerTransport(); const p = await originalIntent();
  let finish!: (v: any) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const old = service.link(p);
  if (kind === 'actor') { seam.actor = 'OTHER'; seam.listeners.forEach(f => f()); seam.actor = wire.actorId; }
  if (kind === 'token') { seam.token = 'B'; window.dispatchEvent(new Event('storage')); seam.token = 'token-A'; }
  if (kind === 'ceiling') { seam.ceiling = []; seam.listeners.forEach(f => f()); seam.ceiling = [...seam.grants]; }
  if (kind === 'endpoint') { const e = seam.endpoint; seam.endpoint = 'http://other.invalid/api'; window.dispatchEvent(new Event('bambook:email-context-changed')); seam.endpoint = e; }
  seam.listeners.forEach(f => f()); finish(response(structuredClone(wire.reverse1)));
  await expect(old).rejects.toThrow(); expect(readPendingCardSampleLink()).toEqual(p); noPost();
});

it.each(nativeWire.wires.map(x => [x.family, x] as const))('unaltered native %s receipt/custody/binding/ACK is consumable without treating cardType as business line', async (family, w) => {
  seam.actor = w.actorId;
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => w.command.requestKey });
  vi.mocked(fetch).mockImplementation(async (raw: any, init: any) => {
    const url = new URL(raw), path = url.pathname;
    const data = init?.method === 'POST' ? w.linked : path.endsWith('/received-cards') ? { ...w.reverse, pagination: { ...w.reverse.pagination, limit: Number(url.searchParams.get('limit')) } } : path.endsWith('/context') ? w.context : path.endsWith('/candidates') ? w.candidates : w.recovered;
    return response(structuredClone(data)) as any;
  });
  const page = await service.receivedCards(w.sampleId); expect(page.items[0].businessContext.businessLine).toBe(family);
  const p = await service.prepare(page.items[0], w.sampleId); expect(p.command).toEqual(w.command);
  const linked = await service.link(p); expect(linked.ack.originalCard.availableQty).toBe(2);
  const recovered = await service.recover(readPendingCardSampleLink()!); expect(recovered.state).toBe('committed');
  if (recovered.state === 'committed') expect(recovered.currentCard.availableQty).toBe(3);
  expect(posts()).toHaveLength(1);
});
it('unaltered native same-Sample review with conflict and active dueAt loan is read-only, with no promotion to an exact source', async () => {
  const r = nativeWire.review; seam.actor = nativeWire.wires[0].actorId; seam.grants = ['products:read']; seam.ceiling = [...seam.grants];
  vi.mocked(fetch).mockResolvedValue(response(structuredClone(r)) as any);
  const page = await service.linkedReview(r.anchorSampleId);
  expect(page.items).toHaveLength(r.items.length); expect(page.items[0].businessContext.status).toBe('conflict');
  expect(page.items[0].activeLoans[0].dueAt).toBe(r.items[0].activeLoans[0].dueAt); noPost();
});

it('identity ABA while hashing the original stock cannot persist stale intent or POST after its token returns', async () => {
  actualProducerTransport(); const page = await service.receivedCards(wire.targetSampleId);
  let count = 0, finish: (() => void) | undefined;
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  vi.stubGlobal('crypto', { randomUUID: () => wire.input.requestKey, subtle: { digest: (algorithm: any, data: any) => {
    count++;
    if (count === 2) return new Promise<ArrayBuffer>((resolve, reject) => { finish = () => { digest(algorithm, data).then(resolve, reject); }; });
    return digest(algorithm, data);
  } } });
  const old = service.prepare(page.items[0], wire.targetSampleId);
  await vi.waitFor(() => expect(finish).toBeTruthy());
  seam.token = 'B'; window.dispatchEvent(new Event('storage')); seam.token = 'token-A'; seam.listeners.forEach(f => f());
  finish!(); await expect(old).rejects.toThrow(); expect(readPendingCardSampleLink()).toBeNull(); noPost();
});

it('a partial candidate page cannot claim more and advance a cursor past an unreported full page', async () => {
  const r: any = structuredClone(wire.reverse20); r.hasMore = true; r.nextCursor = r.items[0].card.id;
  vi.mocked(fetch).mockResolvedValue(response(r) as any);
  await expect(service.receivedCards(wire.targetSampleId)).rejects.toThrow(); noPost();
});
it('a different original-stock baseline cannot clear the immutable hint despite matching its command key', () => {
  const p = pending(); savePendingCardSampleLink(p);
  clearPendingCardSampleLink({ ...p, preservedCardHash: 'b'.repeat(64) }); expect(readPendingCardSampleLink()).toEqual(p); noPost();
});

it.each(['reverse', 'review'])('legal unbounded display name on actual native %s stays readable without weakening subject code/ID', async mode => {
  const data: any = structuredClone(mode === 'reverse' ? wire.reverse20 : nativeWire.review);
  data.items[0].card.name = '  合法历史名称' + '长'.repeat(250) + '  ';
  vi.mocked(fetch).mockResolvedValue(response(data) as any);
  const p = mode === 'reverse' ? await service.receivedCards(data.anchorSampleId) : await service.linkedReview(data.anchorSampleId);
  expect(p.items[0].card.name).toBe(data.items[0].card.name); noPost();
});
it.each(['reverse', 'review'])('object-valued display name on actual native %s is rejected before React consumes it', async mode => {
  const data: any = structuredClone(mode === 'reverse' ? wire.reverse20 : nativeWire.review);
  data.items[0].card.name = {};
  vi.mocked(fetch).mockResolvedValue(response(data) as any);
  await expect(mode === 'reverse' ? service.receivedCards(data.anchorSampleId) : service.linkedReview(data.anchorSampleId)).rejects.toThrow(); noPost();
});
