import { describe, expect, it, vi } from 'vitest';
import { createExceptionService } from '../exceptionService';
vi.mock('../../devPanel/activeDb', () => ({ getActiveDb: () => 'panda_hub_dev' }));

// Real service, serialized in-memory transaction adapter. Concurrency here is
// control-flow evidence; the separate opt-in PG test proves actual row locks.
const NOW = new Date('2026-10-01T09:00:00Z');
const input = { exceptionId: 'exception-consume', targetType: 'Shipment', targetId: 'shipment-consume', action: 'shipment:release', consumedBy: 'actual-consumer', at: NOW };
const scope = (overrides: any = {}) => ({ targetType: input.targetType, targetId: input.targetId, action: input.action, responsibleOwnerId: 'followup-person', validUntil: null, maxUses: 1, usedCount: 0, consumptions: [], ...overrides });
function fixture(scopeOverrides: any = {}, overrides: any = {}) {
  const state: any = { row: { id: input.exceptionId, exceptionNumber: 'EXC-CONSUME', status: 'ReviewerApproved', deletedAt: null, attachments: { files: ['keep-evidence'], extra: 'keep-metadata', scope: scope(scopeOverrides) }, ...overrides }, audits: [], failAudit: false, failAuditAction: undefined, failLock: false, lostCas: false, beforeLock: undefined };
  const copy = (value: any) => JSON.parse(JSON.stringify(value));
  let tail: Promise<void> = Promise.resolve();
  const prisma: any = {
    dr013ExceptionRequest: {
      findUnique: vi.fn(async () => state.row ? copy(state.row) : null), findMany: vi.fn(async () => state.row ? [copy(state.row)] : []),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (state.lostCas || !state.row || state.row.deletedAt || where.id !== state.row.id || where.status !== state.row.status) return { count: 0 };
        if (where.approvalRequestId !== undefined && where.approvalRequestId !== state.row.approvalRequestId) return { count: 0 };
        if (where.attachments && JSON.stringify(where.attachments.equals) !== JSON.stringify(state.row.attachments)) return { count: 0 };
        Object.assign(state.row, data); return { count: 1 };
      }),
    },
    approvalRequest: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn(async ({ data }: any) => { if (state.failAudit || state.failAuditAction === data.action) throw Error('injected audit failure'); state.audits.push(data); return data; }) },
    $queryRaw: vi.fn(async () => { if (state.failLock) throw Error('injected lock failure'); if (state.beforeLock) state.beforeLock(); return state.row ? [{ id: state.row.id }] : []; }),
    $transaction: vi.fn((work: any) => {
      const previous = tail; let release!: () => void; tail = new Promise(resolve => { release = resolve; });
      return (async () => { await previous; const before = copy(state.row); const auditsBefore = state.audits.length;
        try { return await work(prisma); } catch (error) { state.row = before; state.audits.length = auditsBefore; throw error; } finally { release(); }
      })();
    }),
  };
  return { state, prisma, service: createExceptionService({ prisma, approvalCreateService: {} as any }) };
}

