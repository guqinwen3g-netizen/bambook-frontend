import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildCreditFreezeDraft,
  commitCreditFreeze,
  buildCreditThawDraft,
  commitCreditThaw,
  validateCreditFreezeDraftSemantics,
  validateCreditThawDraftSemantics,
  buildCreditFlowError,
  type CreditFlowErrorCode,
} from '../creditFlow';

const mocks = vi.hoisted(() => ({
  freezeCredit: vi.fn(),
  thawCredit: vi.fn(),
}));

vi.mock('../../credit/creditService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createCreditService: () => ({
      freezeCredit: mocks.freezeCredit,
      thawCredit: mocks.thawCredit,
    }),
  };
});

const freezeInput = { relationId: 'REL-C1', reason: '逾期超60天', actorId: 'usr_1' };
const thawInput = { relationId: 'REL-C1', reason: '逾期款已全额核销', actorId: 'usr_1' };

describe('creditFlow freeze/thaw draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('freeze draft 含 ProcessDraft 六字段 + toolId/action', () => {
    const draft = buildCreditFreezeDraft(freezeInput);
    expect(draft.subOperations[0].toolId).toBe('credit.freeze');
    expect(draft.subOperations[0].action).toBe('freeze_credit');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'creditLimit', entityId: 'REL-C1', field: 'status', before: 'Active', after: 'Frozen' });
    expect(draft.beforeAfterDiff[1]).toMatchObject({ entity: 'creditLimit', entityId: 'REL-C1', field: 'frozenBy', before: null, after: 'usr_1' });
    expect(draft.impactScope).toEqual(['credit', 'orders', 'risk', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey).toContain('credit.freeze:REL-C1:pd:');
  });

  it('freeze commit 成功复用 freezeCredit service', async () => {
    const draft = buildCreditFreezeDraft(freezeInput);
    mocks.freezeCredit.mockResolvedValue({ ok: true, data: { frozen: ['CL_1'] } });
    const r = await commitCreditFreeze({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.relationId).toBe('REL-C1');
      expect(r.feedback.transitionedLimitIds).toEqual(['CL_1']);
    }
    expect(mocks.freezeCredit).toHaveBeenCalledWith(expect.objectContaining({ relationId: 'REL-C1', reason: '逾期超60天', actorId: 'usr_1' }));
  });

  it('freeze hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildCreditFreezeDraft(freezeInput);
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...freezeInput, reason: '篡改理由' } }] };
    const r = await commitCreditFreeze({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.freezeCredit).not.toHaveBeenCalled();
  });

  it('freeze 缺 processDraft → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitCreditFreeze({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('freeze 语义校验：缺 relationId / 缺 reason / 缺 actorId → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateCreditFreezeDraftSemantics(buildCreditFreezeDraft({ ...freezeInput, relationId: '' })).ok).toBe(false);
    expect(validateCreditFreezeDraftSemantics(buildCreditFreezeDraft({ ...freezeInput, reason: '' })).ok).toBe(false);
    expect(validateCreditFreezeDraftSemantics(buildCreditFreezeDraft({ ...freezeInput, actorId: '' })).ok).toBe(false);
  });

  it('freeze service 返回 CREDIT_ALREADY_FROZEN → failed + 错误码透传', async () => {
    const draft = buildCreditFreezeDraft(freezeInput);
    mocks.freezeCredit.mockResolvedValue({ ok: false, error: { code: 'CREDIT_ALREADY_FROZEN', message: '已冻结', statusCode: 409 } });
    const r = await commitCreditFreeze({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('CREDIT_ALREADY_FROZEN');
  });

  it('thaw draft 含 status/thawedReason diff', () => {
    const draft = buildCreditThawDraft(thawInput);
    expect(draft.subOperations[0].toolId).toBe('credit.thaw');
    expect(draft.subOperations[0].action).toBe('thaw_credit');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'creditLimit', entityId: 'REL-C1', field: 'status', before: 'Frozen', after: 'Active' });
    expect(draft.beforeAfterDiff[1]).toMatchObject({ entity: 'creditLimit', entityId: 'REL-C1', field: 'thawedReason', before: null, after: '逾期款已全额核销' });
    expect(draft.idempotencyKey).toContain('credit.thaw:REL-C1:pd:');
  });

  it('thaw commit 成功复用 thawCredit service', async () => {
    const draft = buildCreditThawDraft(thawInput);
    mocks.thawCredit.mockResolvedValue({ ok: true, data: { thawed: ['CL_1'] } });
    const r = await commitCreditThaw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.transitionedLimitIds).toEqual(['CL_1']);
    expect(mocks.thawCredit).toHaveBeenCalledWith(expect.objectContaining({ relationId: 'REL-C1', reason: '逾期款已全额核销' }));
  });

  it('thaw hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildCreditThawDraft(thawInput);
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...thawInput, relationId: 'REL-C2' } }] };
    const r = await commitCreditThaw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.thawCredit).not.toHaveBeenCalled();
  });

  it('thaw service 返回 CREDIT_NOT_FROZEN → failed + 错误码透传', async () => {
    const draft = buildCreditThawDraft(thawInput);
    mocks.thawCredit.mockResolvedValue({ ok: false, error: { code: 'CREDIT_NOT_FROZEN', message: '无 Frozen 额度', statusCode: 409 } });
    const r = await commitCreditThaw({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('CREDIT_NOT_FROZEN');
  });

  it('所有 error code 有 userAction', () => {
    const codes: CreditFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'RELATION_REQUIRED', 'CREDIT_REASON_REQUIRED', 'CREDIT_LIMIT_NOT_FOUND',
      'CREDIT_ALREADY_FROZEN', 'CREDIT_NOT_FROZEN', 'INVALID_AMOUNT', 'CREDIT_WRITE_FAILED',
    ];
    for (const code of codes) expect(buildCreditFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });
});
