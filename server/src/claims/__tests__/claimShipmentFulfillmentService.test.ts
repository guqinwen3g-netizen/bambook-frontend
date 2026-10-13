import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { bindClaimShipmentStock, createClaimRepairReturnShipment, getClaimShipmentStockBinding } from '../claimShipmentFulfillmentService';
import { claimShipmentDigest, assertClaimShipmentEligible, deductClaimShipmentStockInTx, finalizeClaimShipmentInTx, lockClaimShipmentSource } from '../claimShipmentFact';
import { claimRefusal } from '../claimApprovalFact';

// Receipt/repair facts and the inventory engine are independent upstream seams.
// These tests cover the consumer contract; they do not prove PG locks, rollback,
// current company accounts, or the real receipt/QC/approval facts themselves.
vi.mock('../claimReturnFulfillmentService', () => ({ lockClaimReturnContext: async (tx: any) => tx._context(),
  refreshClaimReturnHeader: async (tx: any) => { tx._headersRefreshed++; } }));
vi.mock('../claimRepairFulfillmentService', () => ({ lockClaimRepairContext: async (tx: any) => tx._repair(),
  readClaimRepairReleaseFact: async (tx: any, ctx: any) => {
    if (ctx.workOrder.status !== 'Completed' || !tx._qc) claimRefusal('缺完整真实完工/必要复检事实');
    return { completedEventId: 'DONE', inspectionId: 'QC', inspectionEventId: 'QC_EVENT' };
  } }));
vi.mock('../../shipping/shipmentMutationService', () => ({ createShipment: async ({ tx, input }: any) => {
  const shipment = await tx.shipment.create({ data: { ...input, id: 'NEW_RETURN', shipmentNumber: 'SH-RETURN' } });
  return tx._producerFailure ? { ok: false, error: { code: 'CREATE_FAILED' } } : { ok: true, data: { shipment } };
} }));
vi.mock('../../shipping/shipmentPackingService', () => ({ replaceShipmentLinesTx: async (tx: any, shipmentId: string, rows: any[]) => {
  if (tx._packingFailure) throw new Error('packing-failed');
  for (const row of rows) await tx.shipmentLine.create({ data: { ...row, id: 'NEW_PACKING', shipmentId, orderLineId: null } });
} }));
vi.mock('../../inventory/inventoryService', () => ({ createInventoryService: () => ({ createStockMovement: async (input: any, actor: string, { tx }: any) => {
  const item = tx._t.inventoryItem.find((row: any) => row.id === input.itemId);
  if (input.type === 'Unlock') {
    if (item.lockedQuantity < input.quantity) throw new Error('hold-insufficient');
    item.lockedQuantity -= input.quantity;
  } else {
    if (item.quantity - item.lockedQuantity < input.quantity) throw new Error('stock-insufficient');
    item.quantity -= input.quantity;
  }
  if (tx._inventoryFailure === input.type) throw new Error('inventory-failed');
  return tx.stockMovement.create({ data: { ...input, id: `MV${tx._t.stockMovement.length}`, warehouseId: item.warehouseId, operator: actor } });
} }) }));

