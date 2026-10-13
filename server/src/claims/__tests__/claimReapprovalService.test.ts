import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { resubmitClaimApproval, CLAIM_REAPPROVAL_EVENT } from '../claimReapprovalService';
import { assertClaimDecisionAuthority, buildClaimApprovalPayload } from '../claimApprovalFact';

let routingError: any = null;
const routedClients: any[] = [];
vi.mock('../../approvals/approvalRoutingService', () => ({
  NO_REVIEWER_RESOLVED: 'NO_REVIEWER_RESOLVED',
  createApprovalRoutingService: () => ({ resolveClaimLeader: async (_id: string, client: any) => {
    routedClients.push(client);
    if (routingError) throw routingError;
    return { reviewerId: 'leader', route: 'CLAIM_GENERAL_LEADER', departmentSnapshotId: 'dept_a' };
  } }),
}));

/** Stateful storage seam with rollback. No PostgreSQL/lock/concurrency or company-account proof. */
function makePrisma() {
  const tables: Record<string, any[]> = {
    claimCase: [{ id: 'C1', caseNumber: 'CLM-2026-0001', status: 'Processing', problemDesc: '色差',
      customerRelationId: 'CUSTOMER1', sourceInvoiceId: 'INV1', reportedBy: 'u1', reportedAt: '2026-10-01', createdAt: BigInt(1), totalCreditAmount: new Prisma.Decimal(0) }],
    claimDisposition: [{ id: 'OLD', claimCaseId: 'C1', status: 'Approved', kind: 'Allowance', amount: new Prisma.Decimal(500), currency: 'USD',
      approverId: 'historical-leader', approvedAt: '2026-09-17', createdAt: BigInt(2), notes: '原说明' }],
    approvalRequest: [{ id: 'HISTORY', actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition', targetId: 'OLD', requesterId: 'u1',
      reviewerId: 'historical-leader', status: 'approved', payload: { amount: '500' }, decidedAt: new Date('2026-09-17'), createdAt: new Date('2026-09-17') }],
    auditLog: [], creditNote: [], returnReceipt: [], repairWorkOrder: [], shipment: [], stockMovement: [],
  };
  const matches = (row: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object' && 'notIn' in value) return !value.notIn.includes(row[key]);
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    // Plain string values have String.prototype.startsWith; they are equality predicates,
    // not Prisma { startsWith: prefix } filters. Misreading them hid every existing row.
    if (value && typeof value === 'object' && 'startsWith' in value) return typeof row[key] === 'string' && row[key].startsWith(value.startsWith);
    return (row[key] ?? null) === (value ?? null);
  });
  const delegates: any = {};
  for (const name of Object.keys(tables)) {
    delegates[name] = {
      findUnique: vi.fn(async ({ where }: any) => tables[name].find(row => matches(row, where)) ?? null),
      findFirst: vi.fn(async ({ where }: any) => tables[name].find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: any = {}) => tables[name].filter(row => matches(row, where))),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, ...(name === 'approvalRequest' ? { createdAt: new Date() } : {}) }; tables[name].push(row); return row; }),
      update: vi.fn(async ({ where, data }: any) => { const index = tables[name].findIndex(row => matches(row, where)); tables[name][index] = { ...tables[name][index], ...data }; return tables[name][index]; }),
      updateMany: vi.fn(async ({ where, data }: any) => { let count = 0; tables[name] = tables[name].map(row => matches(row, where) ? (count++, { ...row, ...data }) : row); return { count }; }),
    };
  }
  const tx = { ...delegates, $queryRawUnsafe: vi.fn(async () => []) };
  const prisma: any = { ...delegates, _tables: tables, _tx: tx,
    $transaction: vi.fn(async (fn: any) => {
      const before = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]));
      try { return await fn(tx); } catch (error) { for (const name of Object.keys(tables)) tables[name] = before[name]; throw error; }
    }),
  };
  return prisma;
}
const request = { reason: '补充材料后明确重新送审', clientRequestId: 'resubmit-1', changes: { amount: '525.25', notes: '新说明' } };

