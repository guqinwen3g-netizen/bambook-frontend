import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildClaimApprovalPayload, CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET } from '../claimApprovalFact';
import { receiveClaimReturn, scrapClaimReturn } from '../claimReturnFulfillmentService';
import { convertLength } from '../../lib/unitConversion';

// Only the inventory-service seam is replaced. This does not prove the real inventory CAS/PG transaction.
const inventoryMovement = vi.hoisted(() => vi.fn());
vi.mock('../../inventory/inventoryService', () => ({ createInventoryService: () => ({ createStockMovement: inventoryMovement }) }));

function fixture(destination = 'Scrap') {
  const c: any = { id: 'CASE', caseNumber: 'CLM-2026-1000', status: 'Handled', problemDesc: '坏货', reportedBy: 'sales', reportedAt: '2026-10-01', createdAt: BigInt(1000) };
  const d: any = { id: 'DISP', claimCaseId: c.id, kind: 'ReturnRefund', materialCode: 'SKU_1', quantity: new Prisma.Decimal(10), unit: 'PCS',
    amount: new Prisma.Decimal(100), currency: 'USD', returnDisposition: destination, status: 'Executed', returnReceiptId: 'RT',
    creditNoteId: 'CN', approverId: 'leader', approvedAt: '2026-10-01', createdAt: BigInt(2000) };
  const payload = buildClaimApprovalPayload(d, c);
  const decidedAt = new Date('2026-10-01T01:00:00Z');
  const T: Record<string, any[]> = { claimCase: [c], claimDisposition: [d],
    approvalRequest: [{ id: 'AP', requesterId: 'sales', reviewerId: 'leader', status: 'approved', actionType: CLAIM_APPROVAL_ACTION,
      targetType: CLAIM_APPROVAL_TARGET, targetId: d.id, payload, decidedAt }],
    auditLog: [{ id: 'DECISION', actorId: 'leader', targetType: 'ApprovalRequest', targetId: 'AP', detail: {
      decisionActorAuthority: { userId: 'leader', roleIds: ['role-admin'], authorizationLoaded: true },
      approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: CLAIM_APPROVAL_ACTION, targetType: CLAIM_APPROVAL_TARGET,
        targetId: d.id, contentFingerprint: payload.contentFingerprint, decisionActorId: 'leader', decidedAt: decidedAt.toISOString() } } }],
    returnReceipt: [{ id: 'RT', receiptNumber: 'RT-2026-1000', claimCaseId: c.id, warehouseId: 'WH', status: 'Draft' }],
    returnReceiptLine: [{ id: 'LINE', returnReceiptId: 'RT', claimDispositionId: d.id, materialCode: 'SKU_1', expectedQuantity: new Prisma.Decimal(10),
      receivedQuantity: new Prisma.Decimal(0), unit: 'PCS', disposition: destination, status: 'Draft' }],
    inventoryItem: [{ id: 'ITEM', materialCode: 'SKU_1', warehouseId: 'WH', unit: 'PCS', quantity: new Prisma.Decimal(20),
      lockedQuantity: new Prisma.Decimal(3), batchNumber: 'LOT1', ownership: 'Transferred' }],
    warehouse: [{ id: 'WH', isActive: true }], stockMovement: [] };
  const equal = (a: any, b: any) => a instanceof Prisma.Decimal ? a.equals(b ?? 0) : (a ?? null) === (b ?? null);
  function match(row: any, where: any): boolean { return !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((part: any) => match(row, part));
    if (key === 'detail' && value.path) return equal(value.path.reduce((out: any, part: string) => out?.[part], row.detail), value.equals);
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    return equal(row[key], value);
  }); }
  const db: any = { _t: T, $queryRawUnsafe: vi.fn(async () => []) };
  for (const name of Object.keys(T)) db[name] = {
    findUnique: vi.fn(async ({ where }: any) => T[name].find(row => match(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => T[name].filter(row => match(row, where))),
    create: vi.fn(async ({ data }: any) => { T[name].push(data); return data; }),
    update: vi.fn(async ({ where, data }: any) => { const index = T[name].findIndex(row => match(row, where)); T[name][index] = { ...T[name][index], ...data }; return T[name][index]; }),
  };
  // Storage rollback simulation, not PostgreSQL rollback/locking evidence.
  db.$transaction = vi.fn(async (fn: any) => {
    const before = Object.fromEntries(Object.entries(T).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
    try { return await fn(db); } catch (error) { Object.assign(T, before); throw error; }
  });
  inventoryMovement.mockReset().mockImplementation(async (input: any, actorId: string, opts: any) => {
    expect(opts.tx).toBe(db);
    const item = T.inventoryItem.find(row => row.id === input.itemId);
    const quantity = item.unit === input.unit ? input.quantity : convertLength(input.quantity, input.unit, item.unit)!;
    const qty = new Prisma.Decimal(quantity);
    if (input.type === 'Inbound') item.quantity = item.quantity.plus(qty);
    if (input.type === 'Lock') item.lockedQuantity = item.lockedQuantity.plus(qty);
    if (input.type === 'Unlock') { if (item.lockedQuantity.lt(qty)) throw new Error('insufficient-lock'); item.lockedQuantity = item.lockedQuantity.minus(qty); }
    if (input.type === 'Outbound') { if (item.quantity.minus(item.lockedQuantity).lt(qty)) throw new Error('insufficient-stock'); item.quantity = item.quantity.minus(qty); }
    const movement = { ...input, id: `SM_${T.stockMovement.length + 1}`, quantity: qty, unit: item.unit, warehouseId: item.warehouseId, operator: actorId };
    T.stockMovement.push(movement); return movement;
  });
  return db;
}
const receive = (key = 'RECEIVE_1', qty: number | string = 10) => ({ clientRequestId: key, itemId: 'ITEM', quantity: qty, unit: 'PCS' });

describe('W3 实收批次、锁定隔离与批准报废（服务替身，不代表真实 PG/库存通过）', () => {
  it('实收同tx Inbound→Lock，保留货权/旧锁，达到批准量才Received', async () => {
    const db = fixture();
    const r = await receiveClaimReturn(db, 'LINE', receive('P1', 4), 'warehouse');
    expect(r.ok).toBe(true);
    expect(r.data!.returnReceipt.status).toBe('PartiallyReceived');
    expect(String(db._t.inventoryItem[0].quantity)).toBe('24'); expect(String(db._t.inventoryItem[0].lockedQuantity)).toBe('7');
    expect(db._t.inventoryItem[0].ownership).toBe('Transferred');
    expect(r.data!.movements.map((m: any) => m.type)).toEqual(['Inbound', 'Lock']);
    const two = await receiveClaimReturn(db, 'LINE', receive('P2', 6), 'warehouse');
    expect(two.ok).toBe(true); expect(two.data!.returnReceipt.status).toBe('Received');
    expect(db._t.auditLog.filter((row: any) => row.action === 'CLAIM_RETURN_RECEIVED')[0].detail.claimReturn.batch)
      .toMatchObject({ itemId: 'ITEM', warehouseId: 'WH', materialCode: 'SKU_1', quantity: '4', unit: 'PCS', batchNumber: 'LOT1', ownership: 'Transferred' });
  });
  it('同actor/request/参数重放零新增流水、审计和数量；换actor或数量拒', async () => {
    const db = fixture(); const one = await receiveClaimReturn(db, 'LINE', receive(), 'warehouse');
    const before = db.auditLog.create.mock.calls.length;
    const two = await receiveClaimReturn(db, 'LINE', receive('RECEIVE_1', '10.00'), 'warehouse');
    expect(two.ok).toBe(true); expect(two.data!.replayed).toBe(true); expect(two.data!.receivedEventId).toBe(one.data!.receivedEventId);
    expect(db._t.stockMovement).toHaveLength(2); expect(db.auditLog.create.mock.calls.length).toBe(before);
    expect((await receiveClaimReturn(db, 'LINE', receive('RECEIVE_1', 9), 'warehouse')).error?.code).toBe('INVALID_STATE');
    expect((await receiveClaimReturn(db, 'LINE', receive(), 'other')).error?.code).toBe('INVALID_STATE');
    expect(String(db._t.returnReceiptLine[0].receivedQuantity)).toBe('10');
  });
  it('报废同tx Unlock→Outbound，只减少本次退回批量，旧可售库存与旧锁不改变', async () => {
    const db = fixture(); const received = await receiveClaimReturn(db, 'LINE', receive(), 'warehouse');
    const input = { clientRequestId: 'SCRAP1', receivedEventId: received.data!.receivedEventId, reason: '批准报废执行' };
    const r = await scrapClaimReturn(db, 'LINE', input, 'warehouse');
    expect(r.ok).toBe(true); expect(r.data!.returnReceipt.status).toBe('Dispositioned');
    expect(r.data!.movements.map((m: any) => m.type)).toEqual(['Unlock', 'Outbound']);
    expect(String(db._t.inventoryItem[0].quantity)).toBe('20'); expect(String(db._t.inventoryItem[0].lockedQuantity)).toBe('3');
    expect((await scrapClaimReturn(db, 'LINE', input, 'warehouse')).data!.replayed).toBe(true);
    expect((await scrapClaimReturn(db, 'LINE', { ...input, clientRequestId: 'SCRAP2' }, 'warehouse')).error?.code).toBe('INVALID_STATE');
    expect(db._t.stockMovement).toHaveLength(4);
  });
  it.each(['Repair', 'Replace'])('非Scrap批准 %s 不能用报废理由改去向', async destination => {
    const db = fixture(destination); const r = await receiveClaimReturn(db, 'LINE', receive(), 'warehouse');
    expect((await scrapClaimReturn(db, 'LINE', { clientRequestId: 'S1', receivedEventId: r.data!.receivedEventId, reason: '我觉得可报废' }, 'warehouse')).error?.code).toBe('INVALID_STATE');
    expect(db._t.stockMovement).toHaveLength(2);
  });
  it.each(['sku', 'warehouse', 'unit', 'over', 'approval', 'date'])('拒绝错误 %s 实收且零库/状态产出', async field => {
    const db = fixture(); const input: any = receive();
    if (field === 'sku') db._t.inventoryItem[0].materialCode = 'SKU_OTHER';
    if (field === 'warehouse') db._t.inventoryItem[0].warehouseId = 'OTHER';
    if (field === 'unit') input.unit = 'M';
    if (field === 'over') input.quantity = 11;
    if (field === 'approval') db._t.approvalRequest[0].payload.contentFingerprint = 'wrong';
    if (field === 'date') input.receivedAt = '2026-02-30';
    expect((await receiveClaimReturn(db, 'LINE', input, 'warehouse')).ok).toBe(false);
    expect(db._t.stockMovement).toHaveLength(0); expect(String(db._t.returnReceiptLine[0].receivedQuantity)).toBe('0');
  });
  it('业务YD与实际M分别留数，采用唯一换算', async () => {
    const db = fixture();
    db._t.claimDisposition[0].unit = 'YD'; db._t.returnReceiptLine[0].unit = 'YD'; db._t.inventoryItem[0].unit = 'M';
    const payload = buildClaimApprovalPayload(db._t.claimDisposition[0], db._t.claimCase[0]);
    db._t.approvalRequest[0].payload = payload; db._t.auditLog[0].detail.approvalDecisionFact.contentFingerprint = payload.contentFingerprint;
    const r = await receiveClaimReturn(db, 'LINE', { ...receive(), unit: 'YD' }, 'warehouse');
    expect(r.ok).toBe(true); expect(String(r.data!.line.receivedQuantity)).toBe('10');
    expect(String(r.data!.movements[0].quantity)).toBe('9.144');
    expect((await receiveClaimReturn(db, 'LINE', { ...receive(), unit: 'YD' }, 'warehouse')).data!.replayed).toBe(true);
  });
  it.each(['lock', 'audit'])('必需%s失败模拟全回滚；不遗留已入库未锁定的坏货', async faultPoint => {
    const db = fixture(); const original = inventoryMovement.getMockImplementation()!;
    if (faultPoint === 'lock') inventoryMovement.mockImplementation(async (...args: any[]) => { if (args[0].type === 'Lock') throw new Error('lock-failed'); return original(...args); });
    if (faultPoint === 'audit') db.auditLog.create.mockRejectedValueOnce(new Error('audit-failed'));
    await expect(receiveClaimReturn(db, 'LINE', receive(), 'warehouse')).rejects.toThrow();
    expect(db._t.stockMovement).toHaveLength(0); expect(String(db._t.inventoryItem[0].quantity)).toBe('20');
    expect(String(db._t.returnReceiptLine[0].receivedQuantity)).toBe('0');
  });
  it.each(['audit', 'movement', 'orphan'])('真实batch %s 损坏不允许凭header日期报废或继续收货', async field => {
    const db = fixture(); const r = await receiveClaimReturn(db, 'LINE', receive(), 'warehouse');
    if (field === 'audit') db._t.auditLog.find((row: any) => row.id === r.data!.receivedEventId).detail.claimReturn.batch.quantity = '9';
    if (field === 'movement') db._t.stockMovement[0].quantity = new Prisma.Decimal(9);
    if (field === 'orphan') db._t.stockMovement.push({ ...db._t.stockMovement[0], id: 'ORPHAN' });
    expect((await scrapClaimReturn(db, 'LINE', { clientRequestId: 'S1', receivedEventId: r.data!.receivedEventId, reason: '报废' }, 'warehouse')).ok).toBe(false);
    expect(inventoryMovement.mock.calls).toHaveLength(2);
  });
});
