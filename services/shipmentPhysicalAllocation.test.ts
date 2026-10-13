import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import type { AuthState } from './authService';
import type { ShipmentAllocationInput, ShipmentAllocationPatch } from './shipmentService';

const BASE = 'http://unit.invalid/api';
const OTHER = 'http://other-unit.invalid/api';
const SHIPMENT = 'SH1';
const ALLOCATION = 'AL1';
const VERSION = '9007199254740993123';
const CREATE_OPERATION = `shipment:allocation:${SHIPMENT}:new:ORDER1:LINE1`;
const PATCH_OPERATION = `shipment:allocation:${SHIPMENT}:${ALLOCATION}`;
const api = vi.hoisted(() => ({ getStoredConfig: vi.fn(), getAuthHeaders: vi.fn(), buildApiUrl: vi.fn() }));
const auth = vi.hoisted(() => ({ getAuthState: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: api }));
vi.mock('./authService', () => auth);

let shipmentService: typeof import('./shipmentService')['shipmentService'];
let currentAuth: AuthState;
type Request = { url: string; method: string; headers: Record<string, string>; body: any };
type Reply = Response | Error | ((request: Request) => Response | Promise<Response>);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function session(id = 'sales-a'): AuthState {
  return { isAuthenticated: true, isLoading: false, user: { id, displayName: 'Synthetic session', email: 'unit@example.invalid',
    roles: ['sales'], roleIds: ['role-sales'], permissions: ['orders:read', 'shipments:read', 'shipments:write'],
    permissionCeiling: ['orders:read', 'shipments:read', 'shipments:write'], departmentIds: [], department: null } };
}
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, clear: () => entries.clear(),
    getItem: key => entries.get(String(key)) ?? null, setItem: (key, value) => { entries.set(String(key), String(value)); },
    removeItem: key => { entries.delete(String(key)); }, key: index => [...entries.keys()][index] ?? null };
}
function input(): ShipmentAllocationInput {
  return { orderId: 'ORDER1', orderLineId: 'LINE1', plannedQty: '8.0001', actualQty: '6.0001', unit: 'm',
    status: 'Planned', batchOrCartonNote: '合成多仓分配，不外发', exception: null,
    productionBatchAllocations: [
      { productionBatchId: 'BATCH-A', expectedRevision: 3, expectedScopeFingerprint: 'a'.repeat(64),
        stockReceiptId: 'PSR-A1', plannedQty: '3.0001', actualQty: '2.0001', unit: 'm' },
      { productionBatchId: 'BATCH-A', expectedRevision: 3, expectedScopeFingerprint: 'a'.repeat(64),
        stockReceiptId: 'PSR-A2', plannedQty: '5', actualQty: '4', unit: 'm' },
      { productionBatchId: 'BATCH-B', expectedRevision: 8, expectedScopeFingerprint: 'b'.repeat(64),
        stockReceiptId: null, plannedQty: '0', actualQty: '0', unit: 'm' },
    ] };
}
function patch(): ShipmentAllocationPatch {
  const { orderId: _order, orderLineId: _line, ...fields } = input();
  return { ...fields, expectedAllocationUpdatedAt: VERSION };
}

