/** Actual SealSample action callbacks, operational guard and mandatory audit
 * writer over transaction-shaped storage. No mocked safety helper. These controls
 * do not prove native PostgreSQL constraints, locks, rollback or employee roles. */
import { describe, expect, it } from 'vitest';
import { updateSealSample, deleteSealSample } from '../fabricDevelopmentService';

const CASE_ID = 'DC-seal-error', SEAL_ID = 'SEAL-error', ACTOR_ID = 'synthetic-seal-operator';
const SQL_SECRET = 'SQL SELECT "private_seal_column" FROM "private_seal_table" /private/customer-secret';
const clone = <T>(value: T): T => structuredClone(value);
function fixture() {
  const initial = { seal: { id: SEAL_ID, developmentCaseId: CASE_ID, sealCode: 'SEAL-2026-0099',
    supplierRelationId: 'SUP-A', supplierName: 'Mill A', status: 'draft', name: 'Original seal', notes: null,
    createdAt: BigInt(1), updatedAt: BigInt(1), convertedAt: null, deletedAt: null },
    links: [{ id: 'SSB-original', sealSampleId: SEAL_ID, sampleBatchId: 'SB-old' }],
    batches: [{ id: 'SB-new', developmentCaseId: CASE_ID, supplierRelationId: 'SUP-A', supplierName: 'Mill A', deletedAt: null },
      { id: 'SB-other-mill', developmentCaseId: CASE_ID, supplierRelationId: 'SUP-B', supplierName: 'Mill B', deletedAt: null }],
    audits: [] as any[], lifecycle: null as null | { state: string }, caseExists: true };
  let stored: any = clone(initial);
  const control: { sourceFault?: Error; auditFault?: Error; linksFault?: Error; sourceChanged?: boolean } = {};
  const seen = { transactions: 0, commits: 0, rollbacks: 0, writes: 0, auditAttempts: 0, reads: 0, locks: 0 };
  function client(state: any) {
    return {
      $queryRaw: async (_query: any) => { seen.locks++; return state.caseExists ? [{ id: CASE_ID }] : []; },
      developmentLifecycleEvent: { findFirst: async () => clone(state.lifecycle) },
      sealSample: {
        findFirst: async ({ where }: any) => {
          seen.reads++; if (control.sourceFault) throw control.sourceFault;
          const row = state.seal;
          if (!row || row.id !== where.id || row.deletedAt != null) return null;
          return clone(control.sourceChanged && seen.reads % 2 === 0 ? { ...row, developmentCaseId: 'DC-moved' } : row);
        },
        update: async ({ where, data }: any) => {
          if (!state.seal || state.seal.id !== where.id) throw Error('Storage update missed seal');
          seen.writes++; state.seal = { ...state.seal, ...clone(data) }; return clone(state.seal);
        },
      },
      sampleBatch: { findMany: async ({ where }: any) => clone(state.batches.filter((row: any) =>
        where.id.in.includes(row.id) && row.developmentCaseId === where.developmentCaseId && row.deletedAt == null)) },
      sealSampleBatch: {
        findMany: async ({ where }: any) => {
          if (control.linksFault) throw control.linksFault;
          return clone(state.links.filter((row: any) => row.sealSampleId === where.sealSampleId));
        },
        deleteMany: async ({ where }: any) => {
          const before = state.links.length; state.links = state.links.filter((row: any) => row.sealSampleId !== where.sealSampleId);
          return { count: before - state.links.length };
        },
        create: async ({ data }: any) => { state.links.push(clone(data)); return clone(data); },
      },
      auditLog: { create: async ({ data }: any) => {
        seen.auditAttempts++; if (control.auditFault) throw control.auditFault;
        state.audits.push(clone(data)); return clone(data);
      } },
    };
  }
  const prisma: any = {
    sealSampleBatch: { findMany: async (args: any) => client(stored).sealSampleBatch.findMany(args) },
    $transaction: async (work: any) => {
      seen.transactions++; const staged = clone(stored);
      try { const result = await work(client(staged)); stored = staged; seen.commits++; return result; }
      catch (error) { seen.rollbacks++; throw error; }
    },
  };
  return { prisma, control, seen, state: () => clone(stored), mutate: (work: (state: any) => void) => work(stored) };
}
type Fixture = ReturnType<typeof fixture>;
const actions = [
  { name: 'update', fallback: 'SEAL_UPDATE_FAILED', message: '封样更新结果暂不可确认，请核对原开发案后重试。',
    operation: 'update_seal_sample', run: (f: Fixture) => updateSealSample({ prisma: f.prisma, sealId: SEAL_ID,
      actorId: ACTOR_ID, ip: '127.0.0.1', input: { name: 'Revised seal', batchIds: ['SB-new'] } }) },
  { name: 'delete', fallback: 'SEAL_DELETE_FAILED', message: '封样删除结果暂不可确认，请核对原开发案后重试。',
    operation: 'delete_seal_sample', run: (f: Fixture) => deleteSealSample({ prisma: f.prisma, sealId: SEAL_ID,
      actorId: ACTOR_ID, ip: '127.0.0.1' }) },
];
function safeFailure(result: any, action: typeof actions[number]) {
  expect(result).toEqual({ ok: false, error: { code: action.fallback, status: 500, message: action.message } });
  expect(JSON.stringify(result)).not.toMatch(/SQL|private_seal|customer-secret|postgres|secret-token|at driver/);
}
function business(result: any, code: string, status: number, message: string) {
  expect(result).toEqual({ ok: false, error: { code, status, message } });
}

