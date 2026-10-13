import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  registerCreditFlowTools,
  buildCreditFreezeDraft,
  buildCreditThawDraft,
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

registerCreditFlowTools();

const freezeInput = { relationId: 'REL-C1', reason: '逾期超60天', actorId: 'usr_1' };
const thawInput = { relationId: 'REL-C1', reason: '逾期款已全额核销', actorId: 'usr_1' };

describe('credit freeze/thaw executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('credit.freeze approved → committed', async () => {
    const draft = buildCreditFreezeDraft(freezeInput);
    mocks.freezeCredit.mockResolvedValue({ ok: true, data: { frozen: ['CL_1'] } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:credit.freeze', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'credit.freeze', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.relationId).toBe('REL-C1');
    expect(result.transitionedLimitIds).toEqual(['CL_1']);
    expect(mocks.freezeCredit).toHaveBeenCalledTimes(1);
  });

  it('credit.thaw approved → committed', async () => {
    const draft = buildCreditThawDraft(thawInput);
    mocks.thawCredit.mockResolvedValue({ ok: true, data: { thawed: ['CL_1'] } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'approved', actionType: 'tool:credit.thaw', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'credit.thaw', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.transitionedLimitIds).toEqual(['CL_1']);
    expect(mocks.thawCredit).toHaveBeenCalledTimes(1);
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'credit.freeze', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(mocks.freezeCredit).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'credit.freeze', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(mocks.freezeCredit).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'credit.thaw', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(mocks.thawCredit).not.toHaveBeenCalled();
  });

  it('approved 但 draft hash 被篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不调用', async () => {
    const draft = buildCreditFreezeDraft(freezeInput);
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...freezeInput, reason: '篡改理由' } }] };
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:credit.freeze', payload: { processDraft: tampered } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'credit.freeze', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.freezeCredit).not.toHaveBeenCalled();
  });
});
