import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const shared = vi.hoisted(() => ({ actors: new Map<string, any>(), createShipment: vi.fn(), updateShipment: vi.fn(),
  writePhysicalShipmentAllocation: vi.fn(), verifyOriginalProductionReceipt: vi.fn(), lockShipmentDocumentSourcesInTx: vi.fn(),
  createFactoryLoading: vi.fn(), verifyFactoryLoading: vi.fn(), sampleProof: vi.fn(), productionCompletion: vi.fn() }));

vi.mock('../auth/tokenHelpers', () => ({
  loadUserWithRoles: vi.fn(async (_tx: any, userId: string) => ({ id: userId, status: 'active', deletedAt: null })),
  buildLoadedAuthTokenPayload: vi.fn(async (_tx: any, user: any) => shared.actors.get(user.id)),
}));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));
vi.mock('../qc/qcPhysicalCoverage', () => ({ resolveQcCoverage: vi.fn(async () => ({ scopeFingerprint: 'a'.repeat(64) })) }));
vi.mock('../samples/orderSampleConsumerProof', () => ({ resolveOrderSampleConsumerProof: shared.sampleProof }));
vi.mock('../production/productionCompletionService', () => ({ readOrderLineProductionCompletion: shared.productionCompletion }));
vi.mock('./shipmentMutationService', () => ({ createShipment: shared.createShipment, updateShipment: shared.updateShipment }));
vi.mock('./shipmentPhysicalAllocationService', () => ({ writePhysicalShipmentAllocation: shared.writePhysicalShipmentAllocation,
  verifyOriginalProductionReceipt: shared.verifyOriginalProductionReceipt }));
vi.mock('./shipmentPhysicalConsumerService', () => ({ physicalShipmentAllocationFingerprint: vi.fn(), lockShipmentPhysicalConsumer: vi.fn(async () => ({ kind: 'physical' })) }));
vi.mock('./factoryLoadingReceiptService', () => ({ createFactoryLoadingReceiptInTx: shared.createFactoryLoading, verifyFactoryLoadingReceiptInTx: shared.verifyFactoryLoading }));
vi.mock('./shipmentDocumentSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shipmentDocumentSource')>()),
  lockShipmentDocumentSourcesInTx: shared.lockShipmentDocumentSourcesInTx,
}));

import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { parseShipmentHandoffCreateInput, evaluateShipmentHandoffEligibility, createShipmentHandoff,
  transitionShipmentHandoff, recordShipmentHandoffActualLoading, parseShipmentHandoffActualLoadingInput,
  readShipmentHandoffActualLoading, confirmShipmentHandoffDeparture } from './shipmentHandoffService';

const UUID = '4dc58690-9475-4af5-8a8b-f671f7021588';
const createInput = { shippingMethod: 'Sea', requestKey: UUID, allocations: [{ orderId: 'O1', orderLineId: 'OL1',
  productionBatchId: 'PB1', productionBatchRevision: 2, factoryRelationId: 'F1', plannedQty: '12.5', unit: 'pcs' }] };

function token(userId: string, roleIds: string[], permissions = ['orders:read', 'orders:write', 'shipments:read', 'shipments:write']) {
  return { userId, roleIds, roles: [], permissions, authorizationLoaded: true, departmentIds: [] } as any;
}

function makeHandoffDb(overrides: Record<string, any> = {}) {
  let handoff: any = { id: 'SHH1', shipmentId: 'S1', status: 'PendingLogistics', businessActorId: 'B1', logisticsActorId: null,
    updatedAt: 10n, createdAt: 1n, note: null, discrepancyReason: null, businessResponse: null,
    returnedToBusinessAt: null, businessRespondedAt: null, completedAt: null };
  let shipment: any = { id: 'S1', type: 'Export', status: 'Draft', atd: null, deletedAt: null };
  const events: any[] = [];
  const tx: any = {
    shipmentHandoff: {
      findUnique: vi.fn(async () => handoff),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async ({ data }: any) => { handoff = { ...handoff, ...data }; return { count: 1 }; }),
    },
    shipmentHandoffLine: { findMany: vi.fn(async () => []) },
    shipmentHandoffEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data; }),
      findMany: vi.fn(async () => events), findFirst: vi.fn(async ({ where }: any) => events.find(row => row.handoffId === where.handoffId && row.requestKey === where.requestKey) ?? null) },
    shipment: { findUnique: vi.fn(async () => shipment) },
    tradeDocument: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
    shipmentProductionAllocation: { findMany: vi.fn(async () => []) },
    productionBatch: { findMany: vi.fn(async () => []) },
    ...overrides,
  };
  return { tx, prisma: { $transaction: (fn: any) => fn(tx) } as any, getHandoff: () => handoff,
    getShipment: () => shipment, setShipment: (value: any) => { shipment = value; },
    setHandoff: (value: any) => { handoff = value; }, events };
}

function configureDecisionSource(db: ReturnType<typeof makeHandoffDb>, status = 'NeedsBusinessDecision') {
  const order = { id: 'O1', customerRelationId: 'C1', customer: 'Customer', consigneeRelationId: 'D1', consigneeName: 'Consignee', businessLine: 'garment' };
  const handoffLine: any = { id: 'SHHL1', handoffId: 'SHH1', allocationId: 'AL1', orderId: 'O1', orderLineId: 'OL1',
    productionBatchId: 'PB1', productionBatchRevision: 2, factoryRelationId: 'F1', factoryName: 'Factory', scopeFingerprint: 'a'.repeat(64),
    partialShipmentAllowed: true, plannedQty: '5', unit: 'pcs', createdAt: 2n };
  const batch = { id: 'PB1', factoryRelationId: 'F1', orderId: 'O1', orderLineId: 'OL1', revision: 2, unit: 'pcs' };
  let allocation: any = { id: 'AL1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'OL1', plannedQty: '5', actualQty: '4',
    unit: 'pcs', status: 'Planned', batchOrCartonNote: null, exception: null, updatedAt: 20n, createdAt: 3n };
  let physical: any[] = [{ id: 'SPA1', allocationId: 'AL1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1',
    productionBatchRevision: 2, plannedQty: '5', actualQty: '4', unit: 'pcs', state: 'reserved', updatedAt: 20n,
    scopeSnapshot: { scopeFingerprint: 'a'.repeat(64), receiptAllocations: [{ stockReceiptId: 'R1', plannedQty: '5', actualQty: '4', unit: 'pcs' }] } }];
  db.setHandoff({ ...db.getHandoff(), status, businessActorId: 'B1' });
  db.tx.order = { findMany: vi.fn(async () => [order]), findUnique: vi.fn(async () => order) };
  db.tx.orderLine = { findUnique: vi.fn(async () => ({ id: 'OL1', orderId: 'O1', unit: 'pcs', partialShipmentAllowed: true, quantity: '100' })) };
  db.tx.shipmentHandoffLine = { findMany: vi.fn(async () => [handoffLine]) };
  db.tx.shipmentOrderAllocation = { findMany: vi.fn(async () => [allocation]),
    findUnique: vi.fn(async () => allocation) };
  db.tx.shipmentProductionAllocation = { findMany: vi.fn(async () => physical) };
  db.tx.productionBatch = { findMany: vi.fn(async () => [batch]), findUnique: vi.fn(async () => batch) };
  return { handoffLine, batch, getAllocation: () => allocation, setAllocation: (value: any) => { allocation = value; },
    getPhysical: () => physical, setPhysical: (value: any[]) => { physical = value; } };
}

