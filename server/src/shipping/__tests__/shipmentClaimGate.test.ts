import { describe, expect, it, vi } from 'vitest';
import { storageReader, storageRowLocks } from './shippingSourceStorageFixture';
import { updateShipment } from '../shipmentMutationService';
import { replaceShipmentLinesTx } from '../shipmentPackingService';

// Controlled domain/stock seams verify the shared write path and the post-lock
// reread. They are not proof of PG blocking/deadlock freedom or physical stock.
const spies = vi.hoisted(() => ({ deduct: vi.fn(), reverse: vi.fn(), finalize: vi.fn(),
  short: vi.fn(), consume: vi.fn(), gate: vi.fn(), publish: vi.fn() }));
vi.mock('../../claims/claimShipmentFact', () => ({
  lockClaimShipmentSource: async (tx: any) => {
    if (!tx._claim) return null;
    tx._steps.push('domain-lock'); await tx._afterWait?.();
    return { shipment: { ...tx._shipment }, disposition: { id: 'D' } };
  }, finalizeClaimShipmentInTx: (...args: any[]) => spies.finalize(...args),
  deductClaimShipmentStockInTx: (...args: any[]) => spies.deduct(...args),
}));
vi.mock('../shipmentStockService', () => ({ deductShipmentStockInTx: (...args: any[]) => spies.deduct(...args),
  reverseShipmentStockInTx: (...args: any[]) => spies.reverse(...args), STOCK_DEDUCTED_STATUSES: new Set(['Shipped', 'Arrived', 'Cleared', 'Delivered']) }));
vi.mock('../shipmentEligibilityGate', () => ({ evaluateShipmentReleaseGate: (...args: any[]) => spies.gate(...args) }));
vi.mock('../shortShipmentGate', async () => ({ ...(await vi.importActual<any>('../shortShipmentGate')),
  evaluateShortShipment: (...args: any[]) => spies.short(...args) }));
vi.mock('../../exceptions/exceptionService', () => ({ createExceptionService: () => ({ consumeException: (...args: any[]) => spies.consume(...args) }) }));
vi.mock('../../entities/sync', () => ({ syncShipmentReferences: async () => {}, deactivateEntityLinks: async () => {} }));
vi.mock('../orderLinkService', () => ({ linkOrderStatusFromShipment: async () => ({ ok: true, skipped: true }) }));
vi.mock('../orderShipmentBatchService', () => ({ createOrderShipmentBatchService: () => ({ autoAdvanceOnShipmentShipped: async () => {} }) }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: (...args: any[]) => spies.publish(...args) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: async () => 'A', writeFieldAuditDiff: async () => [] }));
vi.mock('../../products/fabricExclusivityService', () => ({ assertFabricAllowed: async () => {} }));

function fixture(claim = true) {
  const db: any = { _claim: claim, _steps: [], _shipment: { id: 'SH', shipmentNumber: 'SH-1', status: 'Booked',
    orderId: null, shippingMethod: 'Courier', trackingNumber: 'TRACK1' },
    shipment: { findUnique: vi.fn(async () => ({ ...db._shipment })),
      update: vi.fn(async ({ data }: any) => { Object.assign(db._shipment, data); db._steps.push('header-write'); return { ...db._shipment }; }) },
    shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
    shipmentEvent: { create: vi.fn(async () => ({})) },
    shipmentLine: { deleteMany: vi.fn(), findMany: vi.fn(async () => []), create: vi.fn() },
  };
  const source = { dispositions: claim ? [{ id: 'D', replacementShipmentId: 'SH' }] : [],
    repairs: [] as any[], batches: [] as any[], physical: [] as any[], lines: [] as any[], scopes: [] as any[], locks: [] as any[] };
  db._source = source;
  db.claimDisposition = storageReader(() => source.dispositions);
  db.repairWorkOrder = storageReader(() => source.repairs);
  db.productionBatch = storageReader(() => source.batches);
  db.shipmentProductionAllocation = storageReader(() => source.physical);
  db.orderLine = storageReader(() => source.lines);
  db.releaseScope = storageReader(() => source.scopes);
  db.sample = storageReader(() => []);
  db.$queryRaw = storageRowLocks({ Shipment: () => [db._shipment], Order: () => db._shipment.orderId ? [{ id: db._shipment.orderId }] : [],
    OrderLine: () => source.lines, ReleaseScope: () => source.scopes, ProductionBatch: () => source.batches }, source.locks);
  db.$transaction = vi.fn(async (fn: any) => { const before = { ...db._shipment };
    try { return await fn(db); } catch (e) { db._shipment = before; throw e; } });
  spies.gate.mockResolvedValue({ ok: true, data: { orders: [] } });
  spies.short.mockResolvedValue({ noAllocationDetail: false, unfilled: [], blocked: [], approved: [] });
  spies.deduct.mockImplementation(async () => { db._steps.push('deduct'); return { movementCount: 1 }; });
  spies.finalize.mockImplementation(async (tx: any) => { expect(tx._shipment.status).toBe('Shipped'); db._steps.push('repair-projection'); });
  spies.consume.mockResolvedValue({ ok: true, data: { consumed: true } });
  spies.publish.mockResolvedValue(undefined);
  return db;
}
const update = (db: any, patch: any = { status: 'Shipped', atd: '2026-10-07' }, tx?: any) => updateShipment({ prisma: db, tx, shipmentId: 'SH',
  patch, hasStatus: Object.prototype.hasOwnProperty.call(patch, 'status'), actorId: 'logistics' });

