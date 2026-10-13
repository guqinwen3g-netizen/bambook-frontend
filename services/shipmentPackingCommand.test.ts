import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
const api = vi.hoisted(() => ({ getStoredConfig: vi.fn(), getAuthHeaders: vi.fn(), buildApiUrl: vi.fn() }));
const auth = vi.hoisted(() => ({ getAuthState: vi.fn(), subscribe: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('./apiService', () => ({ apiService: api })); vi.mock('./authService', () => auth);
const BASE = 'https://packing.invalid/api', ctx: any = { kind: 'legacy', updatedAt: '9007199254740993', allocationFingerprint: 'a'.repeat(64) };
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = (v: any) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const payload: any = { lines: [{ clientLineKey: 'draft-original', orderLineId: 'OL1', productCode: null, productName: 'Original', colorCode: 'red', quantity: '90071992547409.1234', unit: 'M', cartons: 1, grossWeight: null, netWeight: null, volume: null, hsCode: 'HS', countryOfOrigin: 'CN' }], cartons: [{ cartonNo: 'B1', description: null, length: null, width: null, height: null, grossWeight: null, netWeight: null, volume: null, items: [{ lineKey: 'draft-original', quantity: '90071992547409.1234' }] }] };
let user: any, service: typeof import('./shipmentService')['shipmentService'];
function session(id = 'U1') { return { isAuthenticated: true, isLoading: false, user: { id, roles: ['logistics'], permissions: ['orders:read', 'shipments:read', 'shipments:write'] } }; }
function storage(): Storage { const map = new Map<string, string>(); return { get length() { return map.size; }, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: k => { map.delete(k); }, clear: () => map.clear(), key: i => [...map.keys()][i] ?? null }; }
function response(status: number, body: any): any { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function command(body: any) { return { ...body, actorId: 'U1', shipmentId: 'SH1' }; }
// Independent transport receipt producer; no server eligibility/auth claim.
function ack(body: any): any {
  const result: any = { shipment: { id: 'SH1', status: 'Booked', updatedAt: '9007199254740994' },
    lines: body.lines.map(({ clientLineKey, ...line }: any, i: number) => ({ ...line, id: `LINE${i}`, shipmentId: 'SH1', lineNumber: i + 1 })),
    cartons: body.cartons.map((carton: any, i: number) => ({ ...carton, id: `BOX${i}`, shipmentId: 'SH1', items: carton.items.map((item: any, j: number) => ({ id: `ITEM${i}_${j}`, cartonId: `BOX${i}`, shipmentLineId: `LINE${body.lines.findIndex((line: any) => line.clientLineKey === item.lineKey)}`, quantity: item.quantity })) })) };
  return { ...result, replayed: false, acknowledgement: { schemaVersion: 1, command: command(body), commandHash: hash({ schemaVersion: 1, command: command(body) }), resultHash: hash(result) } };
}
function seam() {
  const requests: any[] = [], writes: Array<(body: any) => any> = [], reads: Array<() => any> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any = {}) => { const body = init.body ? JSON.parse(init.body) : null; requests.push({ method: init.method ?? 'GET', body }); return init.method === 'PUT' ? await (writes.shift() ?? ((b: any) => response(200, ack(b))))(body) : await (reads.shift() ?? (() => response(200, { shipment: { id: 'SH1' }, context: ctx, lines: [], cartons: [], sources: [] })))(); }));
  return { requests, writes, reads, puts: () => requests.filter(r => r.method === 'PUT') };
}
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); auth.listeners.clear(); auth.subscribe.mockImplementation((fn: () => void) => { auth.listeners.add(fn); return () => auth.listeners.delete(fn); }); user = session(); auth.getAuthState.mockImplementation(() => user);
  api.getStoredConfig.mockReturnValue({ cloudEndpoint: BASE }); api.getAuthHeaders.mockImplementation(() => ({ Authorization: `Bearer ${user.user.id}${user.user.tokenMarker ?? ''}` })); api.buildApiUrl.mockImplementation((path: string, base: string) => base + path);
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('crypto', { randomUUID, subtle: webcrypto.subtle }); ({ shipmentService: service } = await import('./shipmentService'));
}); afterEach(() => vi.unstubAllGlobals());
describe('packing client original-intent recovery and fact-bound ACK', () => {
  it('sends one aggregate PUT preserving full exact fields and clears intent only after matching facts', async () => {
    const f = seam(), result = await service.submitShipmentPacking('SH1', payload, ctx);
    expect(f.requests).toHaveLength(1); expect(f.puts()[0].body).toEqual({ ...payload, requestKey: expect.any(String), expectedShipmentUpdatedAt: ctx.updatedAt, expectedPhysicalAllocationFingerprint: ctx.allocationFingerprint });
    expect(result.lines[0].quantity).toBe('90071992547409.1234'); expect(service.readPendingPacking('SH1')).toBeNull();
  });
  it('write applied but response lost replays the identical key/payload/version and only one synthetic transport fact', async () => {
    const f = seam(), receipts = new Map<string, any>(); let facts = 0;
    const producer = (body: any) => { if (!receipts.has(body.requestKey)) { receipts.set(body.requestKey, ack(body)); facts++; } return receipts.get(body.requestKey); };
    f.writes.push(body => { producer(body); throw Error('lost result'); }, body => response(200, { ...producer(body), replayed: true }));
    await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toThrow('lost result'); const pending = service.readPendingPacking('SH1')!;
    await service.retryPendingPacking('SH1', pending);
    expect(f.puts()[1].body).toEqual(f.puts()[0].body); expect(facts).toBe(1); expect(service.readPendingPacking('SH1')).toBeNull();
  });
  it('changed draft cannot replace an unknown original command or silently renew its version', async () => {
    const f = seam(); f.writes.push(() => { throw Error('unknown'); }); await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toThrow();
    const original = service.readPendingPacking('SH1'); await expect(service.submitShipmentPacking('SH1', { ...payload, cartons: [] }, { ...ctx, updatedAt: '99' })).rejects.toThrow('原装箱请求待确认');
    expect(f.puts()).toHaveLength(1); expect(service.readPendingPacking('SH1')).toEqual(original);
  });
  it.each([400, 403, 409, 500, 503])('ordinary HTTP %s never certifies historical absence or clears the original key', async status => {
    const f = seam(); f.writes.push(() => response(status, { error: { code: 'CONFLICT', message: 'refused' } }));
    await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toThrow('refused'); expect(service.readPendingPacking('SH1')?.requestId).toBe(f.puts()[0].body.requestKey);
  });
  it('only exact bound not_committed refusal unlocks the draft; a subsequent edit uses a fresh original key', async () => {
    const f = seam(); f.writes.push(body => response(409, { error: { code: 'CONFLICT', message: 'source changed' }, rejection: { schemaVersion: 1, outcome: 'not_committed', command: command(body), commandHash: hash({ schemaVersion: 1, command: command(body) }), code: 'CONFLICT', shipmentVersion: '20', sourceFingerprint: 'b'.repeat(64) } }));
    await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toMatchObject({ notCommitted: true }); expect(service.readPendingPacking('SH1')).toBeNull();
    await service.submitShipmentPacking('SH1', payload, ctx); expect(f.puts()[1].body.requestKey).not.toBe(f.puts()[0].body.requestKey);
  });
  it.each(['key', 'actor', 'hash', 'permission'])('damaged or unauthorized %s refusal retains the original intent', async kind => {
    const f = seam(); f.writes.push(body => { const c = command(body), refusal: any = { schemaVersion: 1, outcome: 'not_committed', command: c, commandHash: hash({ schemaVersion: 1, command: c }), code: 'CONFLICT', shipmentVersion: '20', sourceFingerprint: 'b'.repeat(64) };
      if (kind === 'key') refusal.command = { ...c, requestKey: 'another' }; if (kind === 'actor') refusal.command = { ...c, actorId: 'U2' }; if (kind === 'hash') refusal.commandHash = 'x'; if (kind === 'permission') refusal.code = 'FORBIDDEN';
      return response(409, { error: { code: refusal.code, message: 'refused' }, rejection: refusal }); });
    await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toThrow(); expect(service.readPendingPacking('SH1')).not.toBeNull();
  });
  it.each(['quantity', 'source', 'carton-reference', 'carton-field', 'duplicate-id', 'missing-audit-ack'])('invalid %s success cannot clear intent even if public result hash was recomputed', async kind => {
    const f = seam(); f.writes.push(body => { const data = ack(body); if (kind === 'quantity') data.lines[0].quantity = '90071992547409.1235'; if (kind === 'source') data.lines[0].orderLineId = 'OTHER'; if (kind === 'carton-reference') data.cartons[0].items[0].shipmentLineId = 'OTHER'; if (kind === 'carton-field') data.cartons[0].description = 'tampered'; if (kind === 'duplicate-id') { data.lines.push({ ...data.lines[0] }); } if (kind === 'missing-audit-ack') delete data.acknowledgement;
      if (data.acknowledgement) data.acknowledgement.resultHash = hash({ shipment: data.shipment, lines: data.lines, cartons: data.cartons }); return response(200, data); });
    await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toThrow('持久回执'); expect(service.readPendingPacking('SH1')).not.toBeNull();
  });
  it.each([['0.006', true], ['0.0061', false]])('checks native four-place derived volume %s against the original exact dimensions', async (volume, accepted) => {
    const f = seam(), input = { ...payload, cartons: [{ ...payload.cartons[0], length: '10.01', width: '20', height: '30' }] };
    f.writes.push(body => { const data = ack(body); data.cartons[0].volume = volume; data.acknowledgement.resultHash = hash({ shipment: data.shipment, lines: data.lines, cartons: data.cartons }); return response(200, data); });
    if (accepted) { expect((await service.submitShipmentPacking('SH1', input, ctx)).cartons[0].volume).toBe(volume); expect(service.readPendingPacking('SH1')).toBeNull(); }
    else { await expect(service.submitShipmentPacking('SH1', input, ctx)).rejects.toThrow('持久回执'); expect(service.readPendingPacking('SH1')).not.toBeNull(); }
  });
  it('account change while success is slow does not apply ACK to another account or retire old intent', async () => {
    const f = seam(); let finish!: (response: any) => void; f.writes.push(() => new Promise(resolve => { finish = resolve; }));
    const saving = service.submitShipmentPacking('SH1', payload, ctx); await new Promise(resolve => setTimeout(resolve, 0)); const body = f.puts()[0].body; user = session('U2'); finish(response(200, ack(body)));
    await expect(saving).rejects.toThrow('账号'); expect(service.readPendingPacking('SH1')).toBeNull(); user = session(); expect(service.readPendingPacking('SH1')?.requestId).toBe(body.requestKey);
  });
  it('original intents are isolated by current account and endpoint', async () => {
    const f = seam(); f.writes.push(() => { throw Error('unknown'); }); await expect(service.submitShipmentPacking('SH1', payload, ctx)).rejects.toThrow();
    const original = service.readPendingPacking('SH1'); expect(service.readPendingPacking('SH1', 'https://other.invalid')).toBeNull(); user = session('U2'); expect(service.readPendingPacking('SH1')).toBeNull(); user = session(); expect(service.readPendingPacking('SH1')).toEqual(original);
  });
  it('snapshot quantities must be native exact strings; a rounded Number response cannot seed an editable draft', async () => {
    const f = seam(), responseBody = { shipment: { id: 'SH1', updatedAt: ctx.updatedAt }, context: ctx, lines: [{ id: 'L1', shipmentId: 'SH1', quantity: '90071992547409.1234', grossWeight: null, netWeight: null, volume: null }], cartons: [], sources: [] };
    f.reads.push(() => response(200, responseBody)); expect((await service.readShipmentPacking('SH1')).lines[0].quantity).toBe('90071992547409.1234');
    f.reads.push(() => response(200, { ...responseBody, lines: [{ ...responseBody.lines[0], quantity: Number(responseBody.lines[0].quantity) }] }));
    await expect(service.readShipmentPacking('SH1')).rejects.toThrow('快照暂不能完整核验'); expect(service.readPendingPacking('SH1')).toBeNull();
  });
  it('slow snapshot from an old account is rejected before any caller can apply its sources', async () => {
    const f = seam(); let finish!: (response: any) => void; f.reads.push(() => new Promise(resolve => { finish = resolve; })); const reading = service.readShipmentPacking('SH1'); await new Promise(resolve => setTimeout(resolve, 0)); user = session('U2'); finish(response(200, { shipment: { id: 'SH1' }, context: ctx, lines: [], cartons: [], sources: [] })); await expect(reading).rejects.toThrow('账号');
  });
});