describe('EXC deadlines and consumption invariants (storage substitutes)', () => {
  it('checks validity at the business instant but records an implicit consumption at real process time', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('BAMBOOK_DEV_PANEL', '1'); vi.stubEnv('TZ', 'UTC');
    vi.stubEnv('DATABASE_URL', 'postgresql://clock-test:unused@127.0.0.1:1/panda_hub_dev');
    vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', '2026-10-08T00:18:00.000Z');
    vi.useFakeTimers(); vi.setSystemTime(new Date('2034-12-31T18:00:00.000Z'));
    try {
      const { state, service } = fixture({ validUntil: '2026-10-09T00:00:00.000Z' });
      expect(await service.hasActiveException({ ...input, at: undefined })).toMatchObject({ active: true });
      expect(await service.consumeException({ ...input, at: undefined })).toMatchObject({ ok: true });
      expect(state.row.attachments.scope.validUntil).toBe('2026-10-09T00:00:00.000Z');
      expect(state.row.attachments.scope.consumptions).toEqual([{ consumedBy: input.consumedBy,
        consumedAt: '2034-12-31T18:00:00.000Z', note: null }]);
      expect(state.audits).toHaveLength(1);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it('unexpired legal consumption preserves evidence, spends one use and audits actual actor', async () => {
    const { state, prisma, service } = fixture({ maxUses: 2 });
    expect(await service.consumeException(input)).toMatchObject({ ok: true, data: { consumed: true } });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.any(Array), input.exceptionId);
    expect(state.row).toMatchObject({ status: 'ReviewerApproved', attachments: { files: ['keep-evidence'], extra: 'keep-metadata', scope: { usedCount: 1, maxUses: 2, consumptions: [{ consumedBy: input.consumedBy, consumedAt: NOW.toISOString(), note: null }] } } });
    expect(state.audits).toHaveLength(1); expect(state.audits[0]).toMatchObject({ actorId: input.consumedBy, action: 'dr013_exception_consumed' });
  });
  it('concurrent consumers of one-use scope yield one success and one consumed denial', async () => {
    const { state, service } = fixture();
    const result = await Promise.all([service.consumeException(input), service.consumeException(input)]);
    expect(result.filter(r => r.ok)).toHaveLength(1); expect(result.filter(r => !r.ok)).toMatchObject([{ error: { code: 'EXCEPTION_ALREADY_CONSUMED' } }]);
    expect(state.row.status).toBe('Consumed'); expect(state.row.attachments.scope.usedCount).toBe(1); expect(state.audits).toHaveLength(1);
  });
  it('audit failure rolls quota/state back; a later explicit retry may consume', async () => {
    const { state, service } = fixture(); state.failAudit = true;
    expect(await service.consumeException(input)).toMatchObject({ ok: false, error: { code: 'EXCEPTION_CONSUME_FAILED', message: expect.stringContaining('本次未确认任何改动') } });
    expect(state.row.status).toBe('ReviewerApproved'); expect(state.row.attachments.scope.usedCount).toBe(0); expect(state.audits).toEqual([]);
    state.failAudit = false; expect(await service.consumeException(input)).toMatchObject({ ok: true }); expect(state.audits).toHaveLength(1);
  });
  it('failed consumption retains an earlier committed approval projection and does not promise that history was unchanged', async () => {
    const { state, prisma, service } = fixture({}, { status: 'Pending', approvalRequestId: 'approval-committed' });
    prisma.approvalRequest.findUnique.mockResolvedValue({ id: 'approval-committed', status: 'approved', reviewerId: 'actual-committed-reviewer' });
    state.failAuditAction = 'dr013_exception_consumed';
    const result = await service.consumeException(input);
    expect(result).toMatchObject({ ok: false, error: { code: 'EXCEPTION_CONSUME_FAILED', message: expect.stringContaining('本次未确认核销') } });
    if (!result.ok) expect(result.error.message).not.toContain('本次未确认任何改动');
    expect(state.row).toMatchObject({ status: 'ReviewerApproved', attachments: { scope: { usedCount: 0, consumptions: [] } } });
    expect(state.audits).toHaveLength(1); expect(state.audits[0]).toMatchObject({ actorId: 'actual-committed-reviewer', action: 'dr013_exception_approved', beforeValue: 'Pending', afterValue: 'ReviewerApproved' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('external transaction audit failure reports only unconfirmed consumption; caller rolls the outer transaction back', async () => {
    const { state, prisma, service } = fixture(); state.failAudit = true; let message = '';
    await expect(prisma.$transaction(async (tx: any) => {
      const result = await service.consumeException({ ...input, tx });
      if (!result.ok) { message = result.error.message; throw Error(result.error.code); }
    })).rejects.toThrow('EXCEPTION_CONSUME_FAILED');
    expect(message).toContain('本次未确认核销'); expect(message).not.toContain('本次未确认任何改动');
    expect(state.row).toMatchObject({ status: 'ReviewerApproved', attachments: { scope: { usedCount: 0 } } }); expect(state.audits).toEqual([]); expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['earlier', 'exact-deadline'])('%s rejects even when expiration projection/audit fails', async label => {
    const { state, service } = fixture({ validUntil: label === 'earlier' ? new Date(NOW.getTime() - 1).toISOString() : NOW.toISOString() }); state.failAudit = true;
    expect(await service.hasActiveException(input)).toEqual({ active: false, reason: 'EXCEPTION_EXPIRED' });
    expect(await service.consumeException(input)).toMatchObject({ ok: false, error: { code: 'EXCEPTION_EXPIRED' } });
    expect(state.row.status).toBe('ReviewerApproved'); expect(state.row.attachments.scope.usedCount).toBe(0); expect(state.audits).toEqual([]);
  });
  it('concurrent expiration projections have one CAS winner and one expiration audit', async () => {
    const { state, service } = fixture({ validUntil: NOW.toISOString() });
    expect(await Promise.all([service.hasActiveException(input), service.hasActiveException(input)])).toEqual([{ active: false, reason: 'EXCEPTION_EXPIRED' }, { active: false, reason: 'EXCEPTION_EXPIRED' }]);
    expect(state.row.status).toBe('Expired'); expect(state.audits).toHaveLength(1);
  });
  it.each([
    ['maxUses zero', { maxUses: 0 }], ['fractional maxUses', { maxUses: 1.5 }], ['string maxUses', { maxUses: '2' }],
    ['negative usedCount', { usedCount: -1 }], ['fractional usedCount', { usedCount: 0.5 }], ['missing usedCount', { usedCount: undefined }],
    ['invalid deadline', { validUntil: 'not-a-date' }], ['missing deadline', { validUntil: undefined }], ['empty target', { targetId: '' }],
    ['empty action', { action: '' }], ['missing followup owner', { responsibleOwnerId: '' }], ['invalid consumption list', { consumptions: {} }],
    ['invalid consumption fact', { consumptions: [{ consumedBy: '', consumedAt: 'invalid' }] }],
  ])('malformed %s cannot open a gate or consume', async (_label, patch) => {
    const { state, prisma, service } = fixture(patch);
    expect((await service.hasActiveException(input)).active).toBe(false);
    expect(await service.consumeException(input)).toMatchObject({ ok: false, error: { code: 'EXCEPTION_SCOPE_INVALID' } });
    expect(prisma.$queryRaw).not.toHaveBeenCalled(); expect(prisma.dr013ExceptionRequest.updateMany).not.toHaveBeenCalled(); expect(state.audits).toEqual([]);
  });
  it.each(['target', 'action', 'status', 'deadline', 'quota'])('lock re-read rejects changed current %s', async field => {
    const { state, service } = fixture(); state.beforeLock = () => {
      if (field === 'target') state.row.attachments.scope.targetId = 'other-shipment';
      if (field === 'action') state.row.attachments.scope.action = 'shipment:book';
      if (field === 'status') state.row.status = 'Cancelled';
      if (field === 'deadline') state.row.attachments.scope.validUntil = NOW.toISOString();
      if (field === 'quota') state.row.attachments.scope.usedCount = 1;
    };
    const result = await service.consumeException(input); expect(result.ok).toBe(false); expect(state.audits).toEqual([]);
    expect(state.row.attachments.scope.consumptions).toEqual([]);
  });
  it.each(['lock', 'cas'])('%s failure has no success audit or quota spend', async mode => {
    const { state, service } = fixture(); state.failLock = mode === 'lock'; state.lostCas = mode === 'cas';
    expect(await service.consumeException(input)).toMatchObject({ ok: false, error: { code: mode === 'lock' ? 'EXCEPTION_CONSUME_FAILED' : 'EXCEPTION_CONSUME_CONFLICT' } });
    expect(state.row.attachments.scope.usedCount).toBe(0); expect(state.audits).toEqual([]);
  });
  it('external transaction seam uses its supplied client and opens no nested transaction', async () => {
    const { state, prisma, service } = fixture();
    expect(await service.consumeException({ ...input, tx: prisma })).toMatchObject({ ok: true }); expect(prisma.$transaction).not.toHaveBeenCalled(); expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); expect(state.audits).toHaveLength(1);
  });
});
