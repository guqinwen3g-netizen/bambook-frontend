import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { startClaimRepair, completeClaimRepair, recordClaimRepairInspection, lockClaimRepairContext, readClaimRepairReleaseFact } from '../claimRepairFulfillmentService';

// Upstream receipt/authority seams are synthetic; this suite proves repair service contracts only.
// Real receipt ledgers, current DB permission loading and PG rollback require the opt-in probes.
vi.mock('../claimReturnFulfillmentService', () => ({
  lockClaimReturnContext: async (tx: any) => tx._context,
  loadAllClaimReturnBatches: async (tx: any) => tx._batches,
}));
vi.mock('../../auth/permissionService', async () => ({ ...(await vi.importActual<any>('../../auth/permissionService')),
  createPermissionService: ({ prisma }: any) => ({ getUserPermissionContext: async () => prisma._qualityAuthority }),
}));

function fixture() {
  const tables: Record<string, any[]> = {
    repairWorkOrder: [{ id: 'RW', dispositionId: 'D', claimCaseId: 'CASE', status: 'Draft', materialCode: 'SKU', quantity: new Prisma.Decimal(10),
      unit: 'PCS', workStationId: 'WS', needsReinspection: true }],
    returnReceiptLine: [{ id: 'LINE', claimDispositionId: 'D', returnReceiptId: 'RT', materialCode: 'SKU', unit: 'PCS',
      expectedQuantity: new Prisma.Decimal(10), receivedQuantity: new Prisma.Decimal(10), status: 'Received' }],
    workStation: [{ id: 'WS', isActive: true }], repairInspection: [], auditLog: [],
  };
  const db: any = { _t: tables, _context: { line: tables.returnReceiptLine[0], disposition: { id: 'D', kind: 'Repair', repairWorkOrderId: 'RW' },
    claimCase: { id: 'CASE' }, fact: { contentFingerprint: 'approved-current' } },
    _batches: [{ audit: { id: 'ACTUAL_RECEIVE' }, inbound: { id: 'IN', quantity: new Prisma.Decimal(10) }, hold: { id: 'LOCK' },
      item: { id: 'ITEM', warehouseId: 'WH', materialCode: 'SKU', unit: 'PCS', ownership: 'Transferred' },
      fact: { parameters: { quantity: '10' }, batch: { batchNumber: 'REAL_LOT1' } } }],
    _qualityAuthority: { userId: 'qa', roleIds: ['synthetic-qa'], legacyRoleCodes: [], scopes: ['qc:write'], authorizationLoaded: true },
    $queryRawUnsafe: vi.fn(async () => []),
  };
  const match = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]) => (row[key] ?? null) === (value ?? null));
  for (const name of Object.keys(tables)) db[name] = {
    findUnique: vi.fn(async ({ where }: any) => tables[name].find(row => match(row, where)) ?? null),
    findFirst: vi.fn(async ({ where }: any) => tables[name].find(row => match(row, where)) ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => tables[name].filter(row => match(row, where))),
    update: vi.fn(async ({ where, data }: any) => { const i = tables[name].findIndex(row => match(row, where)); tables[name][i] = { ...tables[name][i], ...data }; return tables[name][i]; }),
    create: vi.fn(async ({ data }: any) => { tables[name].push(data); return data; }),
  };
  let seq = 0;
  db.businessSequence = { upsert: vi.fn(async ({ where }: any) => ({ id: where.id, seq })),
    update: vi.fn(async ({ where }: any) => ({ id: where.id, seq: ++seq })) };
  // Storage rollback model; not proof of PostgreSQL transaction semantics.
  db.$transaction = vi.fn(async (fn: any) => { const before = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
    try { return await fn(db); } catch (error) { Object.assign(tables, before); throw error; } });
  return db;
}
const start = { clientRequestId: 'START1', notes: '实际开工' };
const complete = { clientRequestId: 'COMPLETE1', completedQuantity: '10', unit: 'PCS' };
const inspection = { clientRequestId: 'QC1', inspectedQuantity: '10', passedQuantity: '10', unit: 'PCS', result: 'pass' as const, inspectionDate: '2026-10-01' };
async function completeWork(db: any) { expect((await startClaimRepair(db, 'RW', start, 'worker')).ok).toBe(true); expect((await completeClaimRepair(db, 'RW', complete, 'worker')).ok).toBe(true); }

