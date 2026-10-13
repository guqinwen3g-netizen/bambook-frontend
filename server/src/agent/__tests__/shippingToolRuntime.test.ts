import { describe, expect, it, vi } from 'vitest';
import { legacySourceStorage, storageReader, storageRowLocks, storedShippingOperator } from './shippingLegacyStorageFixture';
import { handleShippingCreateShipment, handleShippingUpdateTrackingStatus } from '../toolRuntime';

// ============================================================================
// task review-fix: 真实 handler 执行测试（mock prisma tx）
// ============================================================================

function makeTx(opts: {
  shipmentCreate?: any;
  shipmentFind?: any;
  shipmentUpdate?: any;
  auditCreate?: any;
  syncRefs?: any; // entityReference/entityLink upsert（syncShipmentReferences 调用）
  orderFind?: any;
  orderUpdate?: any;
  allocations?: any[];
} = {}) {
  const shipmentCreate = opts.shipmentCreate ?? vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, orderId: data.orderId }));
  const shipmentFind = opts.shipmentFind ?? vi.fn().mockResolvedValue({ id: 'S1', status: 'Booked', orderId: 'O1', shipmentNumber: 'SHP1' });
  const shipmentUpdate = opts.shipmentUpdate ?? vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, orderId: 'O1', shipmentNumber: 'SHP1' }));
  const auditRows: any[] = [];
  const auditCreate = opts.auditCreate ?? vi.fn(async ({ data }: any) => { const row = { ...data }; auditRows.push(row); return { ...row }; });
  const entityRefUpsert = vi.fn().mockResolvedValue({});
  const entityLinkUpsert = vi.fn().mockResolvedValue({});
  const orderFind = opts.orderFind ?? vi.fn().mockResolvedValue({ id: 'O1', status: 'Pending', deletedAt: null });
  const orderUpdate = opts.orderUpdate ?? vi.fn().mockResolvedValue({});
  const orderStatusTransitionCreate = vi.fn().mockResolvedValue({});
  const shipmentEventCreate = vi.fn().mockResolvedValue({});

  const source = legacySourceStorage();
  // A complete original legacy source: contract and actual allocation both 100
  // pcs. No stock item or physical batch exists in this historical order store.
  source.rows.orderLines.push({ id: 'L1', orderId: 'O1', lineNumber: 1, itemNo: 'SKU-LEGACY-1',
    materialCode: null, quantity: '100', shipmentQuantity: 100, unit: 'pcs', tolerancePercent: '5', toleranceSource: null });
  const allocations = opts.allocations ?? [{ id: 'A1', shipmentId: 'S1', orderId: 'O1', orderLineId: 'L1',
    plannedQty: '100', actualQty: '100', unit: 'pcs', status: 'Fulfilled', createdAt: 1n, updatedAt: 1n }];
  const storedOperator = storedShippingOperator();
  const tx = {
    ...source.models,
    ...storedOperator.models,
    systemConfig: { findUnique: vi.fn(async ({ where }: any) => {
      if (where.scope_key?.scope !== 'global' || where.scope_key?.key !== 'tolerance.internal_standard') throw Error('Unknown fixture config query');
      return null;
    }) },
    // These handler cases are ordinary shipments; retain the real claim-source
    // check and explicitly return no matching disposition/repair work order.
    claimDisposition: { findMany: vi.fn().mockResolvedValue([]) },
    repairWorkOrder: { findMany: vi.fn().mockResolvedValue([]) },
    shipment: { create: shipmentCreate, findUnique: shipmentFind, update: shipmentUpdate,
      findMany: vi.fn(async (args: any) => { const row = await shipmentFind({ where: { id: 'S1' } });
        return storageReader(() => row ? [row] : []).findMany(args); }) },
    shipmentEvent: { create: shipmentEventCreate },
    shipmentOrderAllocation: storageReader(() => allocations),
    shipmentLine: { findMany: vi.fn().mockResolvedValue([]) }, // T3 H9 出运扣库存：空装运行 → 跳过留痕
    stockMovement: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    inventoryItem: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: auditCreate },
    entityReference: { upsert: entityRefUpsert },
    entityLink: { upsert: entityLinkUpsert },
    order: { findUnique: orderFind, update: orderUpdate,
      findFirst: vi.fn(async (args: any) => { const row = await orderFind({ where: { id: 'O1' } });
        return storageReader(() => row ? [row] : []).findFirst(args); }) },
    orderStatusTransition: { create: orderStatusTransitionCreate },
  };
  Object.assign(tx, { $queryRaw: storageRowLocks({ Order: async () => { const row = await orderFind({ where: { id: 'O1' } }); return row ? [row] : []; },
    OrderLine: () => source.rows.orderLines, ReleaseScope: () => source.rows.releaseScopes,
    Shipment: async () => { const row = await shipmentFind({ where: { id: 'S1' } }); return row ? [row] : []; },
    ShipmentOrderAllocation: () => allocations, ProductionBatch: () => source.rows.productionBatches,
    ShipmentProductionAllocation: () => source.rows.physicalAllocations }, source.rows.locks) });
  return { tx, source, allocations, auditRows, storedOperator, shipmentCreate, shipmentFind, shipmentUpdate, shipmentEventCreate, auditCreate, entityRefUpsert, entityLinkUpsert, orderFind, orderUpdate, orderStatusTransitionCreate };
}

