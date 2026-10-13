import { fabricAuthorizationFixture } from './fabricAuthorizationFixture';
/** Actual service/operational guards and audit producer, with storage substitutes.
 * These are error-contract probes, not PostgreSQL rollback/locking or role UAT. */
import { describe, expect, it, vi } from 'vitest';
import {
  addDevelopmentSupplier, updateDevelopmentSupplier, removeDevelopmentSupplier,
  createSampleBatch, updateSampleBatch, confirmSampleBatch, deleteSampleBatch,
  advanceSampleBatchStage,
} from '../fabricDevelopmentService';

const CASE_ID = 'DC-error-boundary', ACTOR_ID = 'synthetic-error-actor';
function fixture() {
  const supplier = { id: 'DS-error', developmentCaseId: CASE_ID, supplierRelationId: 'SUP-error',
    createdAt: 1n, updatedAt: 1n, deletedAt: null };
  const batch = { id: 'SB-error', batchCode: 'SB-error', developmentCaseId: CASE_ID,
    supplierRelationId: supplier.supplierRelationId, sampleType: 'lab-dip', status: 'approved',
    confirmStatus: 'pending', approvedAt: 1n, approvedBy: ACTOR_ID, round: 1, createdAt: 1n, updatedAt: 1n, deletedAt: null };
  const tx: any = {
    ...fabricAuthorizationFixture(ACTOR_ID),
    $queryRaw: vi.fn(async () => [{ id: CASE_ID }]),
    developmentCase: { findFirst: vi.fn(async () => ({ id: CASE_ID, type: 'fabric', deletedAt: null })) },
    developmentLifecycleEvent: { findFirst: vi.fn(async () => null) },
    developmentSupplier: { findFirst: vi.fn(async () => ({ ...supplier })), findUnique: vi.fn(async () => ({ ...supplier })),
      create: vi.fn(async ({ data }: any) => ({ ...supplier, ...data })), update: vi.fn(async ({ data }: any) => ({ ...supplier, ...data })) },
    sampleBatch: { findFirst: vi.fn(async () => ({ ...batch })),
      create: vi.fn(async ({ data }: any) => ({ ...batch, ...data })), update: vi.fn(async ({ data }: any) => ({ ...batch, ...data })) },
    sample: { findMany: vi.fn(async () => []), update: vi.fn() },
    sealSampleBatch: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async ({ data }: any) => ({ ...data })) },
  };
  const prisma: any = { developmentCase: tx.developmentCase,
    $transaction: vi.fn(async (work: any) => work(tx)) };
  return { prisma, tx, supplier, batch };
}
type Fixture = ReturnType<typeof fixture>;
const actions: { name: string; fallbackCode: string; run: (f: Fixture) => Promise<any> }[] = [
  { name: 'supplier add', fallbackCode: 'SUPPLIER_ADD_FAILED', run: f => addDevelopmentSupplier({ prisma: f.prisma, caseId: CASE_ID, actorId: ACTOR_ID, input: { supplierRelationId: 'SUP-error' } }) },
  { name: 'supplier update', fallbackCode: 'SUPPLIER_UPDATE_FAILED', run: f => updateDevelopmentSupplier({ prisma: f.prisma, supplierId: f.supplier.id, actorId: ACTOR_ID, input: { notes: 'Public note' } }) },
  { name: 'supplier remove', fallbackCode: 'SUPPLIER_REMOVE_FAILED', run: f => removeDevelopmentSupplier({ prisma: f.prisma, supplierId: f.supplier.id, actorId: ACTOR_ID }) },
  { name: 'batch create', fallbackCode: 'BATCH_CREATE_FAILED', run: f => createSampleBatch({ prisma: f.prisma, caseId: CASE_ID, actorId: ACTOR_ID, input: { supplierRelationId: 'SUP-error', sampleType: 'lab-dip' } }) },
  { name: 'batch update', fallbackCode: 'BATCH_UPDATE_FAILED', run: f => updateSampleBatch({ prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID, input: { specNote: 'Public sample note' } }) },
  { name: 'batch confirm', fallbackCode: 'BATCH_CONFIRM_FAILED', run: f => confirmSampleBatch({ trustedActor: { userId: ACTOR_ID, roles: [] }, prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID }) },
  { name: 'batch delete', fallbackCode: 'BATCH_DELETE_FAILED', run: f => deleteSampleBatch({ prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID }) },
  { name: 'batch stage', fallbackCode: 'BATCH_STAGE_FAILED', run: f => {
    f.batch.status = 'making';
    return advanceSampleBatchStage({ trustedActor: { userId: ACTOR_ID, roles: [] }, prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID, action: 'send', input: {} });
  } },
];
function noMutation(f: Fixture) {
  expect(f.tx.developmentSupplier.create).not.toHaveBeenCalled();
  expect(f.tx.developmentSupplier.update).not.toHaveBeenCalled();
  expect(f.tx.sampleBatch.create).not.toHaveBeenCalled();
  expect(f.tx.sampleBatch.update).not.toHaveBeenCalled();
  expect(f.tx.auditLog.create).not.toHaveBeenCalled();
}