function sourceDb() {
  const order = { id: 'O1', customerRelationId: 'C1', customer: 'Customer', consigneeRelationId: 'D1', consigneeName: 'Consignee', businessLine: 'garment' };
  const tx: any = {
    order: { findMany: vi.fn(async () => [order]) },
    orderLine: { findUnique: vi.fn(async () => ({ id: 'OL1', orderId: 'O1', unit: 'pcs', partialShipmentAllowed: true, quantity: '100' })) },
    productionBatch: { findUnique: vi.fn(async () => ({ id: 'PB1', orderId: 'O1', orderLineId: 'OL1', state: 'active', revision: 2,
      factoryRelationId: 'F1', unit: 'pcs', quantity: '100' })) },
    relation: { findUnique: vi.fn(async () => ({ id: 'F1', name: 'Factory', deletedAt: null })) },
    shipmentHandoff: { findFirst: vi.fn(async () => null) },
    shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
  };
  return { tx, prisma: { $transaction: (fn: any) => fn(tx) } as any };
}

beforeEach(() => {
  shared.actors.clear(); shared.createShipment.mockReset(); shared.updateShipment.mockReset();
  shared.writePhysicalShipmentAllocation.mockReset(); shared.verifyOriginalProductionReceipt.mockReset(); shared.lockShipmentDocumentSourcesInTx.mockReset();
  shared.createFactoryLoading.mockReset().mockResolvedValue({ id: 'FLR1' }); shared.verifyFactoryLoading.mockReset();
  shared.sampleProof.mockReset().mockResolvedValue({ mode: 'native', qualified: false, reason: 'NATIVE_FAMILY_MISSING' });
  shared.productionCompletion.mockReset().mockResolvedValue({ status: 'not_started', actualQty: null, unit: 'pcs',
    productionComplete: false, branches: [], blockers: [] });
});

function actualLoadingFixture() {
  const db = makeHandoffDb(), source = configureDecisionSource(db, 'Processing');
  Object.assign(source.batch, { state: 'active', quantity: '100' });
  source.setAllocation({ ...source.getAllocation(), actualQty: null });
  source.setPhysical(source.getPhysical().map(row => ({ ...row, actualQty: null,
    scopeSnapshot: { ...row.scopeSnapshot, receiptAllocations: [{ stockReceiptId: null, plannedQty: '5', actualQty: null, unit: 'pcs' }] } })));
  let packingCount = 0;
  db.tx.shipmentLine = { count: vi.fn(async () => packingCount) };
  db.tx.productionStockReceipt = { findMany: vi.fn(async () => [{ id: 'R1', receiptReference: 'Factory packing receipt' }]) };
  shared.verifyOriginalProductionReceipt.mockResolvedValue({ receipt: { quantity: '100' }, available: new Prisma.Decimal('100'), identity: { warehouseId: 'WH1' } });
  let afterPhysical: (() => void) | undefined;
  shared.writePhysicalShipmentAllocation.mockImplementation(async ({ input }: any) => {
    source.setAllocation({ ...source.getAllocation(), plannedQty: input.plannedQty, actualQty: input.actualQty, updatedAt: source.getAllocation().updatedAt + 1n });
    source.setPhysical(source.getPhysical().map(row => {
      const parts = input.productionBatchAllocations.filter((part: any) => part.productionBatchId === row.productionBatchId);
      return { ...row, plannedQty: parts.reduce((sum: Prisma.Decimal, part: any) => sum.plus(part.plannedQty), new Prisma.Decimal(0)).toString(), actualQty: input.actualQty, updatedAt: row.updatedAt + 1n,
        scopeSnapshot: { ...row.scopeSnapshot, receiptAllocations: parts.map((part: any) => ({ stockReceiptId: part.stockReceiptId,
          ...(part.factoryLoadingReceiptId ? { factoryLoadingReceiptId: part.factoryLoadingReceiptId } : {}),
          plannedQty: part.plannedQty, actualQty: part.actualQty, unit: part.unit })) } };
    }));
    afterPhysical?.();
    return { ok: true, data: { allocation: source.getAllocation() } };
  });
  const copy = (value: any): any => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
  let queue: Promise<any> = Promise.resolve();
  db.prisma.$transaction = (work: any) => {
    const result = queue.then(async () => {
      const before = copy({ handoff: db.getHandoff(), allocation: source.getAllocation(), physical: source.getPhysical(), events: db.events });
      try { return await work(db.tx); } catch (error) {
        db.setHandoff(before.handoff); source.setAllocation(before.allocation); source.setPhysical(before.physical);
        db.events.splice(0, db.events.length, ...before.events); throw error;
      }
    });
    queue = result.catch(() => undefined); return result;
  };
  const actor = token('L1', [SYSTEM_ROLE_IDS.LOGISTICS]); shared.actors.set('L1', actor);
  const input = (qty = '5', key = UUID): any => ({ expectedUpdatedAt: '10', requestKey: key,
    ...(qty === '5' ? {} : { reason: '工厂核实本次实际装运数量' }), allocations: [{ allocationId: 'AL1', expectedAllocationUpdatedAt: '20', orderId: 'O1', orderLineId: 'OL1', unit: 'pcs',
      productionBatchAllocations: [{ physicalAllocationId: 'SPA1', expectedPhysicalUpdatedAt: '20', productionBatchId: 'PB1', productionBatchRevision: 2,
        factoryRelationId: 'F1', unit: 'pcs', receiptActuals: [{ stockReceiptId: qty === '0' ? null : 'R1', actualQty: qty }] }] }] });
  const record = (command = input(), prior = actor) => recordShipmentHandoffActualLoading({ prisma: db.prisma, handoffId: 'SHH1', actor: prior, input: command });
  return { ...db, ...source, actor, input, record, setPackingCount: (value: number) => { packingCount = value; },
    setAfterPhysical: (callback: () => void) => { afterPhysical = callback; } };
}

