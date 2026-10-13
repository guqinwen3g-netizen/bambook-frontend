import { describe, expect, it, vi } from 'vitest';
import {
  assertCustomerConfirmationMatchesTarget,
  assertFinalCustomerConfirmationInTx,
  canonicalCustomerConfirmationJson,
  recordBusinessConfirmationInTx,
  validateCustomerConfirmationCommand,
} from './customerConfirmationService';

const fingerprint = (char: string) => char.repeat(64);
const actor: any = { userId: 'operator-1', roles: ['sales'], permissions: [], authorizationLoaded: true };
const baseCommand = (overrides: Record<string, unknown> = {}) => ({
  targetType: 'OrderChangeRequest', targetId: 'OCR__1', finalContentFingerprint: fingerprint('a'),
  internalApprovalId: 'approval-1', scopeFingerprint: fingerprint('b'),
  scope: { changeType: 'unitPrice', lineIds: ['line-1'] }, outcome: 'accepted' as const,
  customerName: '客户联系人', customerAddress: null,
  confirmedAt: new Date(Date.now() - 1_000).toISOString(), channel: 'email' as const,
  idempotencyKey: '11111111-1111-4111-8111-111111111111', ...overrides,
});
const evidence: any = {
  sourceType: 'email_selection', sourceFingerprint: fingerprint('c'),
  sourceSnapshot: { email: { id: 'EML__1', bodyText: '收到，按此报价执行。' } },
  selectionSnapshot: { kind: 'email_selection', emailId: 'EML__1', selectedText: '按此报价执行' }, blobs: [],
};

function makeTx() {
  const state = { confirmations: [] as any[], evidence: [] as any[], confirmationEvidence: [] as any[], audit: [] as any[] };
  const tx: any = {
    $queryRawUnsafe: vi.fn(async () => []),
    businessConfirmation: {
      findUnique: vi.fn(async ({ where }: any) => state.confirmations.find(row => row.recordedBy === where.recordedBy_requestKey.recordedBy
        && row.requestKey === where.recordedBy_requestKey.requestKey) ?? null),
      findFirst: vi.fn(async ({ where }: any) => state.confirmations.filter(row => row.targetType === where.targetType && row.targetId === where.targetId
        && row.finalContentFingerprint === where.finalContentFingerprint && row.scopeFingerprint === where.scopeFingerprint)
        .sort((a, b) => b.revision - a.revision)[0] ?? null),
      create: vi.fn(async ({ data }: any) => { state.confirmations.push(data); return data; }),
    },
    customerEvidence: {
      findUnique: vi.fn(async ({ where }: any) => state.evidence.find(row => row.sourceFingerprint === where.sourceFingerprint) ?? null),
      create: vi.fn(async ({ data }: any) => { state.evidence.push(data); return data; }),
    },
    customerEvidenceFile: { findUnique: vi.fn(async () => null) },
    customerEvidenceFileLink: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    businessConfirmationEvidence: {
      findFirst: vi.fn(async ({ where }: any) => state.confirmationEvidence.find(row => row.confirmationId === where.confirmationId && row.evidenceId === where.evidenceId)
        ? { evidence: state.evidence.find(row => row.id === state.confirmationEvidence.find(link => link.confirmationId === where.confirmationId)?.evidenceId) }
        : null),
      create: vi.fn(async ({ data }: any) => { state.confirmationEvidence.push(data); return data; }),
      findMany: vi.fn(async ({ where }: any) => state.confirmationEvidence.filter(row => row.confirmationId === where.confirmationId)
        .map(row => ({ ...row, evidence: { ...state.evidence.find(item => item.id === row.evidenceId), files: [] } }))),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => { state.audit.push(data); return data; }),
      findUnique: vi.fn(async ({ where }: any) => state.audit.find(row => row.id === where.id) ?? null),
    },
    _state: state,
  };
  return tx;
}

