import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { businessError } from '../../shared/errorCodes';
import { serializeSettlementValue } from '../../lib/serializeSettlementValue';
import { deductPhysicalShipmentStockInTx, reversePhysicalShipmentStockInTx, physicalShipmentFactoryLoadings } from '../shipmentPhysicalStockService';

const seams = vi.hoisted(() => ({ authority: vi.fn(), scope: vi.fn(), validate: vi.fn(), receipt: vi.fn(), direct: vi.fn() }));
vi.mock('../shipmentPhysicalAllocationService', () => ({ assertPhysicalShipmentWriteAuthority: seams.authority,
  verifyOriginalProductionReceipt: seams.receipt }));
vi.mock('../shipmentPhysicalConsumerService', () => ({ validateReservedPhysicalShipment: seams.validate }));
vi.mock('../factoryLoadingReceiptService', () => ({ verifyFactoryLoadingReceiptInTx: seams.direct }));
vi.mock('../../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: seams.scope }));
vi.mock('../../entities/sync', () => ({ syncStockMovementReferences: vi.fn() }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// No DB/native source/authority proof. Source validation, authorization and
// entity-graph integration are explicit seams. The real inventory Decimal/CAS
// and mandatory audit implementations run against this storage fixture.
// rollback() is a caller simulation, not PostgreSQL rollback/concurrency proof.
function fixture() {
  const actor: any = { userId: 'U1', permissionCeiling: ['orders:read', 'shipments:write'] };
  const context: any = { kind: 'physical', actor, shipment: { id: 'SH1' }, orderIds: ['O1'],
    allocations: [], physical: [], batches: [{ id: 'B1', orderId: 'O1', orderLineId: 'L1', revision: 1, unit: 'PC' }] };
  const rows: any[] = ['R2', 'R1'].map((receiptId, index) => ({ allocationId: `SOA-${receiptId}`, physicalAllocationId: `SPA-${receiptId}`,
    orderId: 'O1', orderLineId: 'L1', productionBatchId: 'B1', stockReceiptId: receiptId,
    inventoryItemId: `ITEM-${receiptId}`, warehouseId: `WH-${receiptId}`, stockMovementId: `IN-${receiptId}`,
    productionBatchRevision: 1, receivedQuantity: '10', receiptScopeFingerprint: 'a'.repeat(64),
    receiptCommandHash: 'b'.repeat(64), unit: 'PC', plannedQty: '9', actualQty: index ? '1.0001' : '2.9999' }));
  const items = new Map<string, any>(rows.map(row => [row.inventoryItemId, { id: row.inventoryItemId,
    warehouseId: row.warehouseId, orderId: row.orderId, unit: row.unit, quantity: new Prisma.Decimal('10'), lockedQuantity: new Prisma.Decimal(0),
    ownership: 'Transferred', unitCost: new Prisma.Decimal('12.9999'), deletedAt: null }]));
  const warehouses = new Map<string, any>(rows.map(row => [row.warehouseId, { id: row.warehouseId, isActive: true, deletedAt: null }]));
  const receipts = new Map<string, any>(rows.map(row => [row.stockReceiptId, { id: row.stockReceiptId,
    productionBatchId: row.productionBatchId, productionBatchRevision: row.productionBatchRevision, orderId: row.orderId,
    orderLineId: row.orderLineId, warehouseId: row.warehouseId, inventoryItemId: row.inventoryItemId, unit: row.unit }]));
  const movements: any[] = [], audits: any[] = [], locks: any[] = [];
  const state: any = { visible: true, failAudit: null };
  const tx: any = {
    $queryRaw: vi.fn(async (sql: any) => {
      const table = sql.sql.match(/FROM "([^"]+)"/)[1], ids = sql.values;
      locks.push({ table, ids });
      const map = table === 'FactoryLoadingReceipt' ? directReceipts : table === 'ProductionStockReceipt' ? receipts : table === 'Warehouse' ? warehouses : items;
      return ids.filter((id: string) => map.has(id)).map((id: string) => ({ id }));
    }),
    productionStockReceipt: { findUnique: vi.fn(async ({ where }: any) => receipts.get(where.id) ?? null) },
    warehouse: { findUnique: vi.fn(async ({ where }: any) => warehouses.get(where.id) ?? null) },
    inventoryItem: { findUnique: vi.fn(async ({ where }: any) => items.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const item = items.get(where.id);
        if (!item || !item.quantity.equals(where.quantity) || !item.lockedQuantity.equals(where.lockedQuantity)) return { count: 0 };
        item.quantity = item.quantity.plus(data.quantity.increment);
        return { count: 1 };
      }) },
    order: { findFirst: vi.fn(async () => state.visible ? { id: 'O1' } : null) },
    stockMovement: { findMany: vi.fn(async ({ where }: any) => movements.filter(row => row.referenceType === where.referenceType
      && row.referenceId === where.referenceId && where.type.in.includes(row.type))),
      findUnique: vi.fn(async ({ where }: any) => movements.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, createdAt: BigInt(data.createdAt), targetWarehouseId: null }; movements.push(row); return row; }) },
    auditLog: { create: vi.fn(async ({ data }: any) => {
      if (data.action === state.failAudit) throw new Prisma.PrismaClientKnownRequestError('injected audit FK failure', { code: 'P2003', clientVersion: 'unit-seam' });
      audits.push(data); return data;
    }) },
  };
  const prisma: any = { $transaction: vi.fn(() => { throw Error('must use external tx'); }) };
  const directReceipts = new Map<string, any>();
  seams.authority.mockImplementation(async (_tx: any, prior: any) => prior);
  seams.scope.mockResolvedValue({ ownerId: 'U1' });
  seams.validate.mockImplementation(async (_tx: any, current: any) => ({ context: current, rows,
    physicalBatchIdsByOrder: { O1: ['B1'] } }));
  seams.receipt.mockImplementation(async (_tx: any, receiptId: string, batch: any, scopeFingerprint: string) => {
    const row = rows.find(row => row.stockReceiptId === receiptId), receipt = receipts.get(receiptId), item = items.get(receipt?.inventoryItemId);
    if (!row || !receipt || !item || batch.id !== receipt.productionBatchId || batch.revision !== receipt.productionBatchRevision
      || scopeFingerprint !== row.receiptScopeFingerprint) throw businessError('CONFLICT', 'receipt seam refused');
    return { receipt, item, available: item.quantity.minus(item.lockedQuantity), identity: {
      stockReceiptId: row.stockReceiptId, warehouseId: row.warehouseId, inventoryItemId: row.inventoryItemId,
      stockMovementId: row.stockMovementId, productionBatchRevision: receipt.productionBatchRevision, receivedQuantity: row.receivedQuantity,
      unit: row.unit, receiptScopeFingerprint: row.receiptScopeFingerprint, receiptCommandHash: row.receiptCommandHash } };
  });
  const verified: any = { context, rows, physicalBatchIdsByOrder: { O1: ['B1'] } };
  async function rollback<T>(body: () => Promise<T>): Promise<T> {
    const oldItems = new Map([...items].map(([key, value]) => [key, { ...value }])), oldMovements = [...movements], oldAudits = [...audits];
    try { return await body(); }
    catch (error) { items.clear(); for (const [key, value] of oldItems) items.set(key, value);
      movements.splice(0, movements.length, ...oldMovements); audits.splice(0, audits.length, ...oldAudits); throw error; }
  }
  const deduct = () => deductPhysicalShipmentStockInTx(tx, prisma, verified, actor.userId);
  const addDirect = () => {
    const row: any = { sourceKind: 'factory_direct', factoryLoadingReceiptId: 'FLR-1', allocationId: 'SOA-DIRECT', physicalAllocationId: 'SPA-DIRECT',
      orderId: 'O1', orderLineId: 'L1', productionBatchId: 'B1', productionBatchRevision: 1, factoryRelationId: 'F1', handoffId: 'H1', shipmentId: 'SH1',
      loadedQuantity: '3.125', unit: 'PC', loadingScopeFingerprint: 'c'.repeat(64), loadingCommandHash: 'd'.repeat(64), plannedQty: '3.125', actualQty: '3.125', stockReceiptId: null };
    rows.push(row); directReceipts.set(row.factoryLoadingReceiptId, { id: row.factoryLoadingReceiptId, quantity: new Prisma.Decimal(row.loadedQuantity) });
    context.physical.push({ id: row.physicalAllocationId, allocationId: row.allocationId, orderId: row.orderId, orderLineId: row.orderLineId,
      productionBatchId: row.productionBatchId, productionBatchRevision: row.productionBatchRevision, scopeSnapshot: { receiptAllocations: [row] } });
    seams.direct.mockImplementation(async (_tx: any, receiptId: string, batch: any, fingerprint: string, ownership: any) => {
      if (receiptId !== row.factoryLoadingReceiptId || batch.revision !== 1 || batch.factoryRelationId !== 'F1' || fingerprint !== row.loadingScopeFingerprint
        || ownership.shipmentId !== row.shipmentId || ownership.allocationId !== row.allocationId) throw businessError('CONFLICT', 'direct source seam refused');
      return { receipt: directReceipts.get(receiptId), identity: { sourceKind: row.sourceKind, factoryLoadingReceiptId: row.factoryLoadingReceiptId, handoffId: row.handoffId,
        shipmentId: row.shipmentId, productionBatchRevision: row.productionBatchRevision, factoryRelationId: row.factoryRelationId,
        loadedQuantity: row.loadedQuantity, unit: row.unit, loadingScopeFingerprint: row.loadingScopeFingerprint, loadingCommandHash: row.loadingCommandHash } };
    });
    return row;
  };
  return { actor, context, rows, verified, tx, prisma, items, warehouses, receipts, directReceipts, addDirect, movements, audits, locks, state, rollback, deduct };
}