describe('logistics actual loading inside the original handoff', () => {
  const directInput = (f: ReturnType<typeof actualLoadingFixture>, qty = '5') => {
    const command = f.input(qty), branch = command.allocations[0].productionBatchAllocations[0];
    branch.receiptActuals = []; branch.factoryLoading = { actualQty: qty, loadingDate: '2026-10-07', reference: '工厂装箱核量记录 PACK-17' };
    return command;
  };
  it('records factory-direct actual goods without requiring Warehouse, stock receipt or an Inbound', async () => {
    const f = actualLoadingFixture(); f.tx.productionStockReceipt.findMany.mockResolvedValue([]);
    const input = directInput(f), result = await f.record(input);
    expect(result.handoff.status).toBe('Processing'); expect(result.allocations[0]).toMatchObject({ plannedQty: '5', actualQty: '5' });
    expect(shared.createFactoryLoading).toHaveBeenCalledWith(f.tx, expect.objectContaining({ handoffId: 'SHH1', allocationId: 'AL1', batchId: 'PB1', requestKey: UUID,
      fact: { actualQty: '5', loadingDate: '2026-10-07', reference: '工厂装箱核量记录 PACK-17' }, previousFactoryLoadingReceiptIds: [] }));
    expect(result.allocations[0].productionBatchAllocations[0].stockReceiptAllocations).toEqual([{ stockReceiptId: null, factoryLoadingReceiptId: 'FLR1', plannedQty: '5', actualQty: '5', unit: 'pcs' }]);
    expect(f.tx.warehouse).toBeUndefined(); expect(f.tx.inventoryItem).toBeUndefined(); expect(f.tx.stockMovement).toBeUndefined();
    expect((await f.record(input)).actualLoadingReceipt.replayed).toBe(true); expect(shared.createFactoryLoading).toHaveBeenCalledTimes(1);
  });
  it('returns direct discrepancies to business while keeping original plan and immutable direct source identity', async () => {
    const f = actualLoadingFixture(), result = await f.record(directInput(f, '4'));
    expect(result.handoff.status).toBe('NeedsBusinessDecision');
    expect(result.allocations[0].productionBatchAllocations[0].stockReceiptAllocations).toEqual([
      { stockReceiptId: null, factoryLoadingReceiptId: 'FLR1', plannedQty: '4', actualQty: '4', unit: 'pcs' },
      { stockReceiptId: null, plannedQty: '1', actualQty: '0', unit: 'pcs' }]);
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const accepted = await transitionShipmentHandoff({ prisma: f.prisma, handoffId: 'SHH1', actor: business, action: 'return-to-logistics',
      input: { expectedUpdatedAt: result.handoff.expectedUpdatedAt, decision: 'accept_actual', response: '确认工厂实装四件' } });
    expect(accepted.handoff.status).toBe('Processing'); expect(accepted.lines[0].plannedQty).toBe('5');
    const omitted = f.input('4', '8acbc510-1bfd-4b45-8d7c-fd0210683eaf'); omitted.expectedUpdatedAt = accepted.handoff.expectedUpdatedAt;
    omitted.allocations[0].expectedAllocationUpdatedAt = accepted.allocations[0].expectedUpdatedAt;
    omitted.allocations[0].productionBatchAllocations[0].expectedPhysicalUpdatedAt = accepted.allocations[0].productionBatchAllocations[0].expectedUpdatedAt;
    await expect(f.record(omitted)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('sums native and factory-direct portions together and rejects direct overrun before producer writes', async () => {
    const f = actualLoadingFixture(), mixed = directInput(f, '3'); mixed.reason = null;
    mixed.allocations[0].productionBatchAllocations[0].receiptActuals = [{ stockReceiptId: 'R1', actualQty: '2' }];
    const result = await f.record(mixed); expect(result.allocations[0].actualQty).toBe('5');
    expect(result.allocations[0].productionBatchAllocations[0].stockReceiptAllocations).toEqual([
      { stockReceiptId: 'R1', plannedQty: '2', actualQty: '2', unit: 'pcs' },
      { stockReceiptId: null, factoryLoadingReceiptId: 'FLR1', plannedQty: '3', actualQty: '3', unit: 'pcs' }]);
    const tooMuch = actualLoadingFixture(); await expect(tooMuch.record(directInput(tooMuch, '101'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(shared.createFactoryLoading).toHaveBeenCalledTimes(1);
  });
  it('business can revise the direct source plus zero remainder and subsequent loading sees the sum of the approved branch rows', async () => {
    const f = actualLoadingFixture(), recorded = await f.record(directInput(f, '4'));
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const revised = await transitionShipmentHandoff({ prisma: f.prisma, handoffId: 'SHH1', actor: business, action: 'return-to-logistics', input: {
      expectedUpdatedAt: recorded.handoff.expectedUpdatedAt, decision: 'revise_plan', response: '按工厂实际四件修订本次计划',
      allocationRevisions: [{ allocationId: 'AL1', expectedAllocationUpdatedAt: recorded.allocations[0].expectedUpdatedAt, requestKey: '8acbc510-1bfd-4b45-8d7c-fd0210683eaf', plannedQty: '4',
        productionBatchAllocations: [{ productionBatchId: 'PB1', productionBatchRevision: 2, factoryRelationId: 'F1', stockReceiptId: null, factoryLoadingReceiptId: 'FLR1', plannedQty: '4' },
          { productionBatchId: 'PB1', productionBatchRevision: 2, factoryRelationId: 'F1', stockReceiptId: null, plannedQty: '0' }] }] } });
    expect(revised.handoff.status).toBe('Processing'); expect(revised.allocations[0].plannedQty).toBe('4'); expect(revised.lines[0].plannedQty).toBe('5');
    const next = directInput(f, '4'); next.requestKey = '2e67911d-5518-4c63-b8a3-2756e4b41f42'; next.expectedUpdatedAt = revised.handoff.expectedUpdatedAt;
    next.allocations[0].expectedAllocationUpdatedAt = revised.allocations[0].expectedUpdatedAt;
    next.allocations[0].productionBatchAllocations[0].expectedPhysicalUpdatedAt = revised.allocations[0].productionBatchAllocations[0].expectedUpdatedAt;
    expect((await f.record(next)).actualLoadingReceipt.requiresBusinessDecision).toBe(false);
    expect(shared.createFactoryLoading.mock.calls.at(-1)![1].previousFactoryLoadingReceiptIds).toEqual(['FLR1']);
  });
  it.each(['2026-02-30', '', '2026-10-7'])('rejects invalid direct date %s without inferring today', date => {
    const f = actualLoadingFixture(), input = directInput(f); input.allocations[0].productionBatchAllocations[0].factoryLoading.loadingDate = date;
    expect(() => parseShipmentHandoffActualLoadingInput(input)).toThrow('日期');
  });
  it('keeps unknown distinct from zero and accepts only complete exact decimal quantities', () => {
    const f = actualLoadingFixture(), unknown = f.input(); unknown.allocations[0].productionBatchAllocations[0].receiptActuals[0].actualQty = null;
    expect(() => parseShipmentHandoffActualLoadingInput(unknown)).toThrow('未录不是零');
    expect(parseShipmentHandoffActualLoadingInput(f.input('0')).allocations[0].productionBatchAllocations[0].receiptActuals[0].actualQty).toBe('0');
    const numeric = f.input(); numeric.allocations[0].productionBatchAllocations[0].receiptActuals[0].actualQty = 5;
    expect(() => parseShipmentHandoffActualLoadingInput(numeric)).toThrow();
  });
  it('records null→real quantity through the native allocator, retaining the original business plan', async () => {
    const f = actualLoadingFixture(), result = await f.record();
    expect(result.handoff.status).toBe('Processing');
    expect(result.allocations[0]).toMatchObject({ plannedQty: '5', actualQty: '5' });
    expect(result.allocations[0].productionBatchAllocations[0].stockReceiptAllocations).toEqual([{ stockReceiptId: 'R1', plannedQty: '5', actualQty: '5', unit: 'pcs' }]);
    expect(result.lines[0].plannedQty).toBe('5'); expect(result.actualLoadingReceipt).toMatchObject({ replayed: false, requiresBusinessDecision: false });
    expect(shared.writePhysicalShipmentAllocation).toHaveBeenCalledWith(expect.objectContaining({ handoffAuthorization: { handoffId: 'SHH1', operation: 'record-actual' },
      input: expect.objectContaining({ plannedQty: '5', actualQty: '5', expectedAllocationUpdatedAt: '20' }) }));
  });
  it('saves discrepancy facts and returns to the original business, whose acceptance resumes the same handoff', async () => {
    const f = actualLoadingFixture(), result = await f.record(f.input('4'));
    expect(result.handoff).toMatchObject({ status: 'NeedsBusinessDecision', businessActorId: 'B1', discrepancyReason: '工厂核实本次实际装运数量' });
    expect(result.allocations[0]).toMatchObject({ plannedQty: '5', actualQty: '4' });
    expect(result.allocations[0].productionBatchAllocations[0].stockReceiptAllocations).toEqual([
      { stockReceiptId: 'R1', plannedQty: '4', actualQty: '4', unit: 'pcs' }, { stockReceiptId: null, plannedQty: '1', actualQty: '0', unit: 'pcs' }]);
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const accepted = await transitionShipmentHandoff({ prisma: f.prisma, handoffId: 'SHH1', actor: business, action: 'return-to-logistics',
      input: { expectedUpdatedAt: String(result.handoff.updatedAt), decision: 'accept_actual', response: '确认按四件实装出运' } });
    expect(accepted.handoff.status).toBe('Processing'); expect(accepted.allocations[0]).toMatchObject({ plannedQty: '5', actualQty: '4' });
    expect(f.events).toHaveLength(2);
  });
  it('records explicit zero as a fact and does not invent an original receipt', async () => {
    const f = actualLoadingFixture(), result = await f.record(f.input('0'));
    expect(result.handoff.status).toBe('NeedsBusinessDecision'); expect(result.allocations[0].actualQty).toBe('0');
    expect(shared.writePhysicalShipmentAllocation.mock.calls[0][0].input.productionBatchAllocations[0]).toMatchObject({ stockReceiptId: null, plannedQty: '5', actualQty: '0' });
  });
  it('resolves a same-key concurrent/lost response once and refuses key reuse with different content', async () => {
    const f = actualLoadingFixture(), input = f.input('4');
    const [first, replay] = await Promise.all([f.record(input), f.record(input)]);
    expect([first.actualLoadingReceipt.replayed, replay.actualLoadingReceipt.replayed]).toEqual([false, true]);
    expect(shared.writePhysicalShipmentAllocation).toHaveBeenCalledTimes(1); expect(f.events).toHaveLength(1);
    await expect(f.record(f.input('3'))).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(f.getAllocation().actualQty).toBe('4');
  });
  it('serializes different request keys, rejecting a stale handoff revision rather than overwriting', async () => {
    const f = actualLoadingFixture(), a = f.input(), b = f.input('4', '8acbc510-1bfd-4b45-8d7c-fd0210683eaf');
    const results = await Promise.allSettled([f.record(a), f.record(b)]);
    expect(results[0].status).toBe('fulfilled'); expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(f.getAllocation().actualQty).toBe('5'); expect(f.events).toHaveLength(1);
  });
  it.each([SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.FINANCE])('refuses %s with otherwise broad scopes', async role => {
    const f = actualLoadingFixture(), actor = token('OTHER', [role]); shared.actors.set('OTHER', actor);
    await expect(f.record(f.input(), actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(shared.writePhysicalShipmentAllocation).not.toHaveBeenCalled();
  });
  it.each([{ roles: [SYSTEM_ROLE_IDS.ADMIN] }, { roles: [SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.LOGISTICS] }])('supports configured supervisor/multiple duties $roles', async ({ roles }) => {
    const f = actualLoadingFixture(), actor = token('COLLAB', roles); shared.actors.set('COLLAB', actor);
    expect((await f.record(f.input(), actor)).actualLoadingReceipt.replayed).toBe(false);
  });
  it.each(['PendingLogistics', 'NeedsBusinessDecision', 'ReturnedToBusiness', 'Cancelled'])('refuses recording in %s', async status => {
    const f = actualLoadingFixture(); f.setHandoff({ ...f.getHandoff(), status });
    await expect(f.record()).rejects.toMatchObject({ code: 'INVALID_STATE' }); expect(shared.writePhysicalShipmentAllocation).not.toHaveBeenCalled();
  });
  it.each(['order', 'factory', 'revision', 'unit', 'allocation-version', 'physical-version'])('rejects changed %s source before any write', async mode => {
    const f = actualLoadingFixture(), input = f.input(), allocation = input.allocations[0], branch = allocation.productionBatchAllocations[0];
    if (mode === 'order') allocation.orderId = 'FOREIGN';
    if (mode === 'factory') branch.factoryRelationId = 'FOREIGN';
    if (mode === 'revision') branch.productionBatchRevision = 1;
    if (mode === 'unit') branch.unit = 'm';
    if (mode === 'allocation-version') allocation.expectedAllocationUpdatedAt = '19';
    if (mode === 'physical-version') branch.expectedPhysicalUpdatedAt = '19';
    await expect(f.record(input)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(shared.writePhysicalShipmentAllocation).not.toHaveBeenCalled();
  });
  it('refuses physical overrun, missing discrepancy reason and replacement of a known receipt', async () => {
    const f = actualLoadingFixture(); await expect(f.record(f.input('101'))).rejects.toMatchObject({ code: 'CONFLICT' });
    const noReason = f.input('4'); delete noReason.reason; await expect(f.record(noReason)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    f.setPhysical(f.getPhysical().map(row => ({ ...row, scopeSnapshot: { ...row.scopeSnapshot, receiptAllocations: [{ stockReceiptId: 'ORIGINAL', plannedQty: '5', actualQty: null, unit: 'pcs' }] } })));
    await expect(f.record()).rejects.toMatchObject({ code: 'CONFLICT' }); expect(shared.writePhysicalShipmentAllocation).not.toHaveBeenCalled();
  });
  it('rejects late packing/archiving after source-lock wait and rolls back already delegated facts', async () => {
    const f = actualLoadingFixture(); f.setAfterPhysical(() => f.setPackingCount(1));
    await expect(f.record()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.getAllocation().actualQty).toBeNull(); expect(f.getPhysical()[0].actualQty).toBeNull(); expect(f.events).toHaveLength(0);
  });
  it('offers only exact branch receipts and strips private verification snapshots', async () => {
    const f = actualLoadingFixture(), result = await readShipmentHandoffActualLoading({ prisma: f.prisma, handoffId: 'SHH1', actor: f.actor });
    expect(result.sources[0]).toMatchObject({ orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 2,
      factoryRelationId: 'F1', candidates: [{ stockReceiptId: 'R1', warehouseId: 'WH1', receivedQty: '100', availableQty: '100', unit: 'pcs' }] });
    expect(result.sources[0].candidates[0]).not.toHaveProperty('commandSnapshot');
    expect(f.tx.productionStockReceipt.findMany.mock.calls[0][0].where).toMatchObject({ orderId: 'O1', orderLineId: 'OL1', productionBatchRevision: 2 });
  });
});

describe('shipment handoff command and lifecycle', () => {
  it('requires a reusable UUID command key and preserves exact quantity strings', () => {
    expect(parseShipmentHandoffCreateInput(createInput).allocations[0].plannedQty).toBe('12.5');
    expect(() => parseShipmentHandoffCreateInput({ ...createInput, requestKey: undefined })).toThrow();
    expect(() => parseShipmentHandoffCreateInput({ ...createInput, allocations: [{ ...createInput.allocations[0], plannedQty: 12.5 }] })).toThrow();
  });

  it('eligibility reports exact line/factory linkage and explicit unknown production completion without claiming a QC pass', async () => {
    const businessActor = token('B1', [SYSTEM_ROLE_IDS.SALES], ['orders:read', 'orders:write']);
    shared.actors.set('B1', businessActor);
    const { prisma } = sourceDb();
    const result = await evaluateShipmentHandoffEligibility({ prisma, actor: businessActor, input: createInput });
    expect(result.eligible).toBe(false);
    expect(result.branches[0]).toMatchObject({ orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1',
      productionBatchRevision: 2, factoryRelationId: 'F1', plannedQty: '12.5', partialShipmentAllowed: true,
      productionCompletion: { status: 'not_started', actualQty: null, unit: 'pcs', productionComplete: false } });
    expect(result.branches[0].blockers.map((row: any) => row.code)).toEqual([
      'REQUIRED_SAMPLE_CONFIG_MISSING', 'PRODUCTION_QC_AUTHORITY_UNAVAILABLE',
    ]);
  });

  it('requires professional logistics authority for departure even if business has shipment write', async () => {
    const actor = token('B1', [SYSTEM_ROLE_IDS.SALES]);
    shared.actors.set('B1', actor);
    const { prisma } = sourceDb();
    await expect(confirmShipmentHandoffDeparture({ prisma, actor, handoffId: 'H1', input: {
      expectedUpdatedAt: '1', expectedShipmentUpdatedAt: '1', requestKey: UUID, atd: '2026-10-08',
      expectedPhysicalAllocationFingerprint: 'a'.repeat(64),
    } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(shared.updateShipment).not.toHaveBeenCalled();
  });

  it('rejects business handoff launch without order write permission', async () => {
    const actor = token('B1', [SYSTEM_ROLE_IDS.SALES], ['orders:read']);
    shared.actors.set('B1', actor);
    const { prisma } = sourceDb();
    await expect(evaluateShipmentHandoffEligibility({ prisma, actor, input: createInput })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createShipmentHandoff({ prisma, actor, input: createInput })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(shared.createShipment).not.toHaveBeenCalled();
  });

  it('fails shipment eligibility closed for an open QC NOK and for QC pass awaiting business resume', async () => {
    shared.actors.set('B1', token('B1', [SYSTEM_ROLE_IDS.SALES]));
    const { prisma, tx } = sourceDb();
    const issue = { id: 'PQI1', orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 2,
      failedReportId: 'INR-FAIL', reason: '缝线开裂', createdBy: 'QC1', createdAt: 100n };
    const reports = new Map<string, any>([
      ['INR-FAIL', { id: 'INR-FAIL', orderId: 'O1', scopeType: 'production_batch', productionBatchId: 'PB1', productionBatchRevision: 2, result: 'fail' }],
      ['INR-PASS', { id: 'INR-PASS', orderId: 'O1', scopeType: 'production_batch', productionBatchId: 'PB1', productionBatchRevision: 2, result: 'pass' }],
    ]);
    tx.productionQcIssue = { findMany: vi.fn(async () => [issue]) };
    tx.inspectionReport = { findUnique: vi.fn(async ({ where }: any) => reports.get(where.id) ?? null) };
    tx.productionQcIssueEvent = { findMany: vi.fn(async () => [{ id: 'PQIE1', issueId: 'PQI1', productionBatchRevision: 2,
      orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', kind: 'opened', fromStatus: null, toStatus: 'open',
      reportId: 'INR-FAIL', createdAt: 100n }]) };
    let result = await evaluateShipmentHandoffEligibility({ prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input: createInput });
    expect(result.branches[0].blockers).toContainEqual(expect.objectContaining({ code: 'PRODUCTION_QC_ISSUE_OPEN' }));

    tx.productionQcIssueEvent.findMany.mockResolvedValue([{ id: 'PQIE1', issueId: 'PQI1', productionBatchRevision: 2,
      orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', kind: 'opened', fromStatus: null, toStatus: 'open',
      reportId: 'INR-FAIL', createdAt: 100n }, { id: 'PQIE2', issueId: 'PQI1', productionBatchRevision: 2,
      orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', kind: 'qc_resolved', fromStatus: 'open', toStatus: 'resolved',
      reportId: 'INR-PASS', createdAt: 101n }]);
    result = await evaluateShipmentHandoffEligibility({ prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input: createInput });
    expect(result.branches[0].blockers).toContainEqual(expect.objectContaining({ code: 'PRODUCTION_QC_WAITING_BUSINESS_RESUME' }));

    tx.productionQcIssueEvent.findMany.mockResolvedValue([{ id: 'PQIE1', issueId: 'PQI1', productionBatchRevision: 2,
      orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', kind: 'opened', fromStatus: null, toStatus: 'open',
      reportId: 'INR-FAIL', createdAt: 100n }, { id: 'PQIE2', issueId: 'PQI1', productionBatchRevision: 2,
      orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', kind: 'qc_resolved', fromStatus: 'open', toStatus: 'resolved',
      reportId: 'INR-PASS', createdAt: 101n }, { id: 'PQIE3', issueId: 'PQI1', productionBatchRevision: 2,
      orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', kind: 'business_resumed', fromStatus: 'waiting_business_resume',
      toStatus: 'resumed', reportId: 'INR-PASS', createdAt: 102n }]);
    result = await evaluateShipmentHandoffEligibility({ prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input: createInput });
    expect(result.branches[0].blockers).not.toContainEqual(expect.objectContaining({ code: 'PRODUCTION_QC_ISSUE_OPEN' }));
    expect(result.branches[0].blockers).not.toContainEqual(expect.objectContaining({ code: 'PRODUCTION_QC_WAITING_BUSINESS_RESUME' }));
  });

  it('requires a current QC pass for every frozen sample family, in addition to native customer approval proof', async () => {
    shared.actors.set('B1', token('B1', [SYSTEM_ROLE_IDS.SALES]));
    const { prisma, tx } = sourceDb();
    tx.orderLine.findUnique.mockResolvedValue({ id: 'OL1', orderId: 'O1', unit: 'pcs', partialShipmentAllowed: true,
      quantity: '100', requiredSampleFamilies: ['garment_pp', 'garment_ship'] });
    tx.productionQcIssue = { findMany: vi.fn(async () => []) };
    tx.productionQcIssueEvent = { findMany: vi.fn(async () => []) };
    shared.sampleProof.mockImplementation(async (_db: any, _target: any, family: string) => ({ mode: 'native', qualified: true, proof: {
      scope: { orderLineId: 'OL1', productionBatchId: 'PB1', productionBatchRevision: 2 },
      proofFingerprint: `proof-${family}`, qcReport: { fact: { result: family === 'garment_pp' ? 'passed' : 'failed' } },
    } }));
    const result = await evaluateShipmentHandoffEligibility({ prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input: createInput });
    expect(shared.sampleProof).toHaveBeenCalledTimes(2);
    expect(result.branches[0].blockers).toContainEqual(expect.objectContaining({ code: 'REQUIRED_SAMPLE_QC_NOT_PASSED', family: 'garment_ship' }));
    expect(result.branches[0].blockers).not.toContainEqual(expect.objectContaining({ code: 'REQUIRED_SAMPLE_QC_NOT_PASSED', family: 'garment_pp' }));
    expect(result.branches[0].blockers).toContainEqual(expect.objectContaining({ code: 'PP_PRODUCTION_LINE_IDENTITY_MISSING', family: 'garment_pp' }));
  });

  it('validates every order in a multi-order handoff by customer, consignee and business line before creating anything', async () => {
    shared.actors.set('B1', token('B1', [SYSTEM_ROLE_IDS.SALES]));
    const orders = [
      { id: 'O1', customerRelationId: 'C1', customer: 'Customer', consigneeRelationId: 'D1', consigneeName: 'Consignee', businessLine: 'garment' },
      { id: 'O2', customerRelationId: 'C1', customer: 'Customer', consigneeRelationId: 'D1', consigneeName: 'Consignee', businessLine: 'garment' },
    ];
    const input = { ...createInput, allocations: [createInput.allocations[0], { ...createInput.allocations[0], orderId: 'O2',
      orderLineId: 'OL2', productionBatchId: 'PB2', factoryRelationId: 'F2' }] };
    const configuredDb = (secondOrder: any) => {
      const { prisma, tx } = sourceDb();
      tx.order.findMany.mockResolvedValue([orders[0], { ...orders[1], ...secondOrder }]);
      tx.orderLine.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id,
        orderId: where.id === 'OL1' ? 'O1' : 'O2', unit: 'pcs', partialShipmentAllowed: true, quantity: '100' }));
      tx.productionBatch.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id,
        orderId: where.id === 'PB1' ? 'O1' : 'O2', orderLineId: where.id === 'PB1' ? 'OL1' : 'OL2', state: 'active', revision: 2,
        factoryRelationId: where.id === 'PB1' ? 'F1' : 'F2', unit: 'pcs', quantity: '100' }));
      tx.relation.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, name: `Factory ${where.id}`, deletedAt: null }));
      tx.productionQcIssue = { findMany: vi.fn(async () => []) };
      tx.productionQcIssueEvent = { findMany: vi.fn(async () => []) };
      return { prisma, tx };
    };

    const compatible = configuredDb({});
    await expect(createShipmentHandoff({ prisma: compatible.prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input }))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' }); // passes identity; current sample authority still correctly blocks
    expect(shared.createShipment).not.toHaveBeenCalled();

    for (const mismatch of [
      { customerRelationId: 'C2' },
      { consigneeRelationId: 'D2' },
      { businessLine: 'fabric' },
    ]) {
      const db = configuredDb(mismatch);
      await expect(createShipmentHandoff({ prisma: db.prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
      expect(shared.createShipment).not.toHaveBeenCalled();
    }
  });

  it.each([false, null])('fails closed for partialShipmentAllowed=%s without comparing planned shipment quantity to contract quantity', async (rule) => {
    shared.actors.set('B1', token('B1', [SYSTEM_ROLE_IDS.SALES]));
    const { prisma, tx } = sourceDb();
    tx.orderLine.findUnique.mockResolvedValue({ id: 'OL1', orderId: 'O1', unit: 'pcs', partialShipmentAllowed: rule, quantity: '100' });
    const result = await evaluateShipmentHandoffEligibility({ prisma, actor: token('B1', [SYSTEM_ROLE_IDS.SALES]), input: createInput });
    expect(result.eligible).toBe(false);
    expect(result.branches[0].productionCompletion).toMatchObject({ status: 'not_started', actualQty: null, unit: 'pcs' });
    expect(result.branches[0].blockers.map((row: any) => row.code)).toContain(
      rule === null ? 'SPLIT_SHIPMENT_RULE_UNKNOWN' : 'PRODUCTION_COMPLETION_REQUIRED');
    expect(result.branches[0].blockers.map((row: any) => row.code)).not.toContain('CONTRACT_QUANTITY_MISMATCH');
  });

  it('does not create Shipment or reserve allocations when canonical eligibility authority is unavailable', async () => {
    const businessActor = token('B1', [SYSTEM_ROLE_IDS.SALES], ['orders:read', 'orders:write']);
    shared.actors.set('B1', businessActor);
    const { prisma } = sourceDb();
    await expect(createShipmentHandoff({ prisma, actor: businessActor, input: createInput }))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    expect(shared.createShipment).not.toHaveBeenCalled();
  });

  it('permits only the existing LOGISTICS role to start, appends actor/time/from/to, and keeps Shipment physical state untouched', async () => {
    const { prisma, tx, getHandoff, events } = makeHandoffDb();
    const logistics = token('L1', [SYSTEM_ROLE_IDS.LOGISTICS]);
    shared.actors.set('L1', logistics);
    await transitionShipmentHandoff({ prisma, handoffId: 'SHH1', actor: logistics, action: 'start', input: { expectedUpdatedAt: '10' } });
    expect(getHandoff()).toMatchObject({ status: 'Processing', logisticsActorId: 'L1' });
    expect(events[0]).toMatchObject({ fromStatus: 'PendingLogistics', toStatus: 'Processing', actorId: 'L1' });
    expect(events[0].createdAt).toBeGreaterThan(10n);
    expect(tx.shipmentHandoff.updateMany).toHaveBeenCalledTimes(1);

    shared.actors.set('B1', token('B1', [SYSTEM_ROLE_IDS.SALES]));
    const unauthorized = makeHandoffDb();
    await expect(transitionShipmentHandoff({ prisma: unauthorized.prisma, handoffId: 'SHH1', actor: token('B1', [SYSTEM_ROLE_IDS.SALES]),
      action: 'start', input: { expectedUpdatedAt: '10' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a logistics discrepancy reason and rejects stale transition timestamps', async () => {
    const logistics = token('L1', [SYSTEM_ROLE_IDS.LOGISTICS]); shared.actors.set('L1', logistics);
    const missingReasonDb = makeHandoffDb();
    missingReasonDb.tx.shipmentHandoff.findUnique.mockResolvedValue({ ...missingReasonDb.getHandoff(), status: 'Processing' });
    await expect(transitionShipmentHandoff({ prisma: missingReasonDb.prisma, handoffId: 'SHH1', actor: logistics,
      action: 'return-to-business', input: { expectedUpdatedAt: '10' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const staleDb = makeHandoffDb();
    await expect(transitionShipmentHandoff({ prisma: staleDb.prisma, handoffId: 'SHH1', actor: logistics,
      action: 'start', input: { expectedUpdatedAt: '9' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(staleDb.tx.shipmentHandoff.updateMany).not.toHaveBeenCalled();
  });

  it('does not let complete bypass booked/document preparation or mark the Shipment shipped', async () => {
    const logistics = token('L1', [SYSTEM_ROLE_IDS.LOGISTICS]); shared.actors.set('L1', logistics);
    const db = makeHandoffDb();
    db.tx.shipmentHandoff.findUnique.mockResolvedValue({ ...db.getHandoff(), status: 'Processing' });
    await expect(transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: logistics,
      action: 'complete', input: { expectedUpdatedAt: '10' } })).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    expect(db.tx.shipmentHandoff.updateMany).not.toHaveBeenCalled();
    expect(shared.updateShipment).not.toHaveBeenCalled();
  });

  it('only the original business initiator can reply to a discrepancy or cancel a handoff', async () => {
    const delegate = token('B2', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B2', delegate);
    const db = makeHandoffDb();
    db.setHandoff({ ...db.getHandoff(), status: 'NeedsBusinessDecision', businessActorId: 'B1' });
    await expect(transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: delegate,
      action: 'return-to-logistics', input: { expectedUpdatedAt: '10', decision: 'accept_actual', response: '接受差异' } }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: delegate,
      action: 'cancel', input: { expectedUpdatedAt: '10', requestKey: UUID, response: '误发取消' } }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.tx.shipmentHandoff.updateMany).not.toHaveBeenCalled();
    expect(shared.updateShipment).not.toHaveBeenCalled();
  });

  it('accept_actual requires exact SOA and factory-branch actuals, then only records the decision and returns to Processing', async () => {
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const db = makeHandoffDb(), source = configureDecisionSource(db);
    const incomplete = { ...source.getPhysical()[0], actualQty: null,
      scopeSnapshot: { ...source.getPhysical()[0].scopeSnapshot, receiptAllocations: [{ stockReceiptId: 'R1', plannedQty: '5', actualQty: null, unit: 'pcs' }] } };
    source.setPhysical([incomplete]);
    await expect(transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: business,
      action: 'return-to-logistics', input: { expectedUpdatedAt: '10', decision: 'accept_actual', response: '接受实际装箱' } }))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED' });
    expect(db.tx.shipmentHandoff.updateMany).not.toHaveBeenCalled();

    source.setPhysical([{ ...incomplete, actualQty: '4',
      scopeSnapshot: { ...incomplete.scopeSnapshot, receiptAllocations: [{ stockReceiptId: 'R1', plannedQty: '5', actualQty: '4', unit: 'pcs' }] } }]);
    const accepted = await transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: business,
      action: 'return-to-logistics', input: { expectedUpdatedAt: '10', decision: 'accept_actual', response: '接受实际装箱' } });
    expect(accepted.handoff.status).toBe('Processing');
    expect(accepted.lines[0].plannedQty).toBe('5');
    expect(accepted.allocations[0].plannedQty).toBe('5');
    expect(accepted.shipment.status).toBe('Draft');
    expect(db.events.at(-1)).toMatchObject({ fromStatus: 'NeedsBusinessDecision', toStatus: 'Processing', actorId: 'B1', decision: 'accept_actual', note: '接受实际装箱' });
    expect(db.events.at(-1).payload.branches[0]).toMatchObject({ orderId: 'O1', orderLineId: 'OL1', productionBatchId: 'PB1', actualQty: '4', unit: 'pcs' });
    expect(shared.updateShipment).not.toHaveBeenCalled();
  });

  it('revise_plan passes exact Decimal/CAS values through the physical allocator and keeps the original handoff snapshot', async () => {
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const db = makeHandoffDb(), source = configureDecisionSource(db);
    shared.writePhysicalShipmentAllocation.mockImplementation(async ({ allocationId, input }: any) => {
      const nextAllocation = { ...source.getAllocation(), plannedQty: input.plannedQty, updatedAt: 21n };
      source.setAllocation(nextAllocation);
      source.setPhysical(source.getPhysical().map(row => ({ ...row, plannedQty: input.productionBatchAllocations[0].plannedQty,
        updatedAt: 21n, scopeSnapshot: { ...row.scopeSnapshot, allocationVersion: 2,
          receiptAllocations: [{ ...row.scopeSnapshot.receiptAllocations[0], plannedQty: input.productionBatchAllocations[0].plannedQty }] } })));
      return { ok: true, data: { allocation: { ...nextAllocation, id: allocationId, replayed: false } } };
    });
    const revised = await transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: business,
      action: 'return-to-logistics', input: { expectedUpdatedAt: '10', decision: 'revise_plan', response: '按工厂确认量修订',
        allocationRevisions: [{ allocationId: 'AL1', expectedAllocationUpdatedAt: '20', requestKey: UUID, plannedQty: '7.1250',
          productionBatchAllocations: [{ productionBatchId: 'PB1', productionBatchRevision: 2, factoryRelationId: 'F1',
            stockReceiptId: 'R1', plannedQty: '7.1250' }] }] } });
    expect(shared.writePhysicalShipmentAllocation).toHaveBeenCalledTimes(1);
    const physicalCommand = shared.writePhysicalShipmentAllocation.mock.calls[0][0].input;
    expect(physicalCommand).toMatchObject({ requestKey: UUID, expectedAllocationUpdatedAt: '20', plannedQty: '7.125', actualQty: '4' });
    expect(physicalCommand.productionBatchAllocations[0]).toMatchObject({ productionBatchId: 'PB1', expectedRevision: 2,
      expectedScopeFingerprint: 'a'.repeat(64), stockReceiptId: 'R1', plannedQty: '7.125', actualQty: '4', unit: 'pcs' });
    expect(revised.handoff.status).toBe('Processing');
    expect(revised.allocations[0].plannedQty).toBe('7.125');
    expect(revised.lines[0].plannedQty).toBe('5');
    expect(db.events.at(-1).payload.allocationRevisions[0]).toMatchObject({ allocationId: 'AL1', previousPlannedQty: '5',
      revisedPlannedQty: '7.125', unchangedActualQty: '4', productionBatchAllocations: [{ productionBatchId: 'PB1',
        previousPlannedQty: '5', revisedPlannedQty: '7.125', unchangedActualQty: '4' }] });
  });

  it('cancels a pending draft and releases physical reservations through the existing shipment mutation', async () => {
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const db = makeHandoffDb();
    shared.lockShipmentDocumentSourcesInTx.mockResolvedValue([{ kind: 'physical', allocations: [{ id: 'AL1' }], allocationFingerprint: 'fp-1' }]);
    shared.updateShipment.mockImplementation(async ({ tx, patch, physicalCommand }: any) => {
      const cancelled = { ...(await tx.shipment.findUnique()), ...patch, updatedAt: 11n };
      tx.shipment.findUnique.mockResolvedValue(cancelled);
      return { ok: true, data: { shipment: cancelled } };
    });
    const result = await transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: business,
      action: 'cancel', input: { expectedUpdatedAt: '10', requestKey: UUID, response: '误发，撤回' } });
    expect(result.handoff.status).toBe('Cancelled');
    expect(result.shipment.status).toBe('Cancelled');
    expect(shared.updateShipment).toHaveBeenCalledWith(expect.objectContaining({ patch: { status: 'Cancelled' },
      physicalCommand: expect.objectContaining({ requestKey: expect.stringMatching(/^handoff-cancel:/),
        expectedPhysicalAllocationFingerprint: 'fp-1' }) }));
    expect(db.events.at(-1)).toMatchObject({ fromStatus: 'PendingLogistics', toStatus: 'Cancelled', decision: 'cancel', actorId: 'B1' });
    expect(db.events.at(-1).payload.releasedAllocationIds).toEqual(['AL1']);
  });

  it.each([
    ['订舱', (db: ReturnType<typeof makeHandoffDb>) => db.setShipment({ ...db.getShipment(), bookingNo: 'BOOK-1' })],
    ['CI', (db: ReturnType<typeof makeHandoffDb>) => db.tx.tradeDocument.findMany.mockResolvedValue([{ id: 'CI1', type: 'CommercialInvoice', status: 'Draft' }])],
    ['PL', (db: ReturnType<typeof makeHandoffDb>) => db.tx.tradeDocument.findMany.mockResolvedValue([{ id: 'PL1', type: 'PackingList', status: 'Draft' }])],
    ['出口申报', (db: ReturnType<typeof makeHandoffDb>) => db.tx.tradeDocument.findFirst.mockResolvedValue({ id: 'PROOF1' })],
  ])('阻断已有%s事实的Pending取消且保持原状态', async (_label, setup) => {
    const business = token('B1', [SYSTEM_ROLE_IDS.SALES]); shared.actors.set('B1', business);
    const db = makeHandoffDb(); setup(db);
    await expect(transitionShipmentHandoff({ prisma: db.prisma, handoffId: 'SHH1', actor: business,
      action: 'cancel', input: { expectedUpdatedAt: '10', requestKey: UUID, response: '撤回' } })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(db.getHandoff().status).toBe('PendingLogistics');
    expect(db.getShipment().status).toBe('Draft');
    expect(db.tx.shipmentHandoff.updateMany).not.toHaveBeenCalled();
    expect(db.events).toHaveLength(0);
    expect(shared.updateShipment).not.toHaveBeenCalled();
  });
});