describe('customer confirmation contract', () => {
  it('locks confirmation to the exact internally approved content and full scope', () => {
    const command = baseCommand();
    const snapshot = { eligible: true, finalContentFingerprint: command.finalContentFingerprint,
      internalApprovalId: command.internalApprovalId, scopeFingerprint: command.scopeFingerprint, scope: command.scope };
    expect(() => assertCustomerConfirmationMatchesTarget(command, snapshot)).not.toThrow();
    expect(() => assertCustomerConfirmationMatchesTarget({ ...command, finalContentFingerprint: fingerprint('d') }, snapshot))
      .toThrow('客户答复证据对应的内容或范围与当前内部最终版本不一致');
    expect(() => assertCustomerConfirmationMatchesTarget({ ...command, scope: { changeType: 'unitPrice', lineIds: ['line-2'] } }, snapshot))
      .toThrow('客户答复证据对应的内容或范围与当前内部最终版本不一致');
  });

  it('requires a separate domain scope for partial acceptance and keeps full final scope intact', () => {
    const partial = baseCommand({ outcome: 'partial' });
    expect(() => validateCustomerConfirmationCommand(partial)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    const completed = { ...partial, decisionScope: { acceptedLineIds: ['line-1'], pendingLineIds: ['line-2'] } };
    expect(() => validateCustomerConfirmationCommand(completed)).not.toThrow();
    expect(canonicalCustomerConfirmationJson(completed.scope)).toBe(canonicalCustomerConfirmationJson(baseCommand().scope));
    expect(() => validateCustomerConfirmationCommand({ ...baseCommand(), decisionScope: { acceptedLineIds: ['line-1'] } }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('records one immutable confirmation, replays an identical key, rejects changed reuse, and versions an explicit correction', async () => {
    const tx = makeTx();
    const command = baseCommand();
    const first = await recordBusinessConfirmationInTx(tx, { command, actor, evidence, now: 1_000 });
    expect(first.replayed).toBe(false);
    expect(tx._state.confirmations).toHaveLength(1);
    expect(tx._state.confirmations[0]).toMatchObject({ revision: 1, supersedesId: null, outcome: 'accepted' });
    const accepted = await assertFinalCustomerConfirmationInTx(tx, { targetType: command.targetType, targetId: command.targetId, actor,
      finalContentFingerprint: command.finalContentFingerprint, internalApprovalId: command.internalApprovalId,
      scopeFingerprint: command.scopeFingerprint, requiredScope: command.scope });
    expect(accepted.confirmation.id).toBe(first.confirmation.id);

    const findUnique = tx.businessConfirmation.findUnique;
    let requestKeyLookups = 0;
    tx.businessConfirmation.findUnique = vi.fn(async (input: any) => {
      requestKeyLookups += 1;
      // Model another exact retry committing while this request waits on the
      // target-version advisory lock.
      return requestKeyLookups === 1 ? null : findUnique(input);
    });
    const replay = await recordBusinessConfirmationInTx(tx, { command, actor, evidence, now: 2_000 });
    expect(replay.replayed).toBe(true);
    expect(replay.confirmation.id).toBe(first.confirmation.id);
    expect(requestKeyLookups).toBe(2);
    await expect(recordBusinessConfirmationInTx(tx, { command: { ...command, outcome: 'rejected' }, actor, evidence }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(recordBusinessConfirmationInTx(tx, { command: { ...command, idempotencyKey: '22222222-2222-4222-8222-222222222222' }, actor, evidence }))
      .rejects.toMatchObject({ code: 'VERSION_ALREADY_CONFIRMED' });

    const corrected = await recordBusinessConfirmationInTx(tx, { command: {
      ...command, idempotencyKey: '33333333-3333-4333-8333-333333333333',
      supersedesConfirmationId: first.confirmation.id, correctionReason: '客户邮件明确撤回上一版回复。', outcome: 'rejected',
    }, actor, evidence, now: 3_000 });
    expect(corrected.replayed).toBe(false);
    expect(tx._state.confirmations).toHaveLength(2);
    expect(corrected.confirmation).toMatchObject({ revision: 2, supersedesId: first.confirmation.id, outcome: 'rejected' });
    await expect(assertFinalCustomerConfirmationInTx(tx, { targetType: command.targetType, targetId: command.targetId, actor,
      finalContentFingerprint: command.finalContentFingerprint, internalApprovalId: command.internalApprovalId,
      scopeFingerprint: command.scopeFingerprint, requiredScope: command.scope }))
      .rejects.toMatchObject({ code: 'CUSTOMER_CONFIRMATION_REQUIRED' });
  });

  it('refuses final apply without an accepted exact confirmation and bound source/audit facts', async () => {
    const tx: any = makeTx();
    const command = baseCommand();
    const badActor = { ...actor, authorizationLoaded: false };
    await expect(assertFinalCustomerConfirmationInTx(tx, { targetType: command.targetType, targetId: command.targetId, actor: badActor,
      finalContentFingerprint: command.finalContentFingerprint, internalApprovalId: command.internalApprovalId,
      scopeFingerprint: command.scopeFingerprint }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(assertFinalCustomerConfirmationInTx(tx, { targetType: command.targetType, targetId: command.targetId, actor,
      finalContentFingerprint: command.finalContentFingerprint, internalApprovalId: command.internalApprovalId,
      scopeFingerprint: command.scopeFingerprint }))
      .rejects.toMatchObject({ code: 'CUSTOMER_CONFIRMATION_REQUIRED' });
  });
});