describe('人工重送审：追加新版本、保留旧事实、原子续办', () => {
  beforeEach(() => { routingError = null; routedClients.length = 0; });

  it('旧 Approved 无合法内核事实可明确续办；新 Draft/完整 pending 审批与替代事件同事务', async () => {
    const prisma = makePrisma();
    const oldApproval = { ...prisma._tables.approvalRequest[0] };
    const result = await resubmitClaimApproval(prisma, 'OLD', request, 'u1');
    expect(result.ok).toBe(true);
    expect(result.data!.previousDisposition).toMatchObject({ id: 'OLD', status: 'Cancelled', approverId: 'historical-leader', approvedAt: '2026-09-17', cancelledBy: 'u1' });
    expect(result.data!.disposition).toMatchObject({ claimCaseId: 'C1', status: 'Draft', kind: 'Allowance', notes: '新说明' });
    expect(result.data!.disposition.id).not.toBe('OLD');
    expect(String(result.data!.disposition.amount)).toBe('525.25');
    expect(result.data!.disposition.approverId).toBeUndefined();
    expect(prisma._tables.approvalRequest[0]).toEqual(oldApproval);
    expect(prisma._tables.approvalRequest[1]).toMatchObject({ id: result.data!.approvalRequestId, targetId: result.data!.disposition.id,
      targetType: 'ClaimDisposition', actionType: 'aftersales:claim-disposition', status: 'pending', reviewerId: 'leader',
      payload: { schemaVersion: 1, contentFingerprint: result.data!.contentFingerprint, amount: '525.25' } });
    expect(routedClients).toEqual([prisma._tx]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma._tx.$queryRawUnsafe.mock.calls.slice(0, 3).map((call: any[]) => call[0])).toEqual([
      'SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', 'SELECT id FROM "ClaimDisposition" WHERE id = $1 FOR UPDATE',
      'SELECT id FROM "ApprovalRequest" WHERE "targetType" = $1 AND "targetId" = $2 FOR UPDATE',
    ]);
    const event = prisma._tables.auditLog.find((row: any) => row.action === CLAIM_REAPPROVAL_EVENT);
    expect(event).toMatchObject({ actorId: 'u1', beforeValue: 'Approved', afterValue: 'Cancelled', detail: { versionFieldChanges: [
      { fieldPath: 'amount', before: '500', after: '525.25' }, { fieldPath: 'notes', before: '原说明', after: '新说明' },
    ], businessEvent: { type: 'ClaimDispositionReapprovalSubmitted', payload: { actorId: 'u1', requestId: 'resubmit-1',
      replacementDispositionId: result.data!.disposition.id, newApprovalRequestId: result.data!.approvalRequestId,
      parametersHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } } });
    expect(String(prisma._tables.claimCase[0].totalCreditAmount)).toBe('0');
  });

  it('旧 pending 只新增业务替代事实，不能伪造 rejected/approved 决议；旧目标不可再批准', async () => {
    const prisma = makePrisma();
    prisma._tables.claimDisposition[0].status = 'Draft';
    const old = prisma._tables.claimDisposition[0];
    Object.assign(prisma._tables.approvalRequest[0], { status: 'pending', payload: buildClaimApprovalPayload(old, prisma._tables.claimCase[0]) });
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).ok).toBe(true);
    expect(prisma._tables.approvalRequest[0].status).toBe('pending');
    expect(prisma._tables.approvalRequest[0].reviewerId).toBe('historical-leader');
    await expect(assertClaimDecisionAuthority(prisma._tx, prisma._tables.approvalRequest[0], { userId: 'historical-leader' }, 'normal'))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(prisma._tables.auditLog).toHaveLength(1);
  });

  it('同 actor/requestId/规范参数重放同新处置及审批；参数或主体不同拒绝新增', async () => {
    const prisma = makePrisma();
    const first = await resubmitClaimApproval(prisma, 'OLD', request, 'u1');
    const retry = await resubmitClaimApproval(prisma, 'OLD', { ...request, changes: { ...request.changes, amount: 525.25 } }, 'u1');
    expect(retry.data!.disposition.id).toBe(first.data!.disposition.id);
    expect(retry.data!.approvalRequestId).toBe(first.data!.approvalRequestId);
    expect((await resubmitClaimApproval(prisma, 'OLD', { ...request, reason: '另一个理由' }, 'u1')).error?.code).toBe('INVALID_STATE');
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'other')).error?.code).toBe('INVALID_STATE');
    expect((await resubmitClaimApproval(prisma, 'OLD', { ...request, clientRequestId: 'resubmit-2' }, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._tables.claimDisposition).toHaveLength(2);
    expect(prisma._tables.approvalRequest).toHaveLength(2);
    expect(prisma._tables.auditLog).toHaveLength(1);
  });

  it.each(['creditNoteId', 'returnReceiptId', 'replacementShipmentId', 'repairWorkOrderId'])('旧处置已有 %s 不得造新版本', async key => {
    const prisma = makePrisma(); prisma._tables.claimDisposition[0][key] = 'EXISTING';
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._tables.claimDisposition).toHaveLength(1);
    expect(prisma._tables.claimDisposition[0].status).toBe('Approved');
  });

  it.each(['creditNote', 'returnReceipt', 'repairWorkOrder', 'shipment', 'stockMovement'])('可辨识孤立 %s 必须先人工对账，不按未执行续办', async model => {
    const prisma = makePrisma();
    prisma._tables[model].push({ id: 'ORPHAN', claimCaseId: 'C1', status: model === 'creditNote' ? 'Open' : 'Draft', notes: '[补发] 来自客诉 CLM-2026-0001 · 孤立单据', referenceType: 'ClaimDisposition', referenceId: 'OLD' });
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._tables.claimDisposition).toHaveLength(1);
    expect(prisma._tables.approvalRequest).toHaveLength(1);
    expect(prisma._tables.claimDisposition[0].status).toBe('Approved');
  });

  it('已删除/作废的孤立退货 header 若仍有库存流水不能掩盖孤立货腿', async () => {
    const prisma = makePrisma();
    prisma._tables.returnReceipt.push({ id: 'ORPHAN_RET', claimCaseId: 'C1', status: 'Cancelled', deletedAt: BigInt(99) });
    prisma._tables.stockMovement.push({ id: 'MOVEMENT', referenceType: 'ReturnReceipt', referenceId: 'ORPHAN_RET', type: 'Inbound' });
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._tables.claimDisposition).toHaveLength(1);
  });

  it('历史补发来源格式按完整案号阻断，不能混入案号前缀相似的另案', async () => {
    const prisma = makePrisma();
    prisma._tables.shipment.push({ id: 'OTHER_CASE_SH', status: 'Draft', notes: '[补发] 来自客诉 CLM-2026-00010 · 另案' });
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).ok).toBe(true);
  });

  it('同案件别的已执行处置有完整引用，不得误当本次的孤立产出', async () => {
    const prisma = makePrisma();
    prisma._tables.claimDisposition.push({ id: 'OTHER', claimCaseId: 'C1', status: 'Executed', creditNoteId: 'CN_OTHER' });
    prisma._tables.creditNote.push({ id: 'CN_OTHER', claimCaseId: 'C1', status: 'Open' });
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).ok).toBe(true);
    expect(prisma._tables.creditNote).toHaveLength(1);
    expect(prisma._tables.creditNote[0].status).toBe('Open');
  });

  it.each(['Executed', 'Cancelled'])('%s 处置无同请求重放事件必须拒绝', async status => {
    const prisma = makePrisma(); prisma._tables.claimDisposition[0].status = status;
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._tables.claimDisposition).toHaveLength(1);
  });

  it.each(['Cancelled', 'Closed'])('%s 案件不可新送审', async status => {
    const prisma = makePrisma(); prisma._tables.claimCase[0].status = status;
    expect((await resubmitClaimApproval(prisma, 'OLD', request, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(prisma._tables.claimDisposition).toHaveLength(1);
  });

  it.each(['routing', 'approval', 'audit', 'claimCase', 'claimDisposition'])('%s 失败整笔回滚，新版本与原状态不可半提交', async stage => {
    const prisma = makePrisma(); const fault = new Error(`injected-${stage}`);
    const original = { ...prisma._tables.claimDisposition[0] };
    if (stage === 'routing') routingError = fault;
    if (stage === 'approval') prisma.approvalRequest.create.mockRejectedValueOnce(fault);
    if (stage === 'audit') prisma.auditLog.create.mockRejectedValueOnce(fault);
    if (stage === 'claimCase') prisma.claimCase.update.mockRejectedValueOnce(fault);
    if (stage === 'claimDisposition') prisma.claimDisposition.updateMany.mockResolvedValueOnce({ count: 0 });
    const promise = resubmitClaimApproval(prisma, 'OLD', request, 'u1');
    if (stage === 'claimDisposition') expect((await promise).error?.code).toBe('INVALID_STATE');
    else await expect(promise).rejects.toBeTruthy();
    expect(prisma._tables.claimDisposition).toEqual([original]);
    expect(prisma._tables.approvalRequest).toHaveLength(1);
    expect(prisma._tables.auditLog).toHaveLength(0);
  });

  it.each([{ reason: '', clientRequestId: 'ID' }, { reason: 'x', clientRequestId: '' }, { ...request, changes: { kind: 'Repair' } },
    { ...request, changes: { sourceInvoiceId: 'FAKE' } }, { ...request, changes: { notes: {} } }, { ...request, changes: { amount: 0 } }])('非法/来源篡改输入 %j 零写入', async input => {
    const prisma = makePrisma();
    expect((await resubmitClaimApproval(prisma, 'OLD', input as any, 'u1')).error?.code).toBe('VALIDATION_FAILED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma._tables.claimDisposition).toHaveLength(1);
  });
});
