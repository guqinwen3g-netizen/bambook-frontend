import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ roles: ['sales'], permissions: ['orders:read', 'orders:write', 'shipments:read', 'shipments:write'] as string[], endpoint: 'https://handoff.invalid/api' }));
vi.mock('./authService', () => ({
  getAuthState: () => ({ isAuthenticated: true, user: { id: 'BUSINESS-1', roles: auth.roles, roleIds: ['role-sales'], permissions: auth.permissions } }),
  hasPermission: (scope: string) => auth.permissions.includes(scope),
  hasRole: (...roles: string[]) => roles.some(role => auth.roles.includes(role)),
}));
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: auth.endpoint }),
  getAuthHeaders: () => ({ Authorization: 'Bearer handoff-test' }),
  buildApiUrl: (path: string, endpoint?: string) => `${endpoint ?? auth.endpoint}${path}`,
} }));

import { shipmentHandoffService, type ShipmentHandoffBundle } from './shipmentHandoffService';

const bundle = (status = 'PendingLogistics'): ShipmentHandoffBundle => ({
  handoff: { id: 'SHH-1', shipmentId: 'SHIP-1', status: status as any, businessActorId: 'BUSINESS-1', logisticsActorId: null,
    requestKey: 'req-1', note: null, discrepancyReason: null, businessResponse: null, returnedToBusinessAt: null,
    businessRespondedAt: null, completedAt: null, createdAt: '1791118520000', expectedUpdatedAt: '1791118520001' },
  shipment: { id: 'SHIP-1', shipmentNumber: 'SHP-0001', status: 'Draft' },
  allocations: [{ id: 'SOA-1', shipmentId: 'SHIP-1', orderId: 'ORDER-1', plannedQty: '24.5', actualQty: '24.5', unit: '件',
    expectedUpdatedAt: '1791118520002', productionBatchAllocations: [{ id: 'SPA-1', productionBatchId: 'PB-1', productionBatchRevision: 2,
      factoryRelationId: 'FACTORY-1', plannedQty: '24.5', actualQty: '24.5', unit: '件', state: 'reserved', expectedUpdatedAt: '1791118520003',
      scopeFingerprint: 'a'.repeat(64), stockReceiptAllocations: [{ stockReceiptId: null, plannedQty: '24.5', actualQty: '24.5', unit: '件' }] }] }],
  lines: [{ id: 'SHHL-1', handoffId: 'SHH-1', allocationId: 'SOA-1', orderId: 'ORDER-1', orderLineId: 'LINE-1',
    productionBatchId: 'PB-1', productionBatchRevision: 2, factoryRelationId: 'FACTORY-1', factoryName: '工厂甲',
    scopeFingerprint: 'f'.repeat(64), plannedQty: '24.5', unit: '件', createdAt: '1791118520000',
    productionCompletion: { status: 'unknown', actualQty: null, unit: '件' } }],
  events: [{ id: 'SHHE-1', handoffId: 'SHH-1', fromStatus: null, toStatus: 'PendingLogistics' as any,
    actorId: 'BUSINESS-1', note: '业务发起出运交接', createdAt: '1791118520000' }],
});