function makePrisma(tx: any, txFail = false) {
  const $transaction = vi.fn(async (fn: any) => {
    if (txFail) throw new Error('TX_FAIL');
    return fn(tx);
  });
  // No downstream financial shipment batch is linked in this fixture. Provide
  // the real query seam instead of allowing a swallowed best-effort TypeError.
  const outerAuditRows: any[] = [];
  const auditLog = { ...storageReader(() => outerAuditRows), create: vi.fn(async ({ data }: any) => { const row = { ...data }; outerAuditRows.push(row); return { ...row }; }) };
  return { $transaction, auditLog, outerAuditRows, orderShipmentBatch: { findMany: vi.fn().mockResolvedValue([]) } } as any;
}

describe('task review-fix: handleShippingCreateShipment 真实执行', () => {
  it('status=Bad → INVALID_STATUS，$transaction/shipment.create/sync/audit/order-link 均不调用', async () => {
    const { tx, shipmentCreate, auditCreate, entityRefUpsert, orderFind } = makeTx();
    const prisma = makePrisma(tx);
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', status: 'BadStatus',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_STATUS');
    // $transaction 未进
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(shipmentCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(entityRefUpsert).not.toHaveBeenCalled();
    expect(orderFind).not.toHaveBeenCalled();
  });

  it('create 成功 → tx.auditLog.create 被调用（同事务）', async () => {
    const { tx, auditCreate } = makeTx();
    const prisma = makePrisma(tx);
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', status: 'Booked',
    });
    expect(r.ok).toBe(true);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    // 同一 tx（$transaction 只调一次）
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
  });

  it('auditLog.create reject → CREATE_FAILED，不伪成功', async () => {
    const { tx } = makeTx({ auditCreate: vi.fn().mockRejectedValue(new Error('AUDIT_FAIL')) });
    const prisma = makePrisma(tx);
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', status: 'Booked',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('CREATE_FAILED');
  });

  it('sync reject（entityReference.upsert）→ CREATE_FAILED', async () => {
    const { tx, entityRefUpsert } = makeTx();
    entityRefUpsert.mockRejectedValue(new Error('SYNC_FAIL'));
    const prisma = makePrisma(tx);
    // 传 orderId 触发 sync 生成 ops（syncShipmentReferences 需 orderId/customer/carrier）
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', orderId: 'O1', status: 'Booked',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('CREATE_FAILED');
  });

  it('linkOrderStatusFromShipment reject（order 终态）→ ORDER_TERMINAL', async () => {
    const { tx } = makeTx({ orderFind: vi.fn().mockResolvedValue({ id: 'O1', status: 'Delivered', deletedAt: null }) });
    const prisma = makePrisma(tx);
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', orderId: 'O1', status: 'Booked',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ORDER_TERMINAL');
  });
});

