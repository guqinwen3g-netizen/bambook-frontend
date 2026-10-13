import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import type { Shipment } from '../types';
import type { AuthState } from './authService';

const BASE = 'http://unit.invalid/api';
const BASE_OTHER = 'http://other-unit.invalid/api';
const OLD = { kind: 'physical', updatedAt: '9007199254740993123', allocationFingerprint: 'a'.repeat(64) };
const NEW = { ...OLD, updatedAt: '9007199254740993124', allocationFingerprint: 'b'.repeat(64) };
const input: Partial<Shipment> = { status: 'Shipped', atd: '2026-10-02', notes: '合成测试，不外发',
  carrierName: '合成运输方', portOfDischarge: 'TEST-PORT', billOfLadingNo: null };

const api = vi.hoisted(() => ({ getStoredConfig: vi.fn(), getAuthHeaders: vi.fn(), buildApiUrl: vi.fn() }));
const auth = vi.hoisted(() => ({ getAuthState: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: api }));
vi.mock('./authService', () => auth);

let shipmentService: typeof import('./shipmentService')['shipmentService'];
let currentAuth: AuthState;
type RecordedRequest = { url: string; method: string; body: any; headers: any };
type Reply = Response | Error | ((request: RecordedRequest) => Response | Promise<Response>);
const OPERATION = 'shipment:update:SH1';
function userSession(id = 'sales-a'): AuthState {
  return { isAuthenticated: true, isLoading: false, user: { id, displayName: 'Synthetic session', email: 'unit@example.invalid',
    roles: ['sales'], roleIds: ['role-sales'], permissions: ['orders:read', 'shipments:read', 'shipments:write'],
    permissionCeiling: ['orders:read', 'shipments:read', 'shipments:write'], departmentIds: [], department: null } };
}
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(),
    getItem: key => values.get(String(key)) ?? null, setItem: (key, value) => { values.set(String(key), String(value)); },
    removeItem: key => { values.delete(String(key)); }, key: index => [...values.keys()][index] ?? null };
}
// Independent receipt producer: do not import the production canonical/hash
// helper. Native server authority, SQL facts and idempotent stock are not tested.
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function acknowledged(request: RecordedRequest, result?: any): any {
  const { requestKey, expectedShipmentUpdatedAt, expectedPhysicalAllocationFingerprint, ...submitted } = request.body;
  const patch = request.method === 'POST' ? {exportDeclarationCompletedAt:submitted.completedAt,
    exportDeclarationEvidenceDocumentId:submitted.evidenceDocumentId,exportDeclarationReference:submitted.reference || null} : submitted;
  const shipment = result ?? { id: 'SH1', ...patch };
  if (!requestKey) return { shipment };
  const command = { requestKey, expectedShipmentUpdatedAt, expectedPhysicalAllocationFingerprint,
    patch, actorId: request.headers['X-Unit-Actor'], shipmentId: 'SH1' };
  return { shipment: { ...shipment, acknowledgement: { schemaVersion: 1, command,
    commandHash: digest({ schemaVersion: 1, command }), shipmentHash: digest(shipment) } } };
}
async function pending(endpoint = BASE) {
  return (await import('./businessRequestRecovery')).readBusinessRequest<any>(OPERATION, endpoint);
}
function response(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}
function storage() {
  // Actual client session/recovery/receipt validation with substituted storage
  // and fetch. Re-import retains this browser-storage seam, not real browser
  // restart evidence; no native login, server authority or stock facts claimed.
  const requests: RecordedRequest[] = [], reads: Reply[] = [], writes: Reply[] = [];
  const current = { context: OLD };
  const fetch = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = String(raw), method = init?.method ?? 'GET';
    const recorded = { url, method, headers: { ...init?.headers }, body: init?.body ? JSON.parse(String(init.body)) : null };
    requests.push(recorded);
    if (method === 'GET' && url.endsWith('/v1/shipping/SH1/physical-context')) {
      const next = reads.shift() ?? response(200, current.context);
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(recorded) : next;
    }
    if (method === 'PATCH' && url.endsWith('/v1/shipping/SH1') || method === 'POST' && url.endsWith('/v1/shipping/SH1/export-declaration-completion')) {
      const next = writes.shift() ?? response(200, acknowledged(recorded));
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(recorded) : next;
    }
    throw Error(`Unexpected native request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { current, requests, reads, writes, fetch,
    patches: () => requests.filter(request => request.method === 'PATCH'),
    contexts: () => requests.filter(request => request.method === 'GET') };
}
const rejected = (status: number) => response(status, { error: { code: status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT'
  : status === 503 ? 'AUTHORIZATION_UNAVAILABLE' : 'INVALID_INPUT', message: '明确拒绝本次请求' } });

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('crypto', { randomUUID, subtle: webcrypto.subtle });
  currentAuth = userSession();
  auth.getAuthState.mockImplementation(() => currentAuth);
  api.getStoredConfig.mockReturnValue({ cloudEndpoint: BASE });
  api.getAuthHeaders.mockImplementation(() => ({ 'Content-Type': 'application/json', 'X-Unit-Session': 'storage-seam',
    'X-Unit-Actor': currentAuth.user?.id }));
  api.buildApiUrl.mockImplementation((path: string, base: string) => `${base}${path}`);
  ({ shipmentService } = await import('./shipmentService'));
});
afterEach(() => vi.unstubAllGlobals());

describe('shipment update keeps native physical request parameters across unknown outcomes', () => {
  it('reads physical context first, then PATCHes exact string version/fingerprint/key and the complete input', async () => {
    const f = storage();
    const saved = await shipmentService.updateShipment('SH1', input);
    expect(f.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', `${BASE}/v1/shipping/SH1/physical-context`], ['PATCH', `${BASE}/v1/shipping/SH1`],
    ]);
    expect(f.patches()[0].body).toEqual({ ...input, requestKey: expect.any(String),
      expectedShipmentUpdatedAt: OLD.updatedAt, expectedPhysicalAllocationFingerprint: OLD.allocationFingerprint });
    expect(f.patches()[0].body.requestKey).toMatch(/^[a-f0-9-]{36}$/i);
    expect(f.requests.every(request => request.headers['X-Unit-Session'] === 'storage-seam')).toBe(true);
    expect(saved).toEqual({ id: 'SH1', ...input });
  });

  it('lost network result retries the complete original command without reading a newer context', async () => {
    const f = storage(); f.writes.push(new TypeError('network result unknown'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('network result unknown');
    f.current.context = NEW;
    await shipmentService.updateShipment('SH1', { ...input });
    expect(f.contexts()).toHaveLength(1);
    expect(f.patches()).toHaveLength(2);
    expect(f.patches()[1].body).toEqual(f.patches()[0].body);
  });

  it.each([500, 503])('HTTP %s retains the original key, complete parameters and version for retry', async status => {
    const f = storage(); f.writes.push(response(status, { error: { code: 'DEPENDENCY_CHECK_FAILED', message: '结果尚未核清' } }));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toMatchObject({ status });
    f.current.context = NEW;
    await shipmentService.updateShipment('SH1', input);
    expect(f.contexts()).toHaveLength(1);
    expect(f.patches()[1].body).toEqual(f.patches()[0].body);
  });

  it.each([200, 409, 503])('non-JSON HTTP %s keeps the original request instead of treating it as an acknowledged result', async status => {
    const f = storage(); f.writes.push({ ok: status === 200, status,
      json: vi.fn().mockRejectedValue(new SyntaxError('unreadable result')) } as unknown as Response);
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('返回未能读取');
    f.current.context = NEW;
    await shipmentService.updateShipment('SH1', input);
    expect(f.contexts()).toHaveLength(1);
    expect(f.patches()[1].body).toEqual(f.patches()[0].body);
  });

  it.each([400, 403, 409])('structured HTTP %s rejection permits a fresh version and a new key on a later attempt', async status => {
    const f = storage(); f.writes.push(rejected(status));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toMatchObject({ status });
    const original = f.patches()[0].body;
    f.current.context = NEW;
    await shipmentService.updateShipment('SH1', input);
    expect(f.contexts()).toHaveLength(2);
    expect(f.patches()[1].body).toEqual({ ...input, requestKey: expect.any(String),
      expectedShipmentUpdatedAt: NEW.updatedAt, expectedPhysicalAllocationFingerprint: NEW.allocationFingerprint });
    expect(f.patches()[1].body.requestKey).not.toBe(original.requestKey);
  });

  it('legacy context retains the original PATCH body with no physical protocol fields', async () => {
    const f = storage(); f.current.context = { ...OLD, kind: 'legacy' };
    await shipmentService.updateShipment('SH1', input);
    expect(f.patches()[0].body).toEqual(input);
    expect(f.requests.map(request => request.method)).toEqual(['GET', 'PATCH']);
  });

  it.each([403, 503])('failed physical context HTTP %s never falls back to an old PATCH', async status => {
    const f = storage(); f.reads.push(rejected(status));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toMatchObject({ status });
    expect(f.patches()).toHaveLength(0);
    expect(f.requests).toHaveLength(1);
    await shipmentService.updateShipment('SH1', input);
    expect(f.patches()).toHaveLength(1);
    expect(f.patches()[0].body.expectedPhysicalAllocationFingerprint).toBe(OLD.allocationFingerprint);
  });

  it('network failure reading scope creates no write and cannot select legacy behavior', async () => {
    const f = storage(); f.reads.push(new TypeError('context unavailable'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('context unavailable');
    expect(f.patches()).toHaveLength(0);
  });

  it.each([{ ...OLD, kind: 'unknown' }, { ...OLD, allocationFingerprint: null }])('malformed 200 physical context cannot become an old PATCH (%j)', async context => {
    const f = storage(); f.reads.push(response(200, context));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('运单当前范围不完整');
    expect(f.patches()).toHaveLength(0);
  });

  it('the original parameter identity survives harmless top-level object key ordering', async () => {
    const f = storage(); f.writes.push(new TypeError('unknown result'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('unknown result');
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as Partial<Shipment>;
    await shipmentService.updateShipment('SH1', reordered);
    expect(f.contexts()).toHaveLength(1);
    expect(f.patches()[1].body).toEqual(f.patches()[0].body);
  });

  it('another endpoint cannot reuse the pending original endpoint command', async () => {
    const f = storage(); f.writes.push(new TypeError('unknown result'));
    await expect(shipmentService.updateShipment('SH1', input, BASE)).rejects.toThrow('unknown result');
    await shipmentService.updateShipment('SH1', input, BASE_OTHER);
    expect(f.contexts().map(request => request.url)).toEqual([`${BASE}/v1/shipping/SH1/physical-context`, `${BASE_OTHER}/v1/shipping/SH1/physical-context`]);
    expect(f.patches()[1].body.requestKey).not.toBe(f.patches()[0].body.requestKey);
  });
});

describe('external declaration completion uses the native physical command contract', () => {
  const declaration = {completedAt:'2026-10-07T01:00:00.000Z',evidenceDocumentId:'PROOF-1',reference:'EXT-1'};
  const operation='shipment:export-declaration:SH1';
  it('retains the exact POST key and original physical context after an unknown outcome', async () => {
    const f=storage(); f.writes.push(new TypeError('completion response lost'));
    await expect(shipmentService.completeExportDeclaration('SH1',declaration)).rejects.toThrow('response lost');
    const recover = (await import('./businessRequestRecovery')).readBusinessRequest;
    const pendingBefore = recover(operation,BASE);
    f.current.context=NEW;
    const saved=await shipmentService.completeExportDeclaration('SH1',declaration);
    expect(saved).toMatchObject({id:'SH1',exportDeclarationEvidenceDocumentId:'PROOF-1',exportDeclarationReference:'EXT-1'});
    const posts=f.requests.filter(row=>row.method==='POST');
    expect(posts).toHaveLength(2); expect(posts[1].body).toEqual(posts[0].body);
    expect(posts[0].body).toEqual({...declaration,requestKey:pendingBefore!.requestId,
      expectedShipmentUpdatedAt:OLD.updatedAt,expectedPhysicalAllocationFingerprint:OLD.allocationFingerprint});
    expect(f.contexts()).toHaveLength(1); expect(recover(operation,BASE)).toBeNull();
  });
  it('cannot acknowledge a validly hashed receipt for a different proof document', async () => {
    const f=storage(); f.writes.push(record=>{
      const body=acknowledged(record),ack=body.shipment.acknowledgement;
      ack.command.patch.exportDeclarationEvidenceDocumentId='PROOF-OTHER';
      ack.commandHash=digest({schemaVersion:1,command:ack.command});
      return response(200,body);
    });
    await expect(shipmentService.completeExportDeclaration('SH1',declaration)).rejects.toThrow();
    const pending=(await import('./businessRequestRecovery')).readBusinessRequest(operation,BASE);
    expect(pending).not.toBeNull();
    expect(f.requests.filter(row=>row.method==='POST')).toHaveLength(1);
  });
});

describe('shipment physical durable recovery and exact acknowledgement controls', () => {
  it('re-import after an unknown result restores the original key, input and context from storage', async () => {
    const f = storage(); f.writes.push(new TypeError('lost acknowledgement'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('lost acknowledgement');
    const original = await pending();
    expect(original).toEqual({ version: 1, requestId: f.patches()[0].body.requestKey, payload: { input, context: OLD } });
    vi.resetModules(); ({ shipmentService } = await import('./shipmentService'));
    f.current.context = NEW;
    await shipmentService.updateShipment('SH1', { ...input });
    expect(f.contexts()).toHaveLength(1); expect(f.patches()).toHaveLength(2);
    expect(f.patches()[1].body).toEqual(f.patches()[0].body);
    expect(await pending()).toBeNull();
  });

  it('a different actual actor has a different request and cannot clear the original actors intent', async () => {
    const f = storage(); f.writes.push(new TypeError('actor A unknown'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('actor A unknown');
    const original = await pending(); currentAuth = userSession('sales-b');
    await shipmentService.updateShipment('SH1', input);
    expect(f.patches()[1].body.requestKey).not.toBe(original!.requestId);
    expect(f.patches()[1].headers['X-Unit-Actor']).toBe('sales-b'); expect(await pending()).toBeNull();
    currentAuth = userSession(); expect(await pending()).toEqual(original);
  });

  it('a second explicit endpoint acknowledges only its own key while the original endpoint stays unresolved', async () => {
    const f = storage(); f.writes.push(new TypeError('endpoint A unknown'));
    await expect(shipmentService.updateShipment('SH1', input, BASE)).rejects.toThrow('endpoint A unknown');
    const original = await pending(BASE);
    await shipmentService.updateShipment('SH1', input, BASE_OTHER);
    expect(f.patches()[1].body.requestKey).not.toBe(original!.requestId);
    expect(await pending(BASE_OTHER)).toBeNull(); expect(await pending(BASE)).toEqual(original);
  });

  it('different input after an unknown result makes zero new requests and preserves the complete original intent', async () => {
    const f = storage(); f.writes.push(new TypeError('unknown'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('unknown');
    const original = await pending(), count = f.requests.length;
    await expect(shipmentService.updateShipment('SH1', { ...input, notes: 'changed after unknown' })).rejects.toThrow('恢复原内容');
    expect(f.requests).toHaveLength(count); expect(await pending()).toEqual(original);
  });

  it.each([
    ['missing receipt', (body: any) => { delete body.shipment.acknowledgement; }],
    ['wrong schema version', (body: any) => { body.shipment.acknowledgement.schemaVersion = 2; }],
    ['different request key', (body: any) => { body.shipment.acknowledgement.command.requestKey = randomUUID(); }],
    ['different original revision', (body: any) => { body.shipment.acknowledgement.command.expectedShipmentUpdatedAt = NEW.updatedAt; }],
    ['different physical fingerprint', (body: any) => { body.shipment.acknowledgement.command.expectedPhysicalAllocationFingerprint = NEW.allocationFingerprint; }],
    ['different original patch', (body: any) => { body.shipment.acknowledgement.command.patch.notes = 'foreign intent'; }],
    ['different actor', (body: any) => { body.shipment.acknowledgement.command.actorId = 'sales-b'; }],
    ['different shipment parent', (body: any) => { body.shipment.acknowledgement.command.shipmentId = 'SH2'; }],
    ['incorrect command hash', (body: any) => { body.shipment.acknowledgement.commandHash = 'c'.repeat(64); }],
    ['incorrect result hash', (body: any) => { body.shipment.acknowledgement.shipmentHash = 'd'.repeat(64); }],
    ['wrong result identity', (body: any) => { body.shipment.id = 'SH2'; }],
    ['changed result under an old hash', (body: any) => { body.shipment.notes = 'unproven result'; }],
  ] as const)('JSON 2xx with %s cannot clear an original command or create a fresh key', async (_name, damage) => {
    const f = storage(); f.writes.push(record => {
      const body = acknowledged(record); damage(body);
      // A well-formed hash over a foreign command still cannot bind the original
      // input/actor/parent. These are independent identity checks, not hash-only.
      if (!['incorrect command hash', 'incorrect result hash', 'changed result under an old hash'].includes(_name)) {
        const receipt = body.shipment.acknowledgement;
        if (receipt) receipt.commandHash = digest({ schemaVersion: receipt.schemaVersion, command: receipt.command });
        const { acknowledgement: _receipt, ...result } = body.shipment;
        if (receipt) receipt.shipmentHash = digest(result);
      }
      return response(200, body);
    });
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('结果尚未确认');
    const original = await pending(); expect(original!.requestId).toBe(f.patches()[0].body.requestKey);
    f.current.context = NEW;
    await shipmentService.updateShipment('SH1', input);
    expect(f.contexts()).toHaveLength(1); expect(f.patches()[1].body).toEqual(f.patches()[0].body);
    expect(await pending()).toBeNull();
  });

  it('a server-normalized result validates against the original raw transport input without losing its intent', async () => {
    const f = storage(), raw = { ...input, shippingMethod: 'Sea Freight' };
    f.writes.push(record => response(200, acknowledged(record, { id: 'SH1', ...raw, shippingMethod: 'Sea' })));
    const saved = await shipmentService.updateShipment('SH1', raw);
    expect(f.patches()[0].body.shippingMethod).toBe('Sea Freight'); expect(saved.shippingMethod).toBe('Sea');
    expect(await pending()).toBeNull();
  });

  it.each(['actor', 'headers', 'roles', 'permissions', 'ceiling'] as const)('a %s change during the context read cannot send an old-session PATCH', async change => {
    const f = storage(); f.reads.push(() => {
      if (change === 'actor') currentAuth = userSession('sales-b');
      if (change === 'headers') api.getAuthHeaders.mockReturnValue({ 'Content-Type': 'application/json', 'X-Unit-Session': 'rotated-session', 'X-Unit-Actor': 'sales-a' });
      if (change === 'roles') currentAuth.user!.roles = ['viewer'];
      if (change === 'permissions') currentAuth.user!.permissions = ['shipments:read'];
      if (change === 'ceiling') currentAuth.user!.permissionCeiling = [];
      return response(200, OLD);
    });
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('已变化');
    expect(f.patches()).toHaveLength(0); expect(localStorage.length).toBe(0);
  });

  it('changing the default endpoint during a context read cannot send a PATCH authorized for the previous endpoint', async () => {
    const f = storage(); f.reads.push(() => {
      api.getStoredConfig.mockReturnValue({ cloudEndpoint: BASE_OTHER }); return response(200, OLD);
    });
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('已变化');
    expect(f.patches()).toHaveLength(0); expect(localStorage.length).toBe(0);
  });

  it.each(['actor', 'headers', 'roles', 'permissions', 'ceiling'] as const)('a %s change while the PATCH response is pending cannot clear the original intent', async change => {
    const f = storage(); f.writes.push(record => {
      const body = acknowledged(record);
      if (change === 'actor') currentAuth = userSession('sales-b');
      if (change === 'headers') api.getAuthHeaders.mockReturnValue({ 'Content-Type': 'application/json', 'X-Unit-Session': 'rotated-session', 'X-Unit-Actor': 'sales-a' });
      if (change === 'roles') currentAuth.user!.roles = ['viewer'];
      if (change === 'permissions') currentAuth.user!.permissions = ['shipments:read'];
      if (change === 'ceiling') currentAuth.user!.permissionCeiling = [];
      return response(200, body);
    });
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('已变化');
    expect(f.patches()).toHaveLength(1);
    currentAuth = userSession(); expect((await pending())!.requestId).toBe(f.patches()[0].body.requestKey);
  });

  it('changing the default endpoint while awaiting a PATCH receipt cannot acknowledge the previous endpoint intent', async () => {
    const f = storage(); f.writes.push(record => {
      api.getStoredConfig.mockReturnValue({ cloudEndpoint: BASE_OTHER }); return response(200, acknowledged(record));
    });
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('已变化');
    expect(f.patches()).toHaveLength(1); expect((await pending(BASE))!.requestId).toBe(f.patches()[0].body.requestKey);
    expect(await pending(BASE_OTHER)).toBeNull();
  });

  it('a late actor A receipt cannot clear either actor Bs unknown request or actor As original request', async () => {
    const f = storage(); let release!: (result: Response) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.writes.push(record => new Promise<Response>(resolve => { release = result => resolve(result); entered(); }));
    const late = shipmentService.updateShipment('SH1', input); const lateRejected = expect(late).rejects.toThrow('已变化');
    await started; const originalRequest = f.patches()[0]; const original = await pending();
    currentAuth = userSession('sales-b'); f.writes.push(new TypeError('actor B unknown'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('actor B unknown');
    const other = await pending(); expect(other!.requestId).not.toBe(original!.requestId);
    release(response(200, acknowledged(originalRequest))); await lateRejected;
    expect(await pending()).toEqual(other); currentAuth = userSession(); expect(await pending()).toEqual(original);
    await shipmentService.updateShipment('SH1', input); expect(await pending()).toBeNull();
    currentAuth = userSession('sales-b'); expect(await pending()).toEqual(other);
  });

  it('a revoked permission rejection after an unknown result preserves the original key until an exact acknowledgement', async () => {
    const f = storage(); f.writes.push(new TypeError('original outcome unknown'));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('original outcome unknown');
    const original = await pending(); currentAuth.user!.permissions = ['shipments:read']; currentAuth.user!.permissionCeiling = ['shipments:read'];
    f.writes.push(rejected(403));
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toMatchObject({ status: 403 });
    expect(await pending()).toEqual(original); expect(f.patches()[1].body).toEqual(f.patches()[0].body); expect(f.contexts()).toHaveLength(1);
    currentAuth = userSession(); await shipmentService.updateShipment('SH1', input);
    expect(f.patches()[2].body).toEqual(f.patches()[0].body); expect(await pending()).toBeNull();
  });

  it.each(['anonymous', 'not authenticated'] as const)('%s cannot read a context, allocate a key or submit a PATCH', async mode => {
    const f = storage(); if (mode === 'anonymous') currentAuth.user = null; else currentAuth.isAuthenticated = false;
    await expect(shipmentService.updateShipment('SH1', input)).rejects.toThrow('重新登录');
    expect(f.requests).toHaveLength(0); expect(localStorage.length).toBe(0);
  });
});
