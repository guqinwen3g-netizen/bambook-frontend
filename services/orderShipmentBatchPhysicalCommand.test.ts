// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { orderShipmentBatchService as batches } from './orderShipmentBatchService';

// Closed HTTP/localStorage/session seams. This proves client protocol handling,
// not native authorization, financial qualification or PostgreSQL transactions.
const account = vi.hoisted(() => ({ id: 'logistics-a', endpoint: 'http://batch.invalid/api', token: 'synthetic-token',
  grants: ['shipments:write', 'shipments:read', 'orders:read'], ceiling: undefined as string[] | undefined }));
vi.mock('./authService', () => ({
  getAuthState: () => ({ isAuthenticated: !!account.id, user: account.id ? { id: account.id, roles: ['logistics'],
    permissions: account.grants, permissionCeiling: account.ceiling } : null }),
  hasPermission: (scope: string) => account.grants.includes(scope) && (account.ceiling === undefined || account.ceiling.includes(scope)),
}));
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: account.endpoint }),
  buildApiUrl: (path: string, endpoint: string) => endpoint + path,
  getAuthHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + account.token }),
} }));
const sorted = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha = (value: unknown) => createHash('sha256').update(sorted(value)).digest('hex');
const response = (status: number, value: any) => new Response(JSON.stringify(value), { status });
const context = (extra: any = {}) => ({ ok: true, kind: 'physical', batchId: 'B1', orderId: 'O1', shipmentId: 'S1',
  expectedBatchUpdatedAt: '9007199254740993', expectedShipmentUpdatedAt: '9007199254740995',
  expectedPhysicalAllocationFingerprint: 'a'.repeat(64), ...extra });