describe('task review-fix: handleShippingUpdateTrackingStatus 真实执行', () => {
  it('update 成功 → tx.auditLog.create 含 before/after', async () => {
    const { tx, auditCreate } = makeTx({
      shipmentFind: vi.fn().mockResolvedValue({ id: 'S1', status: 'Booked', orderId: 'O1', shipmentNumber: 'SHP1' }),
    });
    const prisma = makePrisma(tx);
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'S1', status: 'Shipped' });
    expect(r.ok).toBe(true);
    expect(auditCreate).toHaveBeenCalledTimes(2);
    const auditCall = auditCreate.mock.calls[0][0];
    // writeRouteAuditLog 把 before/after 包在 detail 里
    expect(auditCall.data.detail.before).toEqual({ status: 'Booked', shipmentNumber: 'SHP1' });
    expect(auditCall.data.detail.after).toEqual({ status: 'Shipped', shipmentNumber: 'SHP1' });
    const fieldAudit = auditCreate.mock.calls[1][0].data;
    expect(fieldAudit).toMatchObject({ action: 'update_shipment_field', targetType: 'Shipment', targetId: 'S1',
      fieldPath: 'status', beforeValue: 'Booked', afterValue: 'Shipped', transactionId: auditCall.data.id });
    expect(fieldAudit.actorId).toBe(auditCall.data.actorId);
    expect(tx.claimDisposition.findMany).toHaveBeenCalledWith({ where: { replacementShipmentId: 'S1' } });
    expect(tx.repairWorkOrder.findMany).toHaveBeenCalledWith({ where: { reshipmentId: 'S1' } });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('auditLog.create reject → UPDATE_FAILED，不伪成功', async () => {
    const { tx } = makeTx({ auditCreate: vi.fn().mockRejectedValue(new Error('AUDIT_FAIL')) });
    const prisma = makePrisma(tx);
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'S1', status: 'Shipped' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('UPDATE_FAILED');
    // Failure must reach the deliberately failing audit, not an unrelated
    // missing delegate before the transaction's original business assertion.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('sync reject → UPDATE_FAILED', async () => {
    const { tx, entityRefUpsert } = makeTx();
    entityRefUpsert.mockRejectedValue(new Error('SYNC_FAIL'));
    const prisma = makePrisma(tx);
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'S1', status: 'Shipped' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('UPDATE_FAILED');
    expect(entityRefUpsert).toHaveBeenCalled();
  });

  it('非法转移 Draft→Delivered → INVALID_TRANSITION', async () => {
    const { tx } = makeTx({
      shipmentFind: vi.fn().mockResolvedValue({ id: 'S1', status: 'Draft', orderId: null, shipmentNumber: 'SHP1' }),
    });
    const prisma = makePrisma(tx);
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'S1', status: 'Delivered' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_TRANSITION');
  });

  it('shipment 不存在 → SHIPMENT_NOT_FOUND', async () => {
    const { tx } = makeTx({ shipmentFind: vi.fn().mockResolvedValue(null) });
    const prisma = makePrisma(tx);
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'NOPE', status: 'Shipped' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SHIPMENT_NOT_FOUND');
  });
});

// ============================================================================
// F3：agent 直改路径同样落 ShipmentEvent（时间轴完整性单一来源）
// ============================================================================
const agentContext = { actor: { userId: 'agent', roles: ['admin'] as any, departmentIds: [],
  permissionScopes: ['orders:read', 'shipments:write'], permissionsAuthoritative: true,
  permissionCeiling: ['orders:read', 'shipments:write'], memoryScopes: [], knowledgeScopes: ['company'], toolScopes: ['shipping'] } };

describe('F3: agent 路径 ShipmentEvent 节点跟踪', () => {
  it('agent create → 事务内落首节点事件（fromNode=null，toNode=初始状态）', async () => {
    const { tx, shipmentEventCreate } = makeTx();
    const prisma = makePrisma(tx);
    const r = await handleShippingCreateShipment(prisma, {
      shipmentNumber: 'S1', type: 'Ocean', shippingMethod: 'FCL', status: 'Booked',
    }, agentContext);
    expect(r.ok).toBe(true);
    expect(shipmentEventCreate).toHaveBeenCalledTimes(1);
    expect(shipmentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromNode: null, toNode: 'Booked', actorId: 'agent' }),
      }),
    );
  });

  it('agent update_tracking 状态变更 → 落节点事件（from Booked → to Shipped）', async () => {
    const { tx, shipmentEventCreate } = makeTx();
    const prisma = makePrisma(tx);
    const r = await handleShippingUpdateTrackingStatus(prisma, { shipmentId: 'S1', status: 'Shipped' }, agentContext);
    expect(r.ok).toBe(true);
    expect(shipmentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shipmentId: 'S1', fromNode: 'Booked', toNode: 'Shipped', actorId: 'agent' }),
      }),
    );
  });
});