describe.each(actions)('actual SealSample $name error boundary', action => {
  it('successful action keeps the original audit and source facts', async () => {
    const f = fixture(), result = await action.run(f), state = f.state(); expect(result.ok).toBe(true);
    expect(f.seen).toMatchObject({ transactions: 1, commits: 1, rollbacks: 0, writes: 1, auditAttempts: 1, locks: 1 });
    expect(state.seal.sealCode).toBe('SEAL-2026-0099'); expect(state.seal.status).toBe('draft');
    expect(state.audits).toHaveLength(1); expect(state.audits[0]).toMatchObject({ actorId: ACTOR_ID, action: action.operation,
      targetType: 'SealSample', targetId: SEAL_ID, ip: '127.0.0.1', detail: { source: 'route:dev:fabric-seal',
        before: { sealCode: 'SEAL-2026-0099', status: 'draft' }, after: { sealCode: 'SEAL-2026-0099' } } });
    if (action.name === 'update') { expect(state.seal.name).toBe('Revised seal'); expect(state.links.map((row: any) => row.sampleBatchId)).toEqual(['SB-new']); }
    else { expect(state.seal.deletedAt).not.toBeNull(); expect(state.links[0].sampleBatchId).toBe('SB-old'); }
  });
  it('unknown source SQL exception and sensitive driver stack never reach the public result', async () => {
    const f = fixture(), before = f.state(), fault = Object.assign(Error(SQL_SECRET), { code: 'P2022', statusCode: 400 });
    fault.stack = 'Error: secret-token\n at driver /private/postgres/customer-secret'; f.control.sourceFault = fault;
    safeFailure(await action.run(f), action); expect(f.state()).toEqual(before);
    expect(f.seen).toMatchObject({ commits: 0, rollbacks: 1, writes: 0, auditAttempts: 0 });
  });
  it('an untyped familiar code on a storage error cannot publish a business-looking SQL message', async () => {
    const f = fixture(), before = f.state(); f.control.sourceFault = Object.assign(Error(SQL_SECRET), { code: 'NOT_FOUND' });
    safeFailure(await action.run(f), action); expect(f.state()).toEqual(before); expect(f.seen.writes).toBe(0);
  });
  it.each([
    ['paused', 'DEVELOPMENT_PAUSED', '开发已暂停，请先明确恢复后再修改开发内容'],
    ['closed', 'DEVELOPMENT_CLOSED', '开发已结案，新增开发工作须走明确变更，不能直接修改历史'],
    ['unknown', 'INVALID_LIFECYCLE_STATE', '开发管理状态异常，请先核实记录'],
  ])('actual %s lifecycle preserves its original 409 rejection', async (state, code, message) => {
    const f = fixture(), before = f.state(); f.mutate(store => { store.lifecycle = { state }; });
    const guarded = f.state(); business(await action.run(f), code, 409, message); expect(f.state()).toEqual(guarded);
    expect(f.seen.writes).toBe(0); expect(before.seal.sealCode).toBe(guarded.seal.sealCode);
  });
  it('actual missing source preserves NOT_FOUND/404 and exact original copy', async () => {
    const f = fixture(); f.mutate(state => { state.seal = null; });
    business(await action.run(f), 'NOT_FOUND', 404, '封样不存在'); expect(f.seen.writes).toBe(0);
  });
  it('a moved source seen by the real guarded reread preserves DEVELOPMENT_SOURCE_CHANGED/409', async () => {
    const f = fixture(), before = f.state(); f.control.sourceChanged = true;
    business(await action.run(f), 'DEVELOPMENT_SOURCE_CHANGED', 409, '来源归属已变化，请刷新后重试');
    expect(f.state()).toEqual(before); expect(f.seen.writes).toBe(0);
  });
  it('mandatory audit failure rolls back every staged write; retry uses the original source and records one audit', async () => {
    const f = fixture(), before = f.state(); f.control.auditFault = Object.assign(Error(SQL_SECRET), { code: 'P2003' });
    safeFailure(await action.run(f), action); expect(f.state()).toEqual(before);
    expect(f.seen).toMatchObject({ writes: 1, auditAttempts: 1, commits: 0, rollbacks: 1 });
    f.control.auditFault = undefined; const retry = await action.run(f); expect(retry.ok).toBe(true);
    expect(f.seen).toMatchObject({ transactions: 2, writes: 2, auditAttempts: 2, commits: 1, rollbacks: 1 });
    expect(f.state().audits).toHaveLength(1); expect(f.state().seal.sealCode).toBe(before.seal.sealCode);
    expect(f.state().audits[0].detail.before.sealCode).toBe(before.seal.sealCode);
    if (action.name === 'update') expect(f.state().links.map((row: any) => row.sampleBatchId)).toEqual(['SB-new']);
    else { expect(f.state().seal.deletedAt).not.toBeNull(); expect(f.state().links).toEqual(before.links); }
  });
});