beforeEach(() => vi.resetAllMocks());

describe('factory-direct shipment inventory boundary', () => {
  // This internal stock reversal primitive does not authorize cancellation of
  // a public shipment with an actual ATD. Handoff lifecycle guards own that rule.
  it('dispatches direct proof with zero stock movements and low-level reversal retains its immutable receipt without fake Inbound', async () => {
    const f = fixture(); f.rows.splice(0); f.addDirect(); const factoryLoadings = physicalShipmentFactoryLoadings(f.verified);
    const stockMovements = await f.deduct(); expect(stockMovements).toEqual([]); expect(f.movements).toEqual([]);
    expect(f.locks).toEqual([{ table: 'FactoryLoadingReceipt', ids: ['FLR-1'] }]);
    expect(f.tx.inventoryItem.updateMany).not.toHaveBeenCalled(); expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
    f.context.batches[0].revision = 9; f.context.batches[0].factoryRelationId = 'F2';
    const reversed = await reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements, factoryLoadings }, f.actor.userId);
    expect(reversed).toEqual([]); expect(f.directReceipts.size).toBe(1); expect(f.movements).toEqual([]);
    expect(seams.direct).toHaveBeenCalledWith(f.tx, 'FLR-1', expect.objectContaining({ revision: 1, factoryRelationId: 'F1' }), 'c'.repeat(64), expect.objectContaining({ shipmentId: 'SH1' }));
    expect(f.audits.at(-1).detail.after.releasedFactoryLoadingReceiptIds).toEqual(['FLR-1']);
  });
  it('mixed dispatch and cancellation move only exact native receipt quantities', async () => {
    const f = fixture(); f.addDirect(); const factoryLoadings = physicalShipmentFactoryLoadings(f.verified);
    const stockMovements = await f.deduct(); expect(stockMovements).toHaveLength(2); expect(factoryLoadings[0].quantity).toBe('3.125');
    const reversed = await reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements, factoryLoadings }, f.actor.userId);
    expect(reversed).toHaveLength(2); expect(f.movements).toHaveLength(4); expect(f.directReceipts.size).toBe(1);
    expect([...f.items.values()].map(item => item.quantity.toString())).toEqual(['10', '10']);
  });
  it('refuses changed or missing direct frozen proof before any reversal', async () => {
    const f = fixture(); f.rows.splice(0); f.addDirect(); await f.deduct();
    const factoryLoadings = physicalShipmentFactoryLoadings(f.verified);
    await expect(reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: [], factoryLoadings: [{ ...factoryLoadings[0], quantity: '3' }] }, f.actor.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    f.directReceipts.clear();
    await expect(reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: [], factoryLoadings }, f.actor.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it('rejects post-lock direct source drift and source authorization failure without touching any inventory', async () => {
    const f = fixture(); f.rows.splice(0); const direct = f.addDirect();
    seams.validate.mockResolvedValueOnce({ ...f.verified, rows: [{ ...direct, actualQty: '3' }] });
    await expect(f.deduct()).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.visible = false; await expect(f.deduct()).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled(); expect(f.tx.inventoryItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('physical shipment inventory executes exact original receipt identities', () => {
  it('locks sorted PSR, warehouse and item; deducts actual quantities from both exact warehouses', async () => {
    const f = fixture(), map = await f.deduct();
    expect(f.locks).toEqual([{ table: 'ProductionStockReceipt', ids: ['R1', 'R2'] },
      { table: 'Warehouse', ids: ['WH-R1', 'WH-R2'] }, { table: 'InventoryItem', ids: ['ITEM-R1', 'ITEM-R2'] }]);
    expect(map.map(row => [row.stockReceiptId, row.warehouseId, row.quantity])).toEqual([['R1', 'WH-R1', '1.0001'], ['R2', 'WH-R2', '2.9999']]);
    expect(f.items.get('ITEM-R1').quantity.toString()).toBe('8.9999');
    expect(f.items.get('ITEM-R2').quantity.toString()).toBe('7.0001');
    expect(f.items.get('ITEM-R1').ownership).toBe('Transferred');
    expect(map[0].movement.unitCost).toBe('12.9999');
    expect(typeof map[0].movement.createdAt).toBe('string');
    expect(f.audits.map(row => row.action)).toEqual(['stock_movement_outbound', 'stock_movement_outbound', 'deduct_physical_shipment_stock']);
    expect(seams.authority).toHaveBeenCalledWith(f.tx, f.actor);
    expect(seams.scope).toHaveBeenCalledWith(f.tx, f.actor);
    expect(seams.validate).toHaveBeenCalledWith(f.tx, f.context, true);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Decimal18,4 never passes through the legacy number slot', async () => {
    const f = fixture(); f.rows.splice(1);
    const row = f.rows[0]; row.receivedQuantity = '99999999999999.9999'; row.actualQty = '99999999999999.9998';
    f.items.get(row.inventoryItemId).quantity = new Prisma.Decimal(row.receivedQuantity);
    const map = await f.deduct();
    expect(map[0].quantity).toBe('99999999999999.9998');
    expect(map[0].movement.balanceAfter).toBe('0.0001');
    expect(f.items.get(row.inventoryItemId).quantity.toString()).toBe('0.0001');
  });

  it.each([null, undefined, '0', '1e1', '1.00001', Infinity])('unknown/nonpositive/nonexact actual %s never falls back to planned', async actualQty => {
    const f = fixture(); f.rows[0].actualQty = actualQty;
    await expect(f.deduct()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('post-lock source drift is refused before a movement is written', async () => {
    const f = fixture();
    seams.validate.mockResolvedValueOnce({ ...f.verified, rows: [{ ...f.rows[0], actualQty: '3' }, f.rows[1]] });
    await expect(f.deduct()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('aggregate exact actual exceeds the shared receipt available balance before any deduction', async () => {
    const f = fixture(); const first = f.rows[0]; first.actualQty = '6';
    f.rows[1] = { ...first, allocationId: 'SOA-OTHER', physicalAllocationId: 'SPA-OTHER' };
    f.items.get(first.inventoryItemId).lockedQuantity = new Prisma.Decimal('2');
    await expect(f.deduct()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('the original receipt must reverify after stock locks; a forged warehouse identity is refused', async () => {
    const f = fixture(); const verify = seams.receipt.getMockImplementation()!;
    seams.receipt.mockImplementation(async (...args: any[]) => { const result: any = await verify(...args);
      return { ...result, identity: { ...result.identity, warehouseId: 'WH-FOREIGN' } }; });
    await expect(f.deduct()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it.each(['Outbound', 'Inbound'])('any existing Shipment %s is a conflict rather than a fake idempotent success', async type => {
    const f = fixture(); f.movements.push({ id: 'UNEXPLAINED', referenceType: 'Shipment', referenceId: 'SH1', type });
    await expect(f.deduct()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('a rejected fresh-authority seam prevents stock writes and retains signed cap input', async () => {
    const f = fixture(); f.actor.permissionCeiling = [];
    seams.authority.mockRejectedValueOnce(businessError('FORBIDDEN', 'revoked authority seam'));
    await expect(f.deduct()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(seams.authority).toHaveBeenCalledWith(f.tx, expect.objectContaining({ permissionCeiling: [] }));
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('hidden parent or a different execution actor cannot write stock', async () => {
    const f = fixture(); f.state.visible = false;
    await expect(f.deduct()).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    f.state.visible = true;
    await expect(deductPhysicalShipmentStockInTx(f.tx, f.prisma, f.verified, 'OTHER')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it.each(['stock_movement_outbound', 'deduct_physical_shipment_stock'])('mandatory %s error reaches caller rollback seam', async action => {
    const f = fixture(); f.state.failAudit = action;
    await expect(f.rollback(f.deduct)).rejects.toMatchObject({ code: 'P2003' });
    expect(f.tx.stockMovement.create).toHaveBeenCalled(); // positive control: the injected failure occurs after staging a real native ledger row
    expect(f.movements).toEqual([]); expect(f.audits).toEqual([]);
    expect([...f.items.values()].map(item => item.quantity.toString())).toEqual(['10', '10']);
  });
});

describe('physical cancellation reverses the frozen exact Outbound set', () => {
  it('invalidated/split current batch does not block a correct historical return; every original row gets one reverse', async () => {
    const f = fixture(), map = await f.deduct();
    f.context.batches[0].state = 'invalidated'; f.context.batches[0].revision = 2;
    seams.validate.mockClear(); seams.validate.mockRejectedValue(new Error('current batch must not be qualified during cancellation'));
    seams.receipt.mockClear();
    const reversed = await reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: map }, f.actor.userId);
    expect(reversed.map(row => row.originalOutboundId)).toEqual(map.map(row => row.movement.id));
    expect(reversed.map(row => row.quantity)).toEqual(map.map(row => row.quantity));
    expect(reversed.every(row => row.movement.type === 'Inbound')).toBe(true);
    expect(seams.validate).not.toHaveBeenCalled();
    expect(seams.receipt.mock.calls.every(call => call[2].revision === 1)).toBe(true);
    expect([...f.items.values()].map(item => item.quantity.toString())).toEqual(['10', '10']);
    expect(f.audits[f.audits.length - 1].detail.after.stockMovements).toEqual(reversed);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['missing', 'extra', 'changed', 'inbound'])('%s actual ledger set refuses cancellation before any new Inbound', async damage => {
    const f = fixture(), map = await f.deduct();
    if (damage === 'missing') f.movements.pop();
    if (damage === 'extra') f.movements.push({ ...f.movements[0], id: 'FOREIGN-OUT' });
    if (damage === 'changed') f.movements[0] = { ...f.movements[0], unitCost: new Prisma.Decimal('99') };
    if (damage === 'inbound') f.movements.push({ ...f.movements[0], id: 'UNEXPLAINED-IN', type: 'Inbound' });
    f.tx.stockMovement.create.mockClear();
    await expect(reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: map }, f.actor.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('duplicate original Outbound cannot be reversed twice through a second allocation identity', async () => {
    const f = fixture(), map = await f.deduct();
    const corrupt = [...map, { ...map[0], physicalAllocationId: 'SPA-FOREIGN' }];
    f.tx.stockMovement.create.mockClear();
    await expect(reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: corrupt }, f.actor.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('missing historical receipt proof is refused, and existing Inbound never grants low-level replay', async () => {
    const f = fixture(), map = await f.deduct();
    seams.receipt.mockRejectedValueOnce(businessError('CONFLICT', 'historical audit seam missing'));
    await expect(reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: map }, f.actor.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: map }, f.actor.userId);
    f.tx.stockMovement.create.mockClear();
    await expect(reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: map }, f.actor.userId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('mandatory reverse audit error escapes the tx; caller simulation retains original Outbound and balance', async () => {
    const f = fixture(), map = await f.deduct(), before = serializeSettlementValue(f.movements);
    const balances = [...f.items.values()].map(item => item.quantity.toString());
    f.state.failAudit = 'reverse_physical_shipment_stock';
    await expect(f.rollback(() => reversePhysicalShipmentStockInTx(f.tx, f.prisma, f.context, { stockMovements: map }, f.actor.userId))).rejects.toMatchObject({ code: 'P2003' });
    expect(serializeSettlementValue(f.movements)).toEqual(before);
    expect([...f.items.values()].map(item => item.quantity.toString())).toEqual(balances);
    expect(f.tx.stockMovement.create.mock.calls.some((call: any[]) => call[0].data.type === 'Inbound')).toBe(true);
  });

  it('SQL lock failure is propagated, never treated as missing stock or a skipped line', async () => {
    const f = fixture(); f.tx.$queryRaw.mockRejectedValueOnce(new Error('lock SQL fault'));
    await expect(f.deduct()).rejects.toThrow('lock SQL fault');
    expect(f.tx.stockMovement.create).not.toHaveBeenCalled();
  });
});