// These controls execute the unmocked canonical shipping/quantity/current-role
// helpers against explicit storage rows. The fixture transaction is not PG.
describe('Agent shipping legacy source and current authority controls', () => {
  it('an empty allocation table refuses Shipped without an update, audit or stock write', async () => {
    const f = makeTx({ allocations: [] });
    const r = await handleShippingUpdateTrackingStatus(makePrisma(f.tx), { shipmentId: 'S1', status: 'Shipped' });
    expect(r.ok).toBe(false); expect(r.error).toBe('SHIPMENT_NO_ALLOCATION_DETAIL');
    expect(f.shipmentUpdate).not.toHaveBeenCalled(); expect(f.auditCreate).not.toHaveBeenCalled();
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it('unknown actual quantity cannot borrow the planned 100 pcs or a shipping authority grant', async () => {
    const f = makeTx(); f.allocations[0].actualQty = null;
    const r = await handleShippingUpdateTrackingStatus(makePrisma(f.tx), { shipmentId: 'S1', status: 'Shipped' }, agentContext);
    expect(r.ok).toBe(false); expect(r.error).toBe('SHIPMENT_ACTUAL_QTY_MISSING');
    expect(f.shipmentUpdate).not.toHaveBeenCalled(); expect(f.auditCreate).not.toHaveBeenCalled();
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it('a current stored grant revocation defeats an old authoritative tool context before mutation', async () => {
    const f = makeTx(); f.storedOperator.account.roles[0].role.permissions = [];
    const r = await handleShippingUpdateTrackingStatus(makePrisma(f.tx), { shipmentId: 'S1', status: 'Loading' }, agentContext);
    expect(r.ok).toBe(false); expect(r.error).toBe('FORBIDDEN');
    expect(f.shipmentUpdate).not.toHaveBeenCalled(); expect(f.auditCreate).not.toHaveBeenCalled();
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it('an explicitly empty signed ceiling remains restrictive despite current role grants', async () => {
    const f = makeTx();
    const r = await handleShippingUpdateTrackingStatus(makePrisma(f.tx), { shipmentId: 'S1', status: 'Loading' },
      { actor: { ...agentContext.actor, permissionCeiling: [] } });
    expect(r.ok).toBe(false); expect(r.error).toBe('FORBIDDEN');
    expect(f.shipmentUpdate).not.toHaveBeenCalled(); expect(f.auditCreate).not.toHaveBeenCalled();
  });
  it('a body actor cannot turn a physical source into the trusted legacy actor seam', async () => {
    const f = makeTx(); f.source.rows.productionBatches.push({ id: 'PB1', orderId: 'O1', orderLineId: 'L1', state: 'active' });
    const r = await handleShippingUpdateTrackingStatus(makePrisma(f.tx),
      { shipmentId: 'S1', status: 'Loading', actor: agentContext.actor, actorId: 'agent' });
    expect(r.ok).toBe(false); expect(r.error).toBe('UNAUTHORIZED');
    expect(f.shipmentUpdate).not.toHaveBeenCalled(); expect(f.auditCreate).not.toHaveBeenCalled();
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it('the same real storage seam rejects unsupported SQL and returns only requested existing row ids', async () => {
    const journal: any[] = [], lock = storageRowLocks({ Order: () => [{ id: 'O1' }, { id: 'O2' }] }, journal);
    expect(await lock({ sql: 'SELECT "id" FROM "Order" WHERE "id"=? FOR UPDATE', values: ['O1'] })).toEqual([{ id: 'O1' }]);
    expect(await lock({ sql: 'SELECT "id" FROM "Order" WHERE "id"=? FOR UPDATE', values: ['missing'] })).toEqual([]);
    await expect(lock({ sql: 'SELECT "id" FROM "MissingModel" WHERE "id"=? FOR UPDATE', values: ['O1'] })).rejects.toThrow('Unsupported fixture SQL');
    await expect(lock({ sql: 'SELECT "id" FROM "Order" WHERE "id"=? FOR UPDATE; DELETE FROM "Order"', values: ['O1'] })).rejects.toThrow('Unsupported fixture SQL shape');
    expect(journal).toEqual([{ table: 'Order', ids: ['O1'], rows: ['O1'] }, { table: 'Order', ids: ['missing'], rows: [] }]);
  });
});