describe('actual SealSample finite action constraints', () => {
  it('converted update retains LOCKED/409', async () => {
    const f = fixture(); f.mutate(state => { state.seal.status = 'converted'; });
    business(await actions[0].run(f), 'LOCKED', 409, '已转档的封样不可修改'); expect(f.seen.writes).toBe(0);
  });
  it('sealed batch change retains LOCKED/409', async () => {
    const f = fixture(); f.mutate(state => { state.seal.status = 'sealed'; });
    business(await actions[0].run(f), 'LOCKED', 409, '已封样的封样不可调整批次组合'); expect(f.seen.writes).toBe(0);
  });
  it('converted delete retains ALREADY_CONVERTED/409', async () => {
    const f = fixture(); f.mutate(state => { state.seal.status = 'converted'; });
    business(await actions[1].run(f), 'ALREADY_CONVERTED', 409, '已转档的封样不可删除'); expect(f.seen.writes).toBe(0);
  });
  it('a batch outside the case retains BATCH_NOT_IN_CASE/400', async () => {
    const f = fixture(); f.mutate(state => { state.batches[0].developmentCaseId = 'DC-other'; });
    business(await actions[0].run(f), 'BATCH_NOT_IN_CASE', 400, '存在不属于本开发案或已删除的样品批次'); expect(f.seen.writes).toBe(0);
  });
  it('mixed actual suppliers retain CROSS_SUPPLIER_SEAL/400', async () => {
    const f = fixture(); business(await updateSealSample({ prisma: f.prisma, sealId: SEAL_ID, actorId: ACTOR_ID,
      input: { batchIds: ['SB-new', 'SB-other-mill'] } }), 'CROSS_SUPPLIER_SEAL', 400, '封样只能组合同一工厂的样品批次（跨厂组合禁止）');
    expect(f.seen.writes).toBe(0);
  });
  it('post-commit link read failure returns safe unknown without pretending the successful transaction rolled back', async () => {
    const f = fixture(); f.control.linksFault = Error(SQL_SECRET); safeFailure(await actions[0].run(f), actions[0]);
    expect(f.seen).toMatchObject({ commits: 1, rollbacks: 0, writes: 1, auditAttempts: 1 });
    expect(f.state().seal.name).toBe('Revised seal'); expect(f.state().audits).toHaveLength(1);
    expect(f.state().links.map((row: any) => row.sampleBatchId)).toEqual(['SB-new']);
  });
});