let requests: Array<{ url: string; method: string; body: any }>;
let responseBody: any;
beforeEach(() => {
  auth.roles = ['sales'];
  requests = []; responseBody = { ok: true, ...bundle() };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('shipmentHandoffService', () => {
  it('reads exact factory-direct source and preserves its identity alongside an unbound zero remainder', async () => {
    auth.roles = ['logistics']; const value = bundle('Processing');
    const physical = value.allocations[0].productionBatchAllocations![0]; physical.actualQty = '4';
    physical.stockReceiptAllocations = [{ stockReceiptId: null, factoryLoadingReceiptId: 'FLR1', plannedQty: '4', actualQty: '4', unit: '件' },
      { stockReceiptId: null, plannedQty: '20.5', actualQty: '0', unit: '件' }];
    responseBody = { ok: true, bundle: value, sources: [{ allocationId: 'SOA-1', orderId: 'ORDER-1', orderLineId: 'LINE-1', physicalAllocationId: 'SPA-1',
      productionBatchId: 'PB-1', productionBatchRevision: 2, factoryRelationId: 'FACTORY-1', unit: '件', candidates: [], unavailableReceiptIds: [],
      factoryLoadings: [{ factoryLoadingReceiptId: 'FLR1', actualQty: '4', loadingDate: '2026-10-07', reference: 'PACK-17', unit: '件' }] }] };
    const result = await shipmentHandoffService.actualLoading('SHH-1');
    expect(result.bundle.allocations[0].productionBatchAllocations![0].stockReceiptAllocations[0].factoryLoadingReceiptId).toBe('FLR1');
    expect(result.sources[0].factoryLoadings?.[0].reference).toBe('PACK-17');
    responseBody.sources[0].factoryLoadings[0].factoryLoadingReceiptId = 'FOREIGN';
    await expect(shipmentHandoffService.actualLoading('SHH-1')).rejects.toThrow('响应与原业务范围不一致');
  });
  it('matches the original direct-loading command acknowledgement after decimal normalization and stable retry', async () => {
    auth.roles = ['logistics']; const value = bundle('Processing');
    const command = { requestKey: '4dc58690-9475-4af5-8a8b-f671f7021588', expectedUpdatedAt: value.handoff.expectedUpdatedAt,
      allocations: [{ allocationId: 'SOA-1', orderId: 'ORDER-1', orderLineId: 'LINE-1', expectedAllocationUpdatedAt: '1791118520002', unit: '件',
        productionBatchAllocations: [{ physicalAllocationId: 'SPA-1', expectedPhysicalUpdatedAt: '1791118520003', productionBatchId: 'PB-1', productionBatchRevision: 2,
          factoryRelationId: 'FACTORY-1', unit: '件', receiptActuals: [], factoryLoading: { actualQty: '24.5000', loadingDate: '2026-10-07', reference: 'PACK-17' } }] }] };
    const canonical = JSON.parse(JSON.stringify(command)); canonical.reason = null; canonical.allocations[0].productionBatchAllocations[0].factoryLoading.actualQty = '24.5';
    const commandHash = 'd'.repeat(64); value.events.push({ id: 'ACTUAL-EVENT', handoffId: 'SHH-1', actorId: 'BUSINESS-1', fromStatus: 'Processing', toStatus: 'Processing', note: null,
      createdAt: '1791118520004', requestKey: command.requestKey, commandHash } as any);
    responseBody = { ok: true, ...value, actualLoadingReceipt: { requestKey: command.requestKey, commandHash, command: canonical, replayed: false, requiresBusinessDecision: false } };
    await expect(shipmentHandoffService.recordActualLoading('SHH-1', command)).resolves.toMatchObject({ actualLoadingReceipt: { commandHash } });
    expect(requests[0].body).toEqual(command);
    responseBody.actualLoadingReceipt.command.allocations[0].productionBatchAllocations[0].factoryLoading.reference = 'CHANGED';
    await expect(shipmentHandoffService.recordActualLoading('SHH-1', command)).rejects.toThrow('回执尚未核对成功');
  });
  it('creates a durable exact factory-branch handoff and keeps production completion unknown', async () => {
    const input = { shippingMethod: 'Sea' as const, requestKey: 'req-1', allocations: [{ orderId: 'ORDER-1', orderLineId: 'LINE-1',
      productionBatchId: 'PB-1', productionBatchRevision: 2, factoryRelationId: 'FACTORY-1', plannedQty: '24.50', unit: '件' }] };
    const result = await shipmentHandoffService.create(input);
    expect(requests[0]).toMatchObject({ url: `${auth.endpoint}/v1/shipping/handoffs`, method: 'POST', body: input });
    expect(result.lines[0].productionCompletion).toEqual({ status: 'unknown', actualQty: null, unit: '件' });
    expect(result.handoff.status).toBe('PendingLogistics');
  });

  it('transitions with the exact source revision and current workflow status', async () => {
    auth.roles = ['logistics'];
    responseBody = { ok: true, ...bundle('NeedsBusinessDecision') };
    const result = await shipmentHandoffService.transition(bundle('Processing').handoff, 'return-to-business', { reason: '数量需再核实' });
    expect(requests[0]).toMatchObject({ url: `${auth.endpoint}/v1/shipping/handoffs/SHH-1/return-to-business`, method: 'POST',
      body: { expectedUpdatedAt: '1791118520001', reason: '数量需再核实' } });
    expect(result.handoff.status).toBe('NeedsBusinessDecision');
  });

  it('sends an explicit business decision and exact allocation revisions without converting quantities', async () => {
    auth.roles = ['sales'];
    responseBody = { ok: true, ...bundle('Processing') };
    const revisions = [{ allocationId: 'SOA-1', expectedAllocationUpdatedAt: '1791118520002', requestKey: 'cda8e1d7-7412-4c95-9d75-11b12f3f9980',
      plannedQty: '20.125', productionBatchAllocations: [{ productionBatchId: 'PB-1', productionBatchRevision: 2,
        factoryRelationId: 'FACTORY-1', stockReceiptId: null, plannedQty: '20.125' }] }];
    const result = await shipmentHandoffService.transition(bundle('NeedsBusinessDecision').handoff, 'return-to-logistics', {
      decision: 'revise_plan', response: '按确认数量调整本批计划', allocationRevisions: revisions,
    });
    expect(requests[0]).toMatchObject({ url: `${auth.endpoint}/v1/shipping/handoffs/SHH-1/return-to-logistics`, method: 'POST',
      body: { expectedUpdatedAt: '1791118520001', decision: 'revise_plan', response: '按确认数量调整本批计划', allocationRevisions: revisions } });
    expect(result.handoff.status).toBe('Processing');
  });

  it('cancels only through the dedicated pending-handoff endpoint and returns its cancelled status', async () => {
    auth.roles = ['sales'];
    responseBody = { ok: true, ...bundle('Cancelled') };
    const result = await shipmentHandoffService.transition(bundle('PendingLogistics').handoff, 'cancel', {
      requestKey: 'cda8e1d7-7412-4c95-9d75-11b12f3f9980', response: '误发，撤销本次交接',
    });
    expect(requests[0]).toMatchObject({ url: `${auth.endpoint}/v1/shipping/handoffs/SHH-1/cancel`, method: 'POST',
      body: { expectedUpdatedAt: '1791118520001', requestKey: 'cda8e1d7-7412-4c95-9d75-11b12f3f9980', response: '误发，撤销本次交接' } });
    expect(result.handoff.status).toBe('Cancelled');
  });

  it('reads the source order page from its exact order filter, not the latest logistics queue slice', async () => {
    responseBody = { ok: true, data: { items: [bundle()], page: { limit: 20, nextCursor: 'cursor-2' } } };
    const result = await shipmentHandoffService.list({ orderId: 'ORDER-1', cursor: 'cursor-1', limit: 20 });
    expect(requests[0].url).toContain('/v1/shipping/handoffs?');
    expect(requests[0].url).toContain('orderId=ORDER-1');
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('cursor-2');
  });

  it('rejects a lossy numeric planned quantity in the service response', async () => {
    responseBody.lines[0].plannedQty = 24.5;
    await expect(shipmentHandoffService.list({ orderId: 'ORDER-1' })).rejects.toThrow('响应与原业务范围不一致');
  });

  it('keeps eligibility blockers attached to exact line/factory branch identities', async () => {
    responseBody = { ok: true, data: { eligible: false, branches: [{ orderId: 'ORDER-1', orderLineId: 'LINE-1',
      productionBatchId: 'PB-1', productionBatchRevision: 2, factoryRelationId: 'FACTORY-1', plannedQty: '24.50', unit: '件',
      blockers: [{ code: 'QC_PENDING', message: '工厂甲 / LINE-1：产前样评审尚未通过。' }] }] } };
    const eligibility = await shipmentHandoffService.checkEligibility({ shippingMethod: 'Sea', requestKey: 'unused-for-check',
      allocations: [{ orderId: 'ORDER-1', orderLineId: 'LINE-1', productionBatchId: 'PB-1', productionBatchRevision: 2,
        factoryRelationId: 'FACTORY-1', plannedQty: '24.50', unit: '件' }] });
    expect(requests[0].url).toBe(`${auth.endpoint}/v1/shipping/handoffs/eligibility`);
    expect(requests[0].body).not.toHaveProperty('requestKey');
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.branches[0].blockers[0].message).toContain('工厂甲');
  });
});