// Independent native-receipt storage seam. No production hash/normalizer is
// imported. These tests prove the client protocol, not native SQL, authority,
// stock availability, privacy or actual role login.
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function nativeCommand(body: any): any {
  const result = clone(body);
  const normalize = (row: any) => {
    for (const key of ['plannedQty', 'actualQty']) {
      if (typeof row[key] === 'string') {
        const [integer, fraction = ''] = row[key].split('.');
        const significantFraction = fraction.replace(/0+$/, '');
        row[key] = significantFraction ? `${integer}.${significantFraction}` : integer;
      }
    }
    for (const key of ['orderId', 'orderLineId', 'productionBatchId', 'unit', 'stockReceiptId', 'batchOrCartonNote', 'exception'])
      if (typeof row[key] === 'string') row[key] = row[key].trim();
    return row;
  };
  normalize(result);
  if (Array.isArray(result.productionBatchAllocations)) result.productionBatchAllocations.forEach(normalize);
  return result;
}
function exactSum(rows: any[], key: 'plannedQty' | 'actualQty'): string | null {
  if (rows.some(row => row[key] === null)) return null;
  const quantity = rows.reduce((total, row) => {
    const [whole, fraction = ''] = String(row[key]).split('.');
    return total + BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  }, BigInt(0));
  const whole = quantity / BigInt(10000), fraction = String(quantity % BigInt(10000)).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function projections(command: any): any[] {
  const rows = command.productionBatchAllocations ?? nativeCommand(input()).productionBatchAllocations;
  return [...new Set<string>(rows.map((row: any) => row.productionBatchId))].map((batchId, index) => {
    const group = rows.filter((row: any) => row.productionBatchId === batchId);
    return { id: `SPA-${index + 1}`, shipmentId: SHIPMENT, shipmentOrderAllocationId: ALLOCATION,
      productionBatchId: batchId, productionBatchRevision: group[0].expectedRevision,
      state: command.status === 'Cancelled' ? 'released' : 'reserved',
      plannedQty: exactSum(group, 'plannedQty'), actualQty: exactSum(group, 'actualQty'), unit: group[0].unit,
      scopeSnapshot: { schemaVersion: 1, allocationVersion: 1, scopeType: 'production_batch',
        scopeKey: `production_batch:${batchId}`, scopeFingerprint: group[0].expectedScopeFingerprint,
        receiptAllocations: group.map((row: any) => ({ stockReceiptId: row.stockReceiptId,
          warehouseId: row.stockReceiptId ? `WAREHOUSE-${row.stockReceiptId}` : null,
          inventoryItemId: row.stockReceiptId ? `ITEM-${row.stockReceiptId}` : null,
          stockMovementId: row.stockReceiptId ? `INBOUND-${row.stockReceiptId}` : null,
          receivedQuantity: row.stockReceiptId ? '10' : null,
          plannedQty: row.plannedQty, actualQty: row.actualQty, unit: row.unit })) } };
  });
}
function sealReceipt(allocation: any): any {
  return { ...allocation, acknowledgement: { schemaVersion: 1, allocationHash: digest({ ...allocation, replayed: false }) } };
}
function acknowledged(request: Request, replayed = false): any {
  const command = nativeCommand(request.body);
  const operation = request.method === 'PATCH' ? 'update_physical_shipment_allocation' : 'create_physical_shipment_allocation';
  const parent = input();
  const allocation = { id: ALLOCATION, shipmentId: SHIPMENT, orderId: command.orderId ?? parent.orderId,
    orderLineId: command.orderLineId ?? parent.orderLineId,
    plannedQty: Object.hasOwn(command, 'plannedQty') ? command.plannedQty : parent.plannedQty,
    actualQty: Object.hasOwn(command, 'actualQty') ? command.actualQty : parent.actualQty,
    unit: command.unit ?? parent.unit, status: command.status ?? parent.status,
    batchOrCartonNote: command.batchOrCartonNote ?? parent.batchOrCartonNote, exception: command.exception ?? null,
    createdAt: VERSION, updatedAt: '9007199254740993124', productionBatchAllocations: projections(command),
    operation, actorId: request.headers['X-Unit-Actor'], allocationVersion: 1, requestKey: command.requestKey,
    commandHash: digest({ operation, shipmentId: SHIPMENT, allocationId: request.method === 'PATCH' ? ALLOCATION : null,
      actorId: request.headers['X-Unit-Actor'], command }), commandSnapshot: command, replayed };
  return sealReceipt(allocation);
}
function response(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}
function rejected(status: number): Response {
  return response(status, { error: { code: status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT'
    : status === 503 ? 'AUTHORIZATION_UNAVAILABLE' : 'INVALID_INPUT', message: '明确拒绝本次请求' } });
}
function transport() {
  const requests: Request[] = [], replies: Reply[] = [];
  const fetch = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(raw), method: init?.method ?? 'GET', headers: { ...init?.headers } as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null };
    requests.push(request);
    if (!['POST', 'PATCH'].includes(request.method) || !request.url.match(/\/v1\/shipping\/SH1\/allocations(?:\/AL1)?$/))
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    const reply = replies.shift() ?? response(request.method === 'POST' ? 201 : 200, acknowledged(request));
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(request) : reply;
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, replies, fetch };
}
async function pending(allocationId?: string, endpoint = BASE) {
  return (await import('./businessRequestRecovery')).readBusinessRequest<any>(allocationId ? PATCH_OPERATION : CREATE_OPERATION, endpoint);
}
async function reloadClient() {
  vi.resetModules();
  ({ shipmentService } = await import('./shipmentService'));
}

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('crypto', { randomUUID, subtle: webcrypto.subtle });
  currentAuth = session();
  auth.getAuthState.mockImplementation(() => currentAuth);
  api.getStoredConfig.mockReturnValue({ cloudEndpoint: BASE });
  api.getAuthHeaders.mockImplementation(() => ({ 'Content-Type': 'application/json', 'X-Unit-Session': 'storage-seam',
    'X-Unit-Actor': currentAuth.user?.id }));
  api.buildApiUrl.mockImplementation((path: string, base: string) => `${base}${path}`);
  ({ shipmentService } = await import('./shipmentService'));
});
afterEach(() => vi.unstubAllGlobals());