describe('返修完整实际批次与复检事实（上游替身，不声称公司账号/PG通过）', () => {
  it('真实批次依次开工→精确量完工→质检，状态/批次/来源审计不由body自报', async () => {
    const db = fixture(); await completeWork(db);
    const report = await recordClaimRepairInspection(db, 'RW', inspection, 'qa');
    expect(report.ok).toBe(true); expect(report.data!.inspection.inspectedBy).toBe('qa');
    expect(db._t.auditLog.map((row: any) => row.action)).toEqual(['CLAIM_REPAIR_STARTED', 'CLAIM_REPAIR_COMPLETED', 'CLAIM_REPAIR_INSPECTED']);
    expect(db._t.auditLog[2].detail.claimRepair.binding.batches).toEqual([expect.objectContaining({ receivedEventId: 'ACTUAL_RECEIVE',
      inboundMovementId: 'IN', holdMovementId: 'LOCK', itemId: 'ITEM', batchNumber: 'REAL_LOT1', quantity: '10', stockQuantity: '10' })]);
    expect(await readClaimRepairReleaseFact(db, await lockClaimRepairContext(db, 'RW'))).toMatchObject({ inspectionId: report.data!.inspection.id });
  });
  it('每阶段稳定请求重试不重复状态或审计，换quantity/actor拒绝', async () => {
    const db = fixture();
    await startClaimRepair(db, 'RW', start, 'worker');
    expect((await startClaimRepair(db, 'RW', start, 'worker')).data!.replayed).toBe(true);
    await completeClaimRepair(db, 'RW', complete, 'worker');
    expect((await completeClaimRepair(db, 'RW', { ...complete, completedQuantity: 10 }, 'worker')).data!.replayed).toBe(true);
    expect((await completeClaimRepair(db, 'RW', { ...complete, completedQuantity: 9 }, 'worker')).ok).toBe(false);
    const report = await recordClaimRepairInspection(db, 'RW', inspection, 'qa');
    expect((await recordClaimRepairInspection(db, 'RW', inspection, 'qa')).data!.inspection.id).toBe(report.data!.inspection.id);
    expect((await recordClaimRepairInspection(db, 'RW', inspection, 'other')).ok).toBe(false);
    expect(db._t.auditLog).toHaveLength(3); expect(db._t.repairInspection).toHaveLength(1);
  });
  it.each(['partial-receipt', 'no-batch', 'station', 'sku'])('缺实际%s不开工、不写状态', async field => {
    const db = fixture();
    if (field === 'partial-receipt') db._context.line.receivedQuantity = new Prisma.Decimal(9);
    if (field === 'no-batch') db._batches = [];
    if (field === 'station') db._t.workStation[0].isActive = false;
    if (field === 'sku') db._t.repairWorkOrder[0].materialCode = 'OTHER';
    expect((await startClaimRepair(db, 'RW', start, 'worker')).ok).toBe(false);
    expect(db._t.repairWorkOrder[0].status).toBe('Draft'); expect(db._t.auditLog).toHaveLength(0);
  });
  it('禁止跳完工和header-only历史日期，缺开工审计不能虚报修完', async () => {
    const db = fixture(); expect((await completeClaimRepair(db, 'RW', complete, 'worker')).ok).toBe(false);
    db._t.repairWorkOrder[0].status = 'InRepair'; db._t.repairWorkOrder[0].startedAt = '2026-10-01';
    expect((await completeClaimRepair(db, 'RW', complete, 'worker')).ok).toBe(false); expect(db._t.auditLog).toHaveLength(0);
  });
  it('不完整通过量/错误单位/自报质检人不能制造pass', async () => {
    const db = fixture(); await completeWork(db);
    for (const input of [{ ...inspection, passedQuantity: 9 }, { ...inspection, unit: 'M' }, { ...inspection, inspectedBy: 'boss' }]) {
      expect((await recordClaimRepairInspection(db, 'RW', input as any, 'qa')).ok).toBe(false);
    }
    expect(db._t.repairInspection).toHaveLength(0);
  });
  it('qc当前权限不足禁止登记，已持久QC事实不因后来撤权抹掉', async () => {
    const db = fixture(); await completeWork(db); db._qualityAuthority.scopes = [];
    await expect(recordClaimRepairInspection(db, 'RW', inspection, 'qa')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSION' });
    db._qualityAuthority.scopes = ['qc:write']; await recordClaimRepairInspection(db, 'RW', inspection, 'qa'); db._qualityAuthority = null;
    expect(await readClaimRepairReleaseFact(db, await lockClaimRepairContext(db, 'RW'))).toMatchObject({ inspectionId: expect.any(String) });
  });
  it('复检fail追加保留旧pass，但返还门禁不能选择历史pass放行', async () => {
    const db = fixture(); await completeWork(db); await recordClaimRepairInspection(db, 'RW', inspection, 'qa');
    await recordClaimRepairInspection(db, 'RW', { ...inspection, clientRequestId: 'QC2', result: 'fail', passedQuantity: '8' }, 'qa');
    expect(db._t.repairInspection).toHaveLength(2); expect(db._t.repairInspection[0].result).toBe('pass');
    await expect(readClaimRepairReleaseFact(db, await lockClaimRepairContext(db, 'RW'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it.each(['batch', 'report', 'authority'])('复检%s审计损坏拒绝，不能只信报告pass字段', async field => {
    const db = fixture(); await completeWork(db); await recordClaimRepairInspection(db, 'RW', inspection, 'qa');
    const fact = db._t.auditLog[2].detail.claimRepair;
    if (field === 'batch') fact.bindingFingerprint = 'wrong';
    if (field === 'report') db._t.repairInspection[0].passedQuantity = new Prisma.Decimal(9);
    if (field === 'authority') fact.qualityActorAuthority.allowed = false;
    await expect(readClaimRepairReleaseFact(db, await lockClaimRepairContext(db, 'RW'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('必需QC审计失败模拟整笔rollback，不能留无authority事实的报告', async () => {
    const db = fixture(); await completeWork(db); db.auditLog.create.mockRejectedValueOnce(new Error('mandatory-audit-failed'));
    await expect(recordClaimRepairInspection(db, 'RW', inspection, 'qa')).rejects.toThrow('mandatory-audit-failed');
    expect(db._t.repairInspection).toHaveLength(0); expect(db._t.auditLog).toHaveLength(2);
  });
});