function fixture(kind = 'Replace') {
  const T: Record<string, any[]> = {
    claimDisposition: [{ id: 'D', kind, status: 'Executed', replacementShipmentId: kind === 'Replace' ? 'SH' : null,
      repairWorkOrderId: kind === 'Repair' ? 'RW' : null, materialCode: 'SKU', quantity: new Prisma.Decimal(10), unit: 'PCS' }],
    repairWorkOrder: kind === 'Repair' ? [{ id: 'RW', status: 'Completed', reshipmentId: null }] : [],
    returnReceiptLine: [{ id: 'LINE', claimDispositionId: 'D', returnReceiptId: 'RT', materialCode: 'SKU', unit: 'PCS',
      expectedQuantity: new Prisma.Decimal(10), receivedQuantity: new Prisma.Decimal(10), status: 'Received' }],
    shipment: kind === 'Replace' ? [{ id: 'SH', shipmentNumber: 'SH-1', customerRelationId: 'CUSTOMER', customerName: 'Client',
      orderId: null, status: 'Draft' }] : [],
    shipmentLine: kind === 'Replace' ? [{ id: 'PACK', shipmentId: 'SH', productCode: 'SKU', quantity: new Prisma.Decimal(10), unit: 'PCS', orderLineId: null }] : [],
    warehouse: [{ id: 'WH', isActive: true }],
    inventoryItem: [{ id: 'ITEM', materialCode: 'SKU', warehouseId: 'WH', batchNumber: 'LOT1', unit: 'PCS', ownership: 'Owned',
      quantity: 20, lockedQuantity: kind === 'Repair' ? 10 : 0 }],
    order: [], shipmentOrderAllocation: [], stockMovement: [], auditLog: [],
  };
  const db: any = { _t: T, _headersRefreshed: 0, _qc: true, $queryRawUnsafe: vi.fn(async () => []) };
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([k, v]) => (row[k] ?? null) === (v ?? null));
  for (const name of Object.keys(T)) db[name] = {
    findUnique: vi.fn(async ({ where }: any) => T[name].find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => T[name].filter(row => matches(row, where))),
    create: vi.fn(async ({ data }: any) => { T[name].push(data); return data; }),
    update: vi.fn(async ({ where, data }: any) => { const i = T[name].findIndex(row => matches(row, where)); T[name][i] = { ...T[name][i], ...data }; return T[name][i]; }),
  };
  db._context = () => ({ disposition: T.claimDisposition[0], line: T.returnReceiptLine[0],
    receipt: { id: 'RT', warehouseId: 'WH' }, claimCase: { id: 'CASE', customerRelationId: 'CUSTOMER', customerName: 'Client' },
    fact: { contentFingerprint: 'FULL_APPROVAL' } });
  db._repair = () => ({ ...db._context(), workOrder: T.repairWorkOrder[0], bindingFingerprint: 'ACTUAL_REPAIR_BATCH',
    batches: [{ item: T.inventoryItem[0], audit: { id: 'RECEIVE' }, inbound: { id: 'IN', quantity: new Prisma.Decimal(10) },
      hold: { id: 'HOLD' }, fact: { parameters: { quantity: '10' } } }] });
  // Synthetic storage restoration models service rollback, not PostgreSQL semantics.
  db.$transaction = vi.fn(async (fn: any) => { const before = Object.fromEntries(Object.entries(T).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
    try { return await fn(db); } catch (error) { Object.assign(T, before); throw error; } });
  return db;
}
const selection = { clientRequestId: 'STOCK1', expectedRevision: 0, items: [{ itemId: 'ITEM', quantity: '10', unit: 'PCS' }] };
const returnDraft = { clientRequestId: 'RETURN1', shippingMethod: 'Pickup' };