describe('physical allocation uses exact native commands and complete immutable receipts', () => {
  it('creates with exact string quantities, both receipts of one batch and a separate explicit-zero batch', async () => {
    const f = transport(), command = input();
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/shipping/SH1/allocations`,
      body: { ...command, requestKey: expect.any(String) }, headers: { 'X-Unit-Actor': 'sales-a' } });
    expect(f.requests[0].body.requestKey).toMatch(/^[a-f0-9-]{36}$/i);
    expect(saved.productionBatchAllocations).toHaveLength(2);
    expect(saved.productionBatchAllocations?.[0].scopeSnapshot.receiptAllocations.map(row => row.stockReceiptId)).toEqual(['PSR-A1', 'PSR-A2']);
    expect(saved.productionBatchAllocations?.[1]).toMatchObject({ plannedQty: '0', actualQty: '0' });
    expect(JSON.stringify(saved)).not.toMatch(/unitCost|landedCost|costAmount|originalReceiptAck/);
    expect(await pending()).toBeNull();
  });

  it('PATCH sends the exact BigInt version string and complete multi-receipt source list', async () => {
    const f = transport(), command = patch();
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command, ALLOCATION);
    expect(f.requests[0]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/shipping/SH1/allocations/AL1`,
      body: { ...command, expectedAllocationUpdatedAt: VERSION, requestKey: expect.any(String) } });
    expect(typeof f.requests[0].body.expectedAllocationUpdatedAt).toBe('string');
    expect(await pending(ALLOCATION)).toBeNull();
  });

  it('PATCH omission preserves the old physical list without inventing a current list in the command snapshot', async () => {
    const f = transport();
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT,
      { expectedAllocationUpdatedAt: VERSION, batchOrCartonNote: '仅修改备注' }, ALLOCATION);
    expect(f.requests[0].body).toEqual({ expectedAllocationUpdatedAt: VERSION, batchOrCartonNote: '仅修改备注', requestKey: expect.any(String) });
    expect(saved.productionBatchAllocations?.[0]).toMatchObject({ plannedQty: '8.0001', actualQty: '6.0001' });
    expect((saved as any).commandSnapshot).not.toHaveProperty('productionBatchAllocations');
  });

  it('cancels with PATCH and retains historical quantities and receipt rows in released projections', async () => {
    const f = transport();
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT,
      { expectedAllocationUpdatedAt: VERSION, status: 'Cancelled' }, ALLOCATION);
    expect(f.requests.map(request => request.method)).toEqual(['PATCH']);
    expect(f.requests[0].body).toEqual({ expectedAllocationUpdatedAt: VERSION, status: 'Cancelled', requestKey: expect.any(String) });
    expect(saved).toMatchObject({ status: 'Cancelled', plannedQty: '8.0001', actualQty: '6.0001' });
    expect(saved.productionBatchAllocations?.[0]).toMatchObject({ state: 'released', plannedQty: '8.0001', actualQty: '6.0001' });
    expect(saved.productionBatchAllocations?.[0].scopeSnapshot.receiptAllocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ stockReceiptId: 'PSR-A1', plannedQty: '3.0001', actualQty: '2.0001' }),
        expect.objectContaining({ stockReceiptId: 'PSR-A2', plannedQty: '5', actualQty: '4' })]));
  });

  it('preserves unknown actual quantities as null instead of zero', async () => {
    const f = transport(), command = input(); command.actualQty = null;
    command.productionBatchAllocations!.forEach(row => { row.actualQty = null; });
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command);
    expect(f.requests[0].body.actualQty).toBeNull();
    expect(f.requests[0].body.productionBatchAllocations.every((row: any) => row.actualQty === null)).toBe(true);
    expect(saved.actualQty).toBeNull();
    expect(saved.productionBatchAllocations?.every(row => row.actualQty === null)).toBe(true);
  });

  it('does not round the Decimal(18,4) maximum through a JavaScript number', async () => {
    const f = transport(), command = input(); command.plannedQty = '99999999999999.9999'; command.actualQty = null;
    command.productionBatchAllocations = [{ productionBatchId: 'BATCH-A', expectedRevision: 3, expectedScopeFingerprint: 'a'.repeat(64),
      stockReceiptId: null, plannedQty: command.plannedQty, actualQty: null, unit: 'm' }];
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command);
    expect(f.requests[0].body.plannedQty).toBe('99999999999999.9999');
    expect(f.requests[0].body.productionBatchAllocations[0].plannedQty).toBe('99999999999999.9999');
    expect(saved.plannedQty).toBe('99999999999999.9999');
  });

  it('uses the durable generated key rather than a caller replacement requestKey', async () => {
    const f = transport();
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, { ...input(), requestKey: 'caller-not-a-durable-key' });
    expect(f.requests[0].body.requestKey).not.toBe('caller-not-a-durable-key');
    expect(f.requests[0].body.requestKey).toMatch(/^[a-f0-9-]{36}$/i);
  });

  it('accepts an independent native normalized ACK for trailing decimal zeroes and trimmed identifiers/text', async () => {
    const f = transport(), command = input();
    command.orderId = ' ORDER1 '; command.orderLineId = ' LINE1 '; command.plannedQty = '8.0000'; command.actualQty = '6.0000';
    command.unit = ' m '; command.batchOrCartonNote = '  合成备注  ';
    command.productionBatchAllocations![0] = { ...command.productionBatchAllocations![0], productionBatchId: ' BATCH-A ',
      stockReceiptId: ' PSR-A1 ', plannedQty: '3.0000', actualQty: '2.0000', unit: ' m ' };
    f.replies.push(request => response(201, acknowledged(request)));
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command);
    expect(f.requests[0].body).toMatchObject({ orderId: 'ORDER1', orderLineId: 'LINE1', plannedQty: '8', actualQty: '6', unit: 'm', batchOrCartonNote: '合成备注' });
    expect(f.requests[0].body.productionBatchAllocations[0]).toMatchObject({ productionBatchId: 'BATCH-A', stockReceiptId: 'PSR-A1', plannedQty: '3', actualQty: '2', unit: 'm' });
    expect(saved).toMatchObject({ plannedQty: '8', actualQty: '6', unit: 'm' });
    expect(localStorage.length).toBe(0);
  });

  it.each(['create', 'patch'] as const)('%s replayed:true accepts the original frozen hash and command bytes', async mode => {
    const f = transport(), command = mode === 'create' ? input() : patch();
    const allocationId = mode === 'patch' ? ALLOCATION : undefined;
    let original: any;
    f.replies.push(request => { original = acknowledged(request); throw new TypeError('lost ACK'); });
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command, allocationId)).rejects.toThrow('lost ACK');
    f.replies.push(() => response(200, { ...clone(original), replayed: true }));
    const saved = await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, clone(command), allocationId);
    expect(f.requests[1].body).toEqual(f.requests[0].body);
    expect({ ...saved, replayed: false }).toEqual((({ acknowledgement: _ack, ...value }) => value)(original));
    expect(await pending(allocationId)).toBeNull();
  });
});