describe.each(actions)('$name finite error boundary', action => {
  it('legitimate operation remains successful with its mandatory audit', async () => {
    const f = fixture(), result = await action.run(f);
    expect(result.ok).toBe(true);
    // Current decisions lock parent then batch; paused rejection still only takes the parent lock.
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(['batch confirm', 'batch stage'].includes(action.name) ? 2 : 1);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.create.mock.calls[0][0].data.actorId).toBe(ACTOR_ID);
  });
  it('actual paused lifecycle retains code, exact public message and 409 without a write', async () => {
    const f = fixture();
    f.tx.developmentLifecycleEvent.findFirst.mockResolvedValue({ state: 'paused' });
    const result = await action.run(f);
    expect(result).toEqual({ ok: false, error: { code: 'DEVELOPMENT_PAUSED', status: 409,
      message: '开发已暂停，请先明确恢复后再修改开发内容' } });
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1); noMutation(f);
  });
  it('unknown SQL error remains operation-specific safe 500 despite a misleading status field/message', async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValue(Object.assign(new Error('不存在 SQL SELECT "private_column" FROM "private_table" /private/path'), { code: 'P2022', statusCode: 400 }));
    const result = await action.run(f);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(action.fallbackCode); expect(result.error.status).toBe(500);
    expect(result.error.message).not.toMatch(/SQL|private_column|private_table|\/private\/|不存在/); noMutation(f);
  });
  it('an untyped code cannot turn a storage fault into a public business message', async () => {
    const f = fixture();
    f.prisma.$transaction.mockRejectedValue(Object.assign(new Error('private untyped fault，币种必填，不存在'), { code: 'INVALID_INPUT' }));
    const result = await action.run(f);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(action.fallbackCode); expect(result.error.status).toBe(500);
    expect(result.error.message).not.toContain('private'); noMutation(f);
  });
});

describe('actual deliberate fabric producers', () => {
  it.each(actions.filter(action => !['supplier add', 'batch create'].includes(action.name)))('$name missing source retains NOT_FOUND/404 and original public copy', async action => {
    const f = fixture();
    f.tx.developmentSupplier.findFirst.mockResolvedValue(null); f.tx.sampleBatch.findFirst.mockResolvedValue(null);
    const result = await action.run(f);
    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND', status: 404,
      message: action.name.startsWith('supplier') ? '工厂试样记录不存在' : '样品批次不存在' } }); noMutation(f);
  });
  it('enum validation retains its complete public choices, INVALID_INPUT/400', async () => {
    const f = fixture();
    const result = await updateDevelopmentSupplier({ prisma: f.prisma, supplierId: f.supplier.id, actorId: ACTOR_ID, input: { trialConclusion: 'wrong' } });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT', status: 400, message: '试样结论 非法（可选 ok | fail）' } });
    expect(f.prisma.$transaction).not.toHaveBeenCalled(); noMutation(f);
  });
  it('actual decimal validation preserves precision grammar and public INVALID_INPUT/400', async () => {
    const f = fixture();
    const result = await updateSampleBatch({ prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID, input: { actualQuantity: '2.12345' } });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT', status: 400, message: '实际数量须为非负十进制数，最多14位整数及4位小数' } }); noMutation(f);
  });
  it('unapproved batch confirmation keeps BATCH_NOT_APPROVED/409 and the exact business explanation', async () => {
    const f = fixture(); f.batch.status = 'pending';
    const result = await confirmSampleBatch({ trustedActor: { userId: ACTOR_ID, roles: [] }, prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: { code: 'BATCH_NOT_APPROVED', status: 409,
      message: '请先完成样品认可，再确认设计批次；待打样、制作中和需复样的批次不能确认' } }); noMutation(f);
  });
  it('already confirmed batch keeps ALREADY_CONFIRMED/409 and original batch identifier', async () => {
    const f = fixture(); f.batch.confirmStatus = 'confirmed';
    const result = await confirmSampleBatch({ trustedActor: { userId: ACTOR_ID, roles: [] }, prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: { code: 'ALREADY_CONFIRMED', status: 409, message: '批次 SB-error 已确认，不可重复确认' } }); noMutation(f);
  });
  it('seal reference keeps REFERENCED_BY_SEAL/409 and original corrective action', async () => {
    const f = fixture(); f.tx.sealSampleBatch.findFirst.mockResolvedValue({ id: 'seal-link' });
    const result = await deleteSampleBatch({ prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: { code: 'REFERENCED_BY_SEAL', status: 409,
      message: '该批次已被封样引用，不可删除（可先调整封样组合）' } }); noMutation(f);
  });
  it('stage transition remains the module-specific INVALID_TRANSITION/409, not generic registry 400', async () => {
    const f = fixture();
    const result = await advanceSampleBatchStage({ trustedActor: { userId: ACTOR_ID, roles: [] }, prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID, action: 'start', input: {} });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_TRANSITION', status: 409, message: '当前状态 approved 不允许执行 start' } }); noMutation(f);
  });
  it('owner/source change during guarded reread keeps DEVELOPMENT_SOURCE_CHANGED/409', async () => {
    const f = fixture(); f.tx.sampleBatch.findFirst.mockResolvedValueOnce({ ...f.batch }).mockResolvedValueOnce({ ...f.batch, developmentCaseId: 'DC-other' });
    const result = await updateSampleBatch({ prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID, input: {} });
    expect(result).toEqual({ ok: false, error: { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409, message: '来源归属已变化，请刷新后重试' } }); noMutation(f);
  });
  it('audit failure remains safe operation-specific 500 after the attempted write; mock does not claim SQL rollback', async () => {
    const f = fixture(); f.tx.auditLog.create.mockRejectedValue(Error('SQL audit table /private/audit'));
    const result = await updateSampleBatch({ prisma: f.prisma, batchId: f.batch.id, actorId: ACTOR_ID, input: {} });
    expect(result.ok).toBe(false); if (result.ok) throw Error('Expected audit refusal');
    expect(result.error.code).toBe('BATCH_UPDATE_FAILED'); expect(result.error.status).toBe(500);
    expect(result.error.message).not.toMatch(/SQL|private\/audit/); expect(f.tx.sampleBatch.update).toHaveBeenCalledTimes(1);
  });
});