describe('售后与普通物流共用写入口边界（受控替身）', () => {
  it('没有实际离港日期时不能从 Booked 确认成 Shipped', async () => {
    vi.clearAllMocks(); const db = fixture(false);
    const result = await updateShipment({ prisma: db, shipmentId: 'SH', patch: { status: 'Shipped' }, hasStatus: true, actorId: 'logistics' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('ATD');
    expect(db._shipment.status).toBe('Booked');
    expect(spies.gate).not.toHaveBeenCalled();
    expect(spies.deduct).not.toHaveBeenCalled();
  });

  it('claim独立已批准装运行替代普通订单分配，真实扣库/头状态/返修投影同tx', async () => {
    vi.clearAllMocks(); const db = fixture(); expect((await update(db)).ok).toBe(true);
    expect(spies.short).not.toHaveBeenCalled(); expect(spies.deduct).toHaveBeenCalledWith(db, db, 'SH', 'SH-1', 'logistics');
    expect(db._steps).toEqual(['domain-lock', 'deduct', 'header-write', 'repair-projection']);
  });
  it('运输必填仍拒绝、真实库存失败整笔不推Shipped（storage rollback）', async () => {
    vi.clearAllMocks(); const db = fixture(); db._shipment.trackingNumber = null;
    expect((await update(db)).error?.code).toBe('SHIPMENT_FIELD_REQUIRED_MISSING'); expect(spies.deduct).not.toHaveBeenCalled(); expect(db._shipment.status).toBe('Booked');
    db._shipment.trackingNumber = 'TRACK1'; spies.deduct.mockRejectedValueOnce(new Error('actual-inventory-failed'));
    expect((await update(db)).ok).toBe(false); expect(db._shipment.status).toBe('Booked'); expect(spies.finalize).not.toHaveBeenCalled();
  });
  it('lock后看到新Shipped，不重复扣库；装箱不能用等待前旧Booked删除明细', async () => {
    vi.clearAllMocks(); const db = fixture(); db._afterWait = async () => { db._shipment.status = 'Shipped'; };
    expect((await update(db)).ok).toBe(true); expect(spies.deduct).not.toHaveBeenCalled();
    await expect(replaceShipmentLinesTx(db, 'SH', [], 'logistics')).rejects.toMatchObject({ code: 'INVALID_CURRENT_STATUS' });
    expect(db.shipmentLine.deleteMany).not.toHaveBeenCalled();
  });
  it('claim客户/来源身份禁止物流patch改写；取消不走不完整普通回冲', async () => {
    vi.clearAllMocks(); const db = fixture();
    expect((await update(db, { customerRelationId: 'OTHER' })).error?.code).toBe('INVALID_STATE');
    expect((await update(db, { status: 'Cancelled' })).error?.code).toBe('INVALID_STATE');
    expect(spies.reverse).not.toHaveBeenCalled(); expect(db.shipment.update).not.toHaveBeenCalled();
  });
  it('普通订单短装和正常stock路径保持，不进入claim投影', async () => {
    vi.clearAllMocks(); const db = fixture(false); expect((await update(db)).ok).toBe(true);
    expect(spies.short).toHaveBeenCalledWith(db, { shipmentId: 'SH', physicalSource: false }); expect(spies.finalize).not.toHaveBeenCalled();
  });
  it('实际使用EXC同tx消费准确Order/action/actor，消费失败不放行', async () => {
    vi.clearAllMocks(); const db = fixture(false); db._shipment.orderId = 'O';
    spies.gate.mockResolvedValue({ ok: true, data: { orders: [{ orderId: 'O', via: 'exception', exception: { id: 'EXC' } }] } });
    expect((await update(db)).ok).toBe(true);
    expect(spies.consume).toHaveBeenCalledWith({ exceptionId: 'EXC', targetType: 'Order', targetId: 'O', action: 'shipment:release', consumedBy: 'logistics', tx: db });
    db._shipment.status = 'Booked'; spies.consume.mockResolvedValueOnce({ ok: false, error: { code: 'EXCEPTION_ALREADY_CONSUMED' } });
    spies.deduct.mockClear(); expect((await update(db)).error?.code).toBe('GATE_BLOCKED');
    expect(db._shipment.status).toBe('Booked'); expect(spies.deduct).not.toHaveBeenCalled();
  });
  it('正常gate不误烧EXC，外层claim tx未commit不发布业务事件', async () => {
    vi.clearAllMocks(); const db = fixture(); expect((await update(db, { status: 'Shipped', atd: '2026-10-07' }, db)).ok).toBe(true);
    expect(spies.consume).not.toHaveBeenCalled(); expect(spies.publish).not.toHaveBeenCalled();
  });
});


describe('Ordinary source guard before controlled claim/stock seams', () => {
  it('a physical batch cannot reach legacy gate or stock using only actorId', async () => {
    vi.clearAllMocks(); const db = fixture(false); db._shipment.orderId = 'O';
    db._source.batches.push({ id: 'PB1', orderId: 'O', orderLineId: 'OL1', state: 'active' });
    const result = await update(db);
    expect(result.ok).toBe(false); expect(result.error?.code).toBe('UNAUTHORIZED');
    expect(db._shipment.status).toBe('Booked'); expect(db.shipment.update).not.toHaveBeenCalled();
    expect(spies.deduct).not.toHaveBeenCalled(); expect(spies.gate).not.toHaveBeenCalled(); expect(spies.short).not.toHaveBeenCalled();
    expect(db._source.locks.some((row: any) => row.table === 'Shipment')).toBe(true);
  });
});


describe('Actual modern shortage evaluation, without the controlled eligibility spy', () => {
  it('physicalSource:true cannot turn an unknown actual quantity or historical zero association into dispatch detail', async () => {
    const actual = await vi.importActual<typeof import('../shortShipmentGate')>('../shortShipmentGate');
    const db = fixture(false);
    db._source.batches.push({ id: 'PB1', orderId: 'O', orderLineId: 'OL1', state: 'active' });
    db._source.physical.push({ id: 'P1', shipmentId: 'SH', productionBatchId: 'PB1', allocationId: 'A1', state: 'reserved' });
    db._source.lines.push({ id: 'OL1', orderId: 'O', quantity: '10', shipmentQuantity: '0', unit: 'M' });
    const rows = [{ id: 'A1', shipmentId: 'SH', orderId: 'O', orderLineId: 'OL1', plannedQty: '10', actualQty: null },
      { id: 'historical-zero', shipmentId: 'SH', orderId: 'O', orderLineId: null, plannedQty: '0', actualQty: '0' }];
    db.shipmentOrderAllocation = storageReader(() => rows);
    const result = await actual.evaluateShortShipment(db, { shipmentId: 'SH', physicalSource: true });
    expect(result.unfilled.map(row => row.orderLineId)).toEqual(['OL1']);
    expect(result.judgedLines).toBe(0); expect(result.blocked).toEqual([]); expect(result.approved).toEqual([]);
    rows.splice(0, 1);
    const zeroOnly = await actual.evaluateShortShipment(db, { shipmentId: 'SH', physicalSource: true });
    expect(zeroOnly.noAllocationDetail).toBe(true); expect(zeroOnly.judgedLines).toBe(0);
    expect(db.shipment.update).not.toHaveBeenCalled(); expect(db._shipment.status).toBe('Booked');
  });
});