describe('physical allocation rejects non-exact quantities before storing or sending an intent', () => {
  it.each([
    ['numeric header', 2, 'header'], ['numeric receipt row', 2, 'row'], ['empty', '', 'row'],
    ['five decimal places', '1.00001', 'row'], ['exponent', '1e3', 'header'], ['negative', '-1', 'row'],
    ['fifteen integer digits', '100000000000000', 'header'], ['quantity whitespace', ' 2 ', 'row'],
  ])('%s is not normalized into a different financial/physical fact', async (_label, value, target) => {
    const f = transport(), command = input();
    if (target === 'header') command.plannedQty = value as any;
    else command.productionBatchAllocations![0].plannedQty = value as any;
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command)).rejects.toThrow('精确十进制字符串');
    expect(f.requests).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
});

describe('physical allocation retains exact unresolved intents and distinguishes fresh rejection', () => {
  it.each([400, 403, 409])('fresh structured %s allows a new key after a current version refresh', async status => {
    const f = transport(); f.replies.push(rejected(status));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, patch(), ALLOCATION)).rejects.toThrow();
    expect(await pending(ALLOCATION)).toBeNull();
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, { ...patch(), expectedAllocationUpdatedAt: '9007199254740993124' }, ALLOCATION);
    expect(f.requests[1].body.requestKey).not.toBe(f.requests[0].body.requestKey);
    expect(f.requests[1].body.expectedAllocationUpdatedAt).toBe('9007199254740993124');
  });

  it.each(['create', 'patch'] as const)('%s lost ACK survives a client re-import with the complete original request', async mode => {
    const f = transport(), command = mode === 'create' ? input() : patch(), allocationId = mode === 'patch' ? ALLOCATION : undefined;
    f.replies.push(new TypeError('network result unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command, allocationId)).rejects.toThrow('network result unknown');
    const unresolved = await pending(allocationId);
    await reloadClient();
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, clone(command), allocationId);
    expect(f.requests[1].body).toEqual(f.requests[0].body);
    expect(f.requests[1].body.requestKey).toBe(unresolved!.requestId);
    expect(await pending(allocationId)).toBeNull();
  });

  it.each([500, 503])('%s retains the full original body/key for replay', async status => {
    const f = transport(); f.replies.push(rejected(status));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow();
    expect((await pending())?.payload).toEqual(input());
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input());
    expect(f.requests[1].body).toEqual(f.requests[0].body);
  });

  it.each([200, 409, 503])('non-JSON %s cannot prove the original request ended', async status => {
    const f = transport();
    f.replies.push({ ok: status < 300, status, json: vi.fn().mockRejectedValue(new SyntaxError('not JSON')) } as unknown as Response);
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow('尚未确认');
    expect((await pending())?.requestId).toBe(f.requests[0].body.requestKey);
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input());
    expect(f.requests[1].body).toEqual(f.requests[0].body);
  });

  it('failure JSON with HTTP 200 is not a native acknowledgement', async () => {
    const f = transport(); f.replies.push(response(200, { ok: false, error: { code: 'CONFLICT', message: '未执行' } }));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow('尚未确认');
    expect((await pending())?.requestId).toBe(f.requests[0].body.requestKey);
  });

  it('403 after an unknown request retains the original key rather than treating a late rejection as no prior commit', async () => {
    const f = transport(); f.replies.push(new TypeError('unknown'), rejected(403));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow();
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow();
    expect(f.requests[1].body).toEqual(f.requests[0].body);
    expect((await pending())?.requestId).toBe(f.requests[0].body.requestKey);
  });

  it.each(['quantity', 'receipt', 'unit'] as const)('unknown request cannot be replaced with a changed %s', async change => {
    const f = transport(); f.replies.push(new TypeError('unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow();
    const original = await pending(), modified = input();
    if (change === 'quantity') modified.plannedQty = '9.0001';
    if (change === 'receipt') modified.productionBatchAllocations![0].stockReceiptId = 'PSR-OTHER';
    if (change === 'unit') modified.productionBatchAllocations![0].unit = 'yd';
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, modified)).rejects.toThrow('原内容');
    expect(f.requests).toHaveLength(1);
    expect(await pending()).toEqual(original);
  });

  it('equivalent trailing-zero quantities reuse the normalized original request across re-import', async () => {
    const f = transport(), command = input(); command.plannedQty = '8.0000'; command.actualQty = '6.0000';
    command.productionBatchAllocations![0].plannedQty = '3.0000'; command.productionBatchAllocations![0].actualQty = '2.0000';
    f.replies.push(new TypeError('unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command)).rejects.toThrow();
    await reloadClient();
    const equivalent = clone(command); equivalent.plannedQty = '8'; equivalent.actualQty = '6';
    equivalent.productionBatchAllocations![0].plannedQty = '3'; equivalent.productionBatchAllocations![0].actualQty = '2';
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, equivalent);
    expect(f.requests[1].body).toEqual(f.requests[0].body);
    expect(await pending()).toBeNull();
  });

  it('equivalent trimmed source IDs cannot create a second key for an unknown canonical source', async () => {
    const f = transport(), command = input(); command.orderId = ' ORDER1 '; command.orderLineId = ' LINE1 ';
    f.replies.push(new TypeError('unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, command)).rejects.toThrow();
    await reloadClient();
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input());
    expect(f.requests[1].body).toEqual(f.requests[0].body);
    expect(localStorage.length).toBe(0);
  });
});

