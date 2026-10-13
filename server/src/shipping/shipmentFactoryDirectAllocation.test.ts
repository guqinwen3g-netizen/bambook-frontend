import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qcReportSourceFingerprint as hash } from '../qc/qcReportAuthority';
import { exactJsonValue } from '../lib/exactJsonValue';
import { businessError } from '../shared/errorCodes';
const seams = vi.hoisted(() => ({ actor: null as any, coverage: vi.fn(), direct: vi.fn() }));
vi.mock('../auth/tokenHelpers', () => ({ loadUserWithRoles: vi.fn(async (_tx, id) => ({ id, status: 'active' })), buildLoadedAuthTokenPayload: vi.fn(async () => seams.actor) }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})), isOrderLineStorageConflict: () => false }));
vi.mock('../production/releaseService', () => ({ lockReleaseSources: vi.fn(async () => undefined) }));
vi.mock('../production/productionBatchService', () => ({ resolveCurrentProductionBatchFacts: vi.fn(async () => ({})) }));
vi.mock('../qc/qcPhysicalCoverage', () => ({ resolveQcCoverage: seams.coverage }));
vi.mock('../shared/orderLineShippedQty', () => ({ syncOrderLineShipmentQuantity: vi.fn(async () => undefined) }));
vi.mock('./factoryLoadingReceiptService', () => ({ verifyFactoryLoadingReceiptInTx: seams.direct }));
import { writePhysicalShipmentAllocation } from './shipmentPhysicalAllocationService';
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
function fixture() {
  const scopeSnapshot = { batch: 'B1', factory: 'F1', revision: 1 }, scopeFingerprint = hash(scopeSnapshot);
  seams.coverage.mockResolvedValue({ scopeType: 'production_batch', scopeKey: 'production_batch:B1', scopeFingerprint, scopeSnapshot });
  const batch: any = { id: 'B1', orderId: 'O1', orderLineId: 'L1', factoryRelationId: 'F1', revision: 1, state: 'active', unit: 'pcs', quantity: '10' };
  const shipments = new Map<string, any>(['S1', 'S2'].map(id => [id, { id, status: 'Draft', orderId: 'O1', deletedAt: null, updatedAt: BigInt(1) }]));
  const allocations = new Map<string, any>(), physical = new Map<string, any>(), handoffs = new Map<string, any>(), audits: any[] = [], locks: string[] = [];
  const match = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, expected]: any) => {
    if (key === 'OR') return expected.some((choice: any) => match(row, choice));
    if (key === 'AND') return expected.every((choice: any) => match(row, choice));
    if (expected && typeof expected === 'object') return (!expected.in || expected.in.includes(row[key])) && (expected.not === undefined || row[key] !== expected.not);
    return row[key] === expected;
  });
  const delegate = (rows: Map<string, any>) => ({ findMany: vi.fn(async ({ where = {} }: any = {}) => [...rows.values()].filter(row => match(row, where)).sort((a, b) => a.id.localeCompare(b.id))),
    findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null), findFirst: vi.fn(async ({ where }: any) => [...rows.values()].find(row => match(row, where)) ?? null),
    create: vi.fn(async ({ data }: any) => { rows.set(data.id, { ...data }); return rows.get(data.id); }),
    update: vi.fn(async ({ where, data }: any) => { const row = { ...rows.get(where.id), ...data }; rows.set(where.id, row); return row; }) });
  const order = { id: 'O1', deletedAt: null, customerRelationId: 'C1', consigneeRelationId: 'D1', businessLine: 'garment' };
  const tx: any = { $queryRaw: vi.fn(async (sql: any) => { locks.push(sql.sql); return []; }), shipment: delegate(shipments),
    shipmentOrderAllocation: delegate(allocations), shipmentProductionAllocation: delegate(physical),
    shipmentHandoff: { findUnique: vi.fn(async ({ where }: any) => handoffs.get(where.shipmentId) ?? null) },
    productionBatch: { findMany: vi.fn(async () => [batch]) }, order: { findFirst: vi.fn(async () => order) },
    orderLine: { findUnique: vi.fn(async () => ({ id: 'L1', orderId: 'O1', unit: 'pcs' })) },
    claimDisposition: { findFirst: vi.fn(async () => null) }, repairWorkOrder: { findFirst: vi.fn(async () => null) },
    productionStockReceipt: { findMany: vi.fn(async () => []) }, auditLog: {
      findMany: vi.fn(async ({ where }: any) => audits.filter(row => match(row, where))),
      create: vi.fn(async ({ data }: any) => { const value = json(data); audits.push(value); return value; }) } };
  const write = (shipmentId: string, input: any, allocationId?: string, operation = 'record-actual') => writePhysicalShipmentAllocation({ prisma: {} as any, tx,
    actor: seams.actor, shipmentId, allocationId, input, ...(handoffs.has(shipmentId) ? { handoffAuthorization: { handoffId: handoffs.get(shipmentId).id, operation: operation as any } } : {}) });
  const plan = (qty: string, key: string) => ({ requestKey: key, orderId: 'O1', orderLineId: 'L1', unit: 'pcs', plannedQty: qty, actualQty: null,
    productionBatchAllocations: [{ productionBatchId: 'B1', expectedRevision: 1, expectedScopeFingerprint: scopeFingerprint, stockReceiptId: null, plannedQty: qty, actualQty: null, unit: 'pcs' }] });
  const loading = async () => {
    const initial = await write('S1', plan('5', 'original-plan'));
    const allocation = initial.data.allocation; handoffs.set('S1', { id: 'H1', status: 'Processing' });
    seams.direct.mockImplementation(async (_tx: any, receiptId: string, current: any, fingerprint: string, ownership: any) => {
      if (receiptId !== 'FLR1' || current.id !== 'B1' || fingerprint !== scopeFingerprint || ownership.shipmentId !== 'S1' || ownership.allocationId !== allocation.id)
        throw businessError('CONFLICT', 'direct proof ownership refused');
      return { receipt: { quantity: '4' }, identity: { sourceKind: 'factory_direct', factoryLoadingReceiptId: 'FLR1', handoffId: 'H1', shipmentId: 'S1',
        factoryRelationId: 'F1', productionBatchRevision: 1, loadedQuantity: '4', unit: 'pcs', loadingScopeFingerprint: scopeFingerprint, loadingCommandHash: 'd'.repeat(64) } };
    });
    const input = { ...plan('5', 'actual'), expectedAllocationUpdatedAt: String(allocation.updatedAt), actualQty: '4', productionBatchAllocations: [
      { ...plan('4', 'unused').productionBatchAllocations[0], factoryLoadingReceiptId: 'FLR1', actualQty: '4' },
      { ...plan('1', 'unused').productionBatchAllocations[0], actualQty: '0' }] };
    const loaded = await write('S1', input, allocation.id); return { allocationId: allocation.id, input, loaded };
  };
  return { tx, batch, shipments, allocations, physical, handoffs, audits, locks, write, plan, loading };
}
beforeEach(() => { vi.clearAllMocks(); seams.actor = { userId: 'L1', authorizationLoaded: true, roleIds: ['role-logistics'], roles: [], permissions: ['orders:read', 'shipments:write'] }; });
describe('real physical allocator with factory-direct evidence and immutable allocation history', () => {
  it('late-binds a plan to a direct fact with an exact zero remainder, no Warehouse identity and versioned audit', async () => {
    const f = fixture(), { loaded, input, allocationId } = await f.loading();
    const branch = loaded.data.allocation.productionBatchAllocations[0];
    expect(branch).toMatchObject({ plannedQty: '5', actualQty: '4', scopeSnapshot: { allocationVersion: 2 } });
    expect(branch.scopeSnapshot.receiptAllocations[0]).toMatchObject({ factoryLoadingReceiptId: 'FLR1', sourceKind: 'factory_direct', stockReceiptId: null, plannedQty: '4', actualQty: '4' });
    expect(branch.scopeSnapshot.receiptAllocations[0]).not.toHaveProperty('warehouseId');
    expect(f.tx.inventoryItem).toBeUndefined(); expect(f.locks.some(sql => sql.includes('"FactoryLoadingReceipt"'))).toBe(true);
    expect(f.audits).toHaveLength(2);
    expect((await f.write('S1', input, allocationId)).data.allocation.replayed).toBe(true); expect(f.audits).toHaveLength(2);
  });
  it('allows order-only business owner to reserve its pending handoff, never actual loading or another owner', async () => {
    seams.actor = { userId: 'BUSINESS1', authorizationLoaded: true, roleIds: ['role-sales'], roles: [], permissions: ['orders:read', 'orders:write'] };
    const f = fixture();
    f.handoffs.set('S1', { id: 'H1', businessActorId: 'BUSINESS1', status: 'PendingLogistics' });
    const result = await f.write('S1', f.plan('5', 'business-plan'), undefined, 'create');
    expect(result.data.allocation.plannedQty).toBe('5');
    await expect(f.write('S1', f.plan('5', 'business-actual'), result.data.allocation.id, 'record-actual')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.handoffs.set('S2', { id: 'H2', businessActorId: 'OTHER', status: 'PendingLogistics' });
    await expect(f.write('S2', f.plan('5', 'foreign-plan'), undefined, 'create')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.allocations.size).toBe(1);
  });
  it('counts a direct reservation at max(plan, actual), allowing only the shared batch remaining capacity', async () => {
    const f = fixture(); await f.loading();
    await expect(f.write('S2', f.plan('6', 'over-reservation'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.allocations.size).toBe(1);
    const remaining = await f.write('S2', f.plan('5', 'remaining')); expect(remaining.data.allocation.plannedQty).toBe('5');
  });
  it('counts a shipped direct source at actual quantity and never reserves its immutable receipt a second time', async () => {
    const f = fixture(); await f.loading(); f.shipments.get('S1').status = 'Shipped';
    for (const row of f.physical.values()) row.state = 'shipped';
    const remaining = await f.write('S2', f.plan('6', 'after-shipping')); expect(remaining.data.allocation.plannedQty).toBe('6');
    await expect(f.write('S2', { ...f.plan('6', 'foreign-receipt'), expectedAllocationUpdatedAt: String(remaining.data.allocation.updatedAt), actualQty: '4',
      productionBatchAllocations: [{ ...f.plan('6', 'unused').productionBatchAllocations[0], factoryLoadingReceiptId: 'FLR1', actualQty: '4' }] }, remaining.data.allocation.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