describe('packing client notified identity and schema boundaries', () => {
  it.each(['account', 'token', 'endpoint', 'ceiling'])('notified %s ABA never clears the original pending intent for a delayed ACK', async mode => {
    const f = seam(); let finish!: (value: any) => void; f.writes.push(() => new Promise(resolve => { finish = resolve; }));
    const saving = service.submitShipmentPacking('SH1', payload, ctx); await new Promise(resolve => setTimeout(resolve, 0));
    const body = f.puts()[0].body, oldUser = user;
    if (mode === 'account') user = session('U2');
    if (mode === 'token') user = { ...oldUser, user: { ...oldUser.user, tokenMarker: 'ROTATED' } };
    if (mode === 'endpoint') api.getStoredConfig.mockReturnValue({ cloudEndpoint: 'https://other-packing.invalid' });
    if (mode === 'ceiling') user = { ...oldUser, user: { ...oldUser.user, permissionCeiling: [] } };
    auth.listeners.forEach(fn => fn()); user = oldUser; api.getStoredConfig.mockReturnValue({ cloudEndpoint: BASE }); auth.listeners.forEach(fn => fn()); finish(response(200, ack(body)));
    await expect(saving).rejects.toThrow('变化'); expect(service.readPendingPacking('SH1')?.requestId).toBe(body.requestKey);
    expect(f.puts()).toHaveLength(1); expect(auth.listeners.size).toBe(0);
  });
  it('invalid fourth-place line volume is rejected before a write or pending command and exact three places succeeds', async () => {
    const f = seam(), invalid = { ...payload, lines: [{ ...payload.lines[0], volume: '0.0001' }] };
    await expect(service.submitShipmentPacking('SH1', invalid, ctx)).rejects.toThrow('行体积'); expect(f.puts()).toHaveLength(0); expect(service.readPendingPacking('SH1')).toBeNull();
    expect((await service.submitShipmentPacking('SH1', { ...invalid, lines: [{ ...invalid.lines[0], volume: '0.001' }] }, ctx)).lines[0].volume).toBe('0.001');
  });
  it('a fourth-place line volume in a native snapshot cannot seed an editable draft', async () => {
    const f = seam(); f.reads.push(() => response(200, { shipment: { id: 'SH1', updatedAt: ctx.updatedAt }, context: ctx, lines: [{ id: 'L1', shipmentId: 'SH1', quantity: '1', grossWeight: null, netWeight: null, volume: '0.0001' }], cartons: [], sources: [] }));
    await expect(service.readShipmentPacking('SH1')).rejects.toThrow('快照暂不能完整核验');
  });
});