describe('physical allocation isolates current actor, endpoint and session', () => {
  it('another actor cannot consume or clear the original actor unresolved request', async () => {
    const f = transport(); f.replies.push(new TypeError('unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow();
    const original = await pending();
    currentAuth = session('sales-b');
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input());
    expect(f.requests[1].body.requestKey).not.toBe(original!.requestId);
    expect(f.requests[1].headers['X-Unit-Actor']).toBe('sales-b');
    expect(await pending()).toBeNull();
    currentAuth = session('sales-a');
    expect(await pending()).toEqual(original);
  });

  it('another explicit endpoint has an independent request and cannot clear the first endpoint pending', async () => {
    const f = transport(); f.replies.push(new TypeError('unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input(), undefined, BASE)).rejects.toThrow();
    const original = await pending();
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input(), undefined, OTHER);
    expect(f.requests[1].url).toBe(`${OTHER}/v1/shipping/SH1/allocations`);
    expect(f.requests[1].body.requestKey).not.toBe(original!.requestId);
    expect(await pending(undefined, BASE)).toEqual(original);
    expect(await pending(undefined, OTHER)).toBeNull();
  });

  const drifts: Array<[string, () => void]> = [
    ['actor', () => { currentAuth = session('sales-b'); }],
    ['headers', () => { api.getAuthHeaders.mockReturnValue({ 'Content-Type': 'application/json', 'X-Unit-Session': 'rotated', 'X-Unit-Actor': 'sales-a' }); }],
    ['roles', () => { currentAuth.user!.roles = ['finance']; }],
    ['permissions', () => { currentAuth.user!.permissions = ['shipments:read']; }],
    ['permission ceiling', () => { currentAuth.user!.permissionCeiling = []; }],
    ['configured endpoint', () => { api.getStoredConfig.mockReturnValue({ cloudEndpoint: OTHER }); }],
  ];
  it.each(drifts)('%s changing after persistence but before fetch cannot write under the old session', async (_label, drift) => {
    const f = transport(), originalSet = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { originalSet(key, value); drift(); });
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input(), undefined, BASE)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    expect(localStorage.length).toBe(1);
  });

  it.each(drifts)('%s changing while a response is pending cannot acknowledge or clear an old-session write', async (_label, drift) => {
    const f = transport();
    f.replies.push(request => { const reply = response(201, acknowledged(request)); drift(); return reply; });
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input(), undefined, BASE)).rejects.toThrow('变化');
    expect(f.requests).toHaveLength(1);
    expect(localStorage.length).toBe(1);
  });

  it('a late actor-A ACK cannot clear either actor-A or actor-B unresolved requests', async () => {
    const f = transport();
    let resolve!: (response: Response) => void;
    f.replies.push(() => new Promise<Response>(done => { resolve = done; }));
    const first = shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input());
    const assertion = expect(first).rejects.toThrow('变化');
    const actorA = await pending();
    currentAuth = session('sales-b'); f.replies.push(new TypeError('actor B unknown'));
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow('actor B unknown');
    const actorB = await pending();
    resolve(response(201, acknowledged(f.requests[0])));
    await assertion;
    expect(await pending()).toEqual(actorB);
    currentAuth = session('sales-a');
    expect(await pending()).toEqual(actorA);
  });

  it.each(['no user', 'not authenticated'] as const)('%s cannot persist or send an allocation', async condition => {
    const f = transport();
    if (condition === 'no user') currentAuth.user = null;
    else currentAuth.isAuthenticated = false;
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow('登录');
    expect(f.requests).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
});