const original = { shipmentId: 'S1', shippedAt: '1790890000000', skipGate: false, gateCoverRatio: 0.8 };
type Request = { method: string; url: string; body: any; headers: any };
let requests: Request[], read: () => Promise<Response>, write: (request: Request) => Promise<Response>;
function ack(request: Request, mutate: (data: any) => void = () => {}) {
  const batch = { id: 'B1', orderId: 'O1', shipmentId: 'S1', status: 'shipped', batchNo: 1,
    amount: '99999999999999.9999', plannedQty: '0', updatedAt: '9007199254740997' };
  const command = { schemaVersion: 1, actorId: account.id, batchId: 'B1', shipmentId: 'S1', input: request.body };
  const data: any = { ok: true, batch: { ...batch, acknowledgement: { schemaVersion: 1, command,
    commandHash: sha(command), batchHash: sha(batch) } } };
  mutate(data); return response(200, data);
}
function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const request = { url: String(url), method: init?.method ?? 'GET', headers: init?.headers,
      body: init?.body ? JSON.parse(String(init.body)) : null };
    requests.push(request);
    if (request.method === 'GET' && request.url.includes('/physical-context')) return read();
    if (request.method === 'POST' && request.url.endsWith('/mark-shipped')) return write(request);
    throw Error('Unexpected closed-seam request: ' + request.url);
  }));
}
const posts = () => requests.filter(request => request.method === 'POST');
const pending = () => batches.listPendingMarkShipped('O1');
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  account.id = 'logistics-a'; account.endpoint = 'http://batch.invalid/api'; account.token = 'synthetic-token';
  account.grants = ['shipments:write', 'shipments:read', 'orders:read']; account.ceiling = undefined;
  localStorage.clear(); requests = []; read = async () => response(200, context()); write = async request => ack(request);
  vi.stubGlobal('crypto', webcrypto); installFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('financial batch physical mark command — exact client receipt and recovery', () => {
  it('reads physical context, sends exact string versions/full input, independently verifies the frozen receipt', async () => {
    const row = await batches.markShipped('B1', original);
    expect(requests[0].url).toContain('/B1/physical-context?shipmentId=S1');
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ ...original, requestKey: expect.any(String), expectedBatchUpdatedAt: '9007199254740993',
      expectedShipmentUpdatedAt: '9007199254740995', expectedPhysicalAllocationFingerprint: 'a'.repeat(64) });
    expect(row.amount).toBe('99999999999999.9999'); expect(pending()).toEqual([]);
  });
  it('only explicit legacy context permits the original body and requires the actual shipped batch identity', async () => {
    read = async () => response(200, context({ kind: 'legacy', expectedPhysicalAllocationFingerprint: null }));
    write = async () => response(200, { ok: true, batch: { id: 'B1', status: 'shipped' } });
    await batches.markShipped('B1', original);
    expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
    expect(posts()[0].body).toEqual(original); expect(pending()).toEqual([]);
  });
  it.each([403, 409, 500, 503])('context HTTP %s performs zero POST and never falls back to legacy', async status => {
    read = async () => response(status, { error: { code: 'READ_FAILED', message: 'Synthetic read failed' } });
    await expect(batches.markShipped('B1', original)).rejects.toMatchObject({ status });
    expect(posts()).toEqual([]); expect(pending()).toEqual([]);
  });
  it.each([
    { ok: false }, { kind: 'unknown' }, { batchId: 'OTHER' }, { shipmentId: 'OTHER' },
    { expectedBatchUpdatedAt: 9007199254740992 }, { expectedShipmentUpdatedAt: null },
    { expectedPhysicalAllocationFingerprint: null },
  ])('malformed context %j performs zero POST', async damage => {
    read = async () => response(200, context(damage));
    await expect(batches.markShipped('B1', original)).rejects.toThrow(); expect(posts()).toEqual([]);
  });
  it.each([{ id: 'FOREIGN', status: 'shipped' }, { id: 'B1', status: 'planned' }])('legacy cannot accept unrelated or unconfirmed result %j', async batch => {
    read = async () => response(200, context({ kind: 'legacy', expectedPhysicalAllocationFingerprint: null }));
    write = async () => response(200, { ok: true, batch });
    await expect(batches.markShipped('B1', original)).rejects.toThrow('回执'); expect(posts()).toHaveLength(1);
  });
  it('corrupted persisted source cannot be silently discarded as no pending request', async () => {
    write = async () => { throw Error('Lost ACK'); }; await expect(batches.markShipped('B1', original)).rejects.toThrow();
    const key = localStorage.key(0)!, value = JSON.parse(localStorage.getItem(key)!); delete value.payload.context;
    localStorage.setItem(key, JSON.stringify(value));
    expect(() => pending()).toThrow('记录不完整');
    await expect(batches.markShipped('B1', original)).rejects.toThrow('记录不完整'); expect(posts()).toHaveLength(1);
    expect(localStorage.getItem(key)).not.toBeNull();
  });
  it('lost acknowledgement survives module reload and retries exactly the original key/body without refreshing context', async () => {
    write = async () => { throw Error('Synthetic lost acknowledgement'); };
    await expect(batches.markShipped('B1', original)).rejects.toThrow('lost acknowledgement');
    const first = posts()[0].body, retained = pending()[0];
    read = async () => { throw Error('Never replace original context'); }; write = async request => ack(request);
    vi.resetModules(); const reloaded = (await import('./orderShipmentBatchService')).orderShipmentBatchService;
    await reloaded.retryPendingMarkShipped(retained);
    expect(posts()).toHaveLength(2); expect(posts()[1].body).toEqual(first); expect(pending()).toEqual([]);
  });
  it.each([500, 503])('HTTP %s keeps the original unknown key and complete command', async status => {
    write = async () => response(status, { error: { code: 'FAILURE', message: 'Synthetic failure' } });
    await expect(batches.markShipped('B1', original)).rejects.toMatchObject({ status });
    const retained = pending()[0]; await expect(batches.markShipped('B1', original)).rejects.toThrow();
    expect(pending()[0]).toEqual(retained); expect(posts()[1].body).toEqual(posts()[0].body);
  });
  it.each([400, 403, 409])('fresh structured HTTP %s can finish that attempt, allowing a new key and version', async status => {
    write = async () => response(status, { error: { code: 'CONFLICT', message: 'Synthetic refusal' } });
    await expect(batches.markShipped('B1', original)).rejects.toMatchObject({ status }); expect(pending()).toEqual([]);
    const first = posts()[0].body; read = async () => response(200, context({ expectedBatchUpdatedAt: '9007199254740999' }));
    write = async request => ack(request); await batches.markShipped('B1', original);
    expect(posts()[1].body.requestKey).not.toBe(first.requestKey);
    expect(posts()[1].body.expectedBatchUpdatedAt).toBe('9007199254740999');
  });
  it.each([400, 403, 409])('HTTP %s after an earlier unknown never clears the original request', async status => {
    write = async () => { throw Error('Lost ACK'); }; await expect(batches.markShipped('B1', original)).rejects.toThrow();
    const retained = pending()[0]; write = async () => response(status, { error: { code: 'CONFLICT', message: 'Synthetic refusal' } });
    await expect(batches.retryPendingMarkShipped(retained)).rejects.toMatchObject({ status });
    expect(pending()[0]).toEqual(retained); expect(posts()[1].body).toEqual(posts()[0].body);
  });
  it('an altered unknown input is rejected before any second read or write', async () => {
    write = async () => { throw Error('Lost ACK'); }; await expect(batches.markShipped('B1', original)).rejects.toThrow();
    await expect(batches.markShipped('B1', { ...original, skipGate: true })).rejects.toThrow('原请求');
    expect(requests).toHaveLength(2); expect(pending()).toHaveLength(1);
  });
  it.each(['missing', 'actor', 'batch', 'shipment', 'body', 'commandHash', 'batchHash', 'row'])('bad %s receipt never clears pending', async kind => {
    write = async request => ack(request, data => {
      const receipt = data.batch.acknowledgement;
      if (kind === 'missing') delete data.batch.acknowledgement;
      if (kind === 'actor') receipt.command.actorId = 'foreign-actor';
      if (kind === 'batch') receipt.command.batchId = 'B2';
      if (kind === 'shipment') receipt.command.shipmentId = 'S2';
      if (kind === 'body') receipt.command.input = { ...request.body, skipGate: true };
      if (kind === 'commandHash') receipt.commandHash = '0'.repeat(64);
      if (kind === 'batchHash') receipt.batchHash = '0'.repeat(64);
      if (kind === 'row') data.batch.amount = '1';
    });
    await expect(batches.markShipped('B1', original)).rejects.toThrow(); expect(pending()).toHaveLength(1);
  });
  it('unfamiliar success JSON cannot clear a command', async () => {
    write = async () => response(200, { ok: false, error: { code: 'FAILURE' } });
    await expect(batches.markShipped('B1', original)).rejects.toThrow(); expect(pending()).toHaveLength(1);
  });
  it.each(['actor', 'endpoint', 'ceiling'])('changing %s while context is in flight prevents the POST', async kind => {
    const delayed = deferred<Response>(); read = () => delayed.promise;
    const result = batches.markShipped('B1', original); const rejection = expect(result).rejects.toThrow('变化');
    if (kind === 'actor') account.id = 'foreign'; if (kind === 'endpoint') account.endpoint = 'http://other.invalid/api';
    if (kind === 'ceiling') account.ceiling = [];
    delayed.resolve(response(200, context())); await rejection; expect(posts()).toEqual([]);
  });
  it('changing account during ACK verification cannot clear the old actor request', async () => {
    const delayed = deferred<Response>(); write = () => delayed.promise;
    const result = batches.markShipped('B1', original); const rejection = expect(result).rejects.toThrow('变化');
    await vi.waitFor(() => expect(posts()).toHaveLength(1)); const receipt = ack(posts()[0]);
    account.id = 'foreign'; delayed.resolve(receipt); await rejection;
    expect(pending()).toEqual([]); account.id = 'logistics-a'; expect(pending()).toHaveLength(1);
  });
  it('journal is actor/endpoint/order scoped and permits current same-actor renewed credentials to replay', async () => {
    write = async () => { throw Error('Lost ACK'); }; await expect(batches.markShipped('B1', original)).rejects.toThrow();
    const retained = pending()[0]; expect(batches.listPendingMarkShipped('O2')).toEqual([]);
    account.endpoint = 'http://other.invalid/api'; expect(pending()).toEqual([]);
    account.endpoint = 'http://batch.invalid/api'; account.id = 'foreign'; expect(pending()).toEqual([]);
    account.id = 'logistics-a'; account.token = 'renewed-synthetic-token'; write = async request => ack(request);
    await batches.retryPendingMarkShipped(retained); expect(posts()[1].body).toEqual(posts()[0].body);
    expect(posts()[1].headers.Authorization).toContain('renewed'); expect(pending()).toEqual([]);
  });
  it('empty signed ceiling rejects any write without reading source or deleting a retained command', async () => {
    write = async () => { throw Error('Lost ACK'); }; await expect(batches.markShipped('B1', original)).rejects.toThrow();
    const retained = pending()[0], count = requests.length; account.ceiling = [];
    await expect(batches.retryPendingMarkShipped(retained)).rejects.toThrow('权限'); expect(requests).toHaveLength(count);
    expect(pending()[0]).toEqual(retained);
  });
});