describe('售后物流实际批次绑定/返还合同（上游替身）', () => {
  it('首次真实补发库存读取明确0版本空选择，仍带准确批准scope，零写入', async () => {
    const db = fixture(); const result = await getClaimShipmentStockBinding(db, 'SH');
    expect(result.data).toMatchObject({ shipmentId: 'SH', currentRevision: 0, revision: 0, stockBindingEventId: null, items: [],
      scope: { claimCaseId: 'CASE', claimDispositionId: 'D', materialCode: 'SKU', quantity: '10', unit: 'PCS', warehouseId: 'WH', contentFingerprint: 'FULL_APPROVAL' } });
    expect(db.auditLog.create).not.toHaveBeenCalled(); expect(db.shipment.update).not.toHaveBeenCalled();
  });
  it('重进读取当前真实revision及批次，旧选择保留，当前货权仍独立复核', async () => {
    const db = fixture(); await bindClaimShipmentStock(db, 'SH', selection, 'warehouse');
    await bindClaimShipmentStock(db, 'SH', { ...selection, clientRequestId: 'STOCK2', expectedRevision: 1 }, 'warehouse');
    db.auditLog.create.mockClear(); const result = await getClaimShipmentStockBinding(db, 'SH');
    expect(result.data).toMatchObject({ currentRevision: 2, revision: 2, items: [{ itemId: 'ITEM', batchNumber: 'LOT1', stockQuantity: '10' }] });
    expect(db._t.auditLog).toHaveLength(2); expect(db.auditLog.create).not.toHaveBeenCalled();
    db._t.inventoryItem[0].ownership = 'Transferred';
    expect((await getClaimShipmentStockBinding(db, 'SH')).error?.code).toBe('INVALID_STATE');
  });
  it.each(['ordinary', 'foreign-customer', 'packing-scope', 'broken-audit'])('读取%s真实来源不符拒绝，notes不能授权空0版本', async variant => {
    const db = fixture();
    if (variant === 'ordinary') { db._t.claimDisposition[0].replacementShipmentId = null; db._t.shipment[0].notes = '[补发] CASE'; }
    if (variant === 'foreign-customer') db._t.shipment[0].customerRelationId = 'FOREIGN';
    if (variant === 'packing-scope') db._t.shipmentLine[0].quantity = new Prisma.Decimal(9);
    if (variant === 'broken-audit') { await bindClaimShipmentStock(db, 'SH', selection, 'warehouse'); db._t.auditLog[0].detail.claimStock.bindingFingerprint = 'tampered'; }
    expect((await getClaimShipmentStockBinding(db, 'SH')).error?.code).toBe('INVALID_STATE');
    expect(db._t.stockMovement).toHaveLength(0);
  });
  it('补发绑定server实际批次+版本+批准范围，稳定同actor参数重试零写入', async () => {
    const db = fixture(); const first = await bindClaimShipmentStock(db, 'SH', selection, 'warehouse');
    expect(first.ok).toBe(true); expect(first.data).toMatchObject({ revision: 1, currentRevision: 1,
      scope: { materialCode: 'SKU', quantity: '10', unit: 'PCS' }, items: [{ itemId: 'ITEM', batchNumber: 'LOT1', ownership: 'Owned', stockQuantity: '10' }] });
    db.auditLog.create.mockClear(); const repeat = await bindClaimShipmentStock(db, 'SH', selection, 'warehouse');
    expect(repeat.data!.replayed).toBe(true); expect(db.auditLog.create).not.toHaveBeenCalled();
    expect((await bindClaimShipmentStock(db, 'SH', selection, 'other')).ok).toBe(false);
    expect((await bindClaimShipmentStock(db, 'SH', { ...selection, items: [{ ...selection.items[0], quantity: 9 }] }, 'warehouse')).ok).toBe(false);
  });
  it.each([null, undefined, -1, 21, NaN])('未知或不实的锁定数量 %s 不可按零预选补发库存', async locked => {
    const db = fixture(); db._t.inventoryItem[0].lockedQuantity = locked;
    const result = await bindClaimShipmentStock(db, 'SH', selection, 'warehouse');
    expect(result.ok).toBe(false); expect(result.error?.code).toBe('INVALID_STATE');
    expect(db._t.stockMovement).toHaveLength(0); expect(db._t.auditLog).toHaveLength(0);
  });
  it('修订库存只追加正确版本，旧请求回原版本+currentRevision且不覆盖', async () => {
    const db = fixture(); await bindClaimShipmentStock(db, 'SH', selection, 'warehouse');
    expect((await bindClaimShipmentStock(db, 'SH', { ...selection, clientRequestId: 'STOCK2', expectedRevision: 0 }, 'warehouse')).ok).toBe(false);
    expect((await bindClaimShipmentStock(db, 'SH', { ...selection, clientRequestId: 'STOCK2', expectedRevision: 1 }, 'warehouse')).data!.revision).toBe(2);
    expect((await bindClaimShipmentStock(db, 'SH', selection, 'warehouse')).data).toMatchObject({ revision: 1, currentRevision: 2 });
    expect(db._t.auditLog).toHaveLength(2);
  });
  it.each(['warehouse', 'sku', 'quantity', 'locked', 'unit', 'status', 'injected'])('实际%s不符拒绝绑定，不写库存/审计', async field => {
    const db = fixture(); let input: any = selection;
    if (field === 'warehouse') db._t.inventoryItem[0].warehouseId = 'OTHER';
    if (field === 'sku') db._t.inventoryItem[0].materialCode = 'OTHER';
    if (field === 'quantity') input = { ...selection, items: [{ ...selection.items[0], quantity: 9 }] };
    if (field === 'locked') db._t.inventoryItem[0].lockedQuantity = 20;
    if (field === 'unit') db._t.inventoryItem[0].unit = 'KG';
    if (field === 'status') db._t.shipment[0].status = 'Shipped';
    if (field === 'injected') input = { ...selection, approved: true };
    expect((await bindClaimShipmentStock(db, 'SH', input, 'warehouse')).ok).toBe(false);
    expect(db._t.auditLog).toHaveLength(0); expect(db._t.stockMovement).toHaveLength(0);
  });
  it('Transferred须真实source Order同客户许可，不能凭notes放行，也不改货权', async () => {
    const db = fixture(); const item = db._t.inventoryItem[0]; item.ownership = 'Transferred'; item.orderId = 'O';
    expect((await bindClaimShipmentStock(db, 'SH', selection, 'warehouse')).ok).toBe(false);
    db._t.order.push({ id: 'O', customerRelationId: 'OTHER' });
    expect((await bindClaimShipmentStock(db, 'SH', selection, 'warehouse')).ok).toBe(false);
    db._t.order[0].customerRelationId = 'CUSTOMER';
    expect((await bindClaimShipmentStock(db, 'SH', selection, 'warehouse')).data!.items[0]).toMatchObject({ ownership: 'Transferred', entitlement: { orderId: 'O', customerRelationId: 'CUSTOMER' } });
    expect(item.ownership).toBe('Transferred'); db._t.order[0].customerRelationId = 'OTHER';
    await expect(assertClaimShipmentEligible(db, await lockClaimShipmentSource(db, 'SH'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('M→YD只用唯一换算口径，损坏库存换算audit不能授权', async () => {
    const db = fixture(); db._t.claimDisposition[0].unit = db._t.returnReceiptLine[0].unit = db._t.shipmentLine[0].unit = 'M';
    db._t.inventoryItem[0].unit = 'YD';
    const out = await bindClaimShipmentStock(db, 'SH', { ...selection, items: [{ ...selection.items[0], unit: 'M' }] }, 'warehouse');
    expect(out.data!.items[0].stockQuantity).toBe('10.9361');
    const fact = db._t.auditLog[0].detail.claimStock; fact.items[0].stockQuantity = '9'; fact.bindingFingerprint = claimShipmentDigest(fact.items);
    await expect(assertClaimShipmentEligible(db, await lockClaimShipmentSource(db, 'SH'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('无真实选择不出运，选择后仅扣明确item，不会主仓任选或跳缺库存', async () => {
    const db = fixture(); const source = await lockClaimShipmentSource(db, 'SH');
    await expect(deductClaimShipmentStockInTx(db, db, source, 'logistics')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await bindClaimShipmentStock(db, 'SH', selection, 'warehouse');
    const out = await deductClaimShipmentStockInTx(db, db, source, 'logistics');
    expect(out.movementCount).toBe(1); expect(db._t.stockMovement[0]).toMatchObject({ type: 'Outbound', itemId: 'ITEM', quantity: 10 });
    expect(db._t.inventoryItem[0].quantity).toBe(10); expect(db._t.inventoryItem[0].lockedQuantity).toBe(0);
    await expect(deductClaimShipmentStockInTx(db, db, source, 'logistics')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('selection审计必需，失败不会留下新版本（storage rollback）', async () => {
    const db = fixture(); db.auditLog.create.mockRejectedValueOnce(new Error('mandatory-audit-failed'));
    await expect(bindClaimShipmentStock(db, 'SH', selection, 'warehouse')).rejects.toThrow('mandatory-audit-failed');
    expect(db._t.auditLog).toHaveLength(0);
  });
  it('返修完整实际batch+完工QC才建真实装运行草稿，同请求只返回原票', async () => {
    const db = fixture('Repair'); const created = await createClaimRepairReturnShipment(db, 'RW', returnDraft, 'logistics');
    expect(created.ok).toBe(true); expect(created.data!.shipment).toMatchObject({ id: 'NEW_RETURN', customerRelationId: 'CUSTOMER', status: 'Draft' });
    expect(db._t.shipmentLine[0]).toMatchObject({ productCode: 'SKU', quantity: '10', unit: 'PCS', orderLineId: null });
    expect((await createClaimRepairReturnShipment(db, 'RW', returnDraft, 'logistics')).data!.replayed).toBe(true);
    expect(db._t.shipment).toHaveLength(1); expect(db._t.shipmentLine).toHaveLength(1);
    expect((await createClaimRepairReturnShipment(db, 'RW', { ...returnDraft, shippingMethod: 'Sea' }, 'logistics')).ok).toBe(false);
  });
  it.each(['qc', 'producer', 'packing', 'audit'])('返还%s失败不能留下header、line或RW链接（storage rollback）', async field => {
    const db = fixture('Repair'); if (field === 'qc') db._qc = false;
    if (field === 'producer') db._producerFailure = true;
    if (field === 'packing') db._packingFailure = true;
    if (field === 'audit') db.auditLog.create.mockRejectedValueOnce(new Error('mandatory-audit-failed'));
    if (field === 'qc') expect((await createClaimRepairReturnShipment(db, 'RW', returnDraft, 'logistics')).ok).toBe(false);
    else await expect(createClaimRepairReturnShipment(db, 'RW', returnDraft, 'logistics')).rejects.toThrow();
    expect(db._t.shipment).toHaveLength(0); expect(db._t.shipmentLine).toHaveLength(0); expect(db._t.repairWorkOrder[0].reshipmentId).toBe(null);
  });
  it('返修严格Unlock→Outbound原实收批次，保持ownership并绑定completion/QC再推Shipped', async () => {
    const db = fixture('Repair'); db._t.inventoryItem[0].ownership = 'Transferred';
    await createClaimRepairReturnShipment(db, 'RW', returnDraft, 'logistics');
    const source = await lockClaimShipmentSource(db, 'NEW_RETURN');
    await deductClaimShipmentStockInTx(db, db, source, 'logistics'); db._t.shipment[0].status = 'Shipped'; await finalizeClaimShipmentInTx(db, source, 'logistics');
    expect(db._t.stockMovement.map((row: any) => row.type)).toEqual(['Unlock', 'Outbound']);
    expect(db._t.inventoryItem[0]).toMatchObject({ quantity: 10, lockedQuantity: 0, ownership: 'Transferred' });
    expect(db._t.repairWorkOrder[0].status).toBe('Shipped'); expect(db._t.returnReceiptLine[0].status).toBe('Dispositioned');
    const audit = db._t.auditLog.find((row: any) => row.action === 'CLAIM_RETURN_DISPOSED');
    expect(audit.detail.claimReturn).toMatchObject({ outcome: 'RepairedReturned', parameters: { receivedEventId: 'RECEIVE' },
      completedEventId: 'DONE', inspectionId: 'QC', batch: { itemId: 'ITEM', ownership: 'Transferred' } });
  });
});