describe('physical allocation rejects malformed or foreign ACKs even with internally consistent hashes', () => {
  const mutations: Array<[string, (body: any) => void, boolean?]> = [
    ['missing acknowledgement', body => { delete body.acknowledgement; }],
    ['wrong schema version', body => { body.acknowledgement.schemaVersion = 2; }],
    ['missing command snapshot', body => { delete body.commandSnapshot; }],
    ['changed quantity command', body => { body.commandSnapshot.actualQty = '9'; }],
    ['changed receipt command', body => { body.commandSnapshot.productionBatchAllocations[0].stockReceiptId = 'PSR-FOREIGN'; }],
    ['wrong actor', body => { body.actorId = 'foreign-actor'; }, true],
    ['wrong shipment', body => { body.shipmentId = 'FOREIGN-SHIPMENT'; }, true],
    ['missing allocation ID', body => { delete body.id; }, true],
    ['wrong operation', body => { body.operation = 'update_physical_shipment_allocation'; }, true],
    ['wrong request key', body => { body.requestKey = 'foreign-request-key'; }, true],
    ['wrong command hash', body => { body.commandHash = '0'.repeat(64); }, true],
    ['wrong allocation hash', body => { body.acknowledgement.allocationHash = '0'.repeat(64); }],
    ['altered result with original hash', body => { body.updatedAt = 'changed'; }],
    ['missing physical list', body => { delete body.productionBatchAllocations; }, true],
    ['empty physical list', body => { body.productionBatchAllocations = []; }, true],
  ];
  it.each(mutations)('%s retains the original key and complete intent', async (_label, mutate, reseal) => {
    const f = transport();
    f.replies.push(request => {
      let receipt = acknowledged(request); mutate(receipt);
      if (reseal) { const { acknowledgement: _ack, ...allocation } = receipt; receipt = sealReceipt(allocation); }
      return response(201, receipt);
    });
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input())).rejects.toThrow('尚未确认');
    expect((await pending())?.payload).toEqual(input());
    expect((await pending())?.requestId).toBe(f.requests[0].body.requestKey);
    await shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, input());
    expect(f.requests[1].body).toEqual(f.requests[0].body);
  });

  it('PATCH cannot clear its pending key with another allocation ID and a valid foreign-result hash', async () => {
    const f = transport();
    f.replies.push(request => { const { acknowledgement: _ack, ...receipt } = acknowledged(request); receipt.id = 'AL-FOREIGN';
      return response(200, sealReceipt(receipt)); });
    await expect(shipmentService.submitPhysicalShipmentAllocation(SHIPMENT, patch(), ALLOCATION)).rejects.toThrow('尚未确认');
    expect((await pending(ALLOCATION))?.requestId).toBe(f.requests[0].body.requestKey);
    expect((await pending(ALLOCATION))?.payload).toEqual(patch());
  });
});
