import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildQuotationCreateDraft,
  validateQuotationCreateDraftSemantics,
  verifyQuotationCreateDraftHash,
  commitQuotationCreate,
  buildQuotationUpdateDraft,
  validateQuotationUpdateDraftSemantics,
  commitQuotationUpdate,
  buildQuotationFlowError,
  type QuotationFlowErrorCode,
} from '../quotationFlow';

vi.mock('../../quotations/quotationService', () => ({
  createQuotationService: vi.fn(),
  QUOTATION_CREATE_FIELDS: [
    'quotationNumber', 'currency', 'customerRelationId', 'customerName', 'customerCode', 'issueDate',
    'validUntil', 'deliveryTerms', 'paymentTerms', 'salesperson', 'inquiryRef', 'exchangeRate',
    'baseCurrency', 'notes', 'lines', 'trackAMedianUsd', 'trackAUnit', 'trackBFinalUsd',
  ],
  QUOTATION_UPDATE_PATCH_FIELDS: [
    'quotationNumber', 'currency', 'customerRelationId', 'customerName', 'customerCode', 'issueDate',
    'validUntil', 'deliveryTerms', 'paymentTerms', 'salesperson', 'inquiryRef', 'exchangeRate',
    'baseCurrency', 'notes', 'lines',
  ],
}));
import { createQuotationService } from '../../quotations/quotationService';

const createQuotation = vi.fn();
const updateQuotation = vi.fn();

const createInput = {
  quotationNumber: 'Q-2026-0001',
  currency: 'USD',
  customerName: 'Globex Apparel',
  issueDate: '2026-08-17',
  validUntil: '2026-09-17',
  lines: [{ description: 'Wool Blend Fabric', unit: 'm', quantity: 500, unitPrice: 8.2 }],
};

describe('task quotation-flow: buildQuotationCreateDraft', () => {
  it('生成含六字段的 ProcessDraft（toolId/action/impactScope/idempotencyKey）', () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    expect(draft.subOperations[0].toolId).toBe('quotation.create');
    expect(draft.subOperations[0].action).toBe('create_quotation');
    expect((draft.subOperations[0].after as any).quotationNumber).toBe('Q-2026-0001');
    expect(draft.beforeAfterDiff.length).toBe(Object.keys(createInput).length);
    expect(draft.impactScope).toEqual(['quotations', 'entity-links', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('quotation.create:Q-2026-0001:');
  });
});

describe('task quotation-flow: buildQuotationUpdateDraft', () => {
  it('生成含 quotationId+patch 的 ProcessDraft（before 用 currentSnapshot）', () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { paymentTerms: 'TT 30天' }, currentSnapshot: { paymentTerms: 'TT' } });
    expect(draft.subOperations[0].toolId).toBe('quotation.update');
    expect((draft.subOperations[0].after as any).quotationId).toBe('Q__1');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'quotation', entityId: 'Q__1', field: 'paymentTerms', before: 'TT', after: 'TT 30天' });
    expect(draft.idempotencyKey).toContain('quotation.update:Q__1:');
  });
});

describe('task quotation-flow: validateQuotationCreateDraftSemantics（fail closed）', () => {
  it('缺 currency → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, currency: '' } }] } as any;
    expect(validateQuotationCreateDraftSemantics(draft).ok).toBe(false);
  });

  it('缺 issueDate → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, issueDate: undefined } }] } as any;
    expect(validateQuotationCreateDraftSemantics(draft).ok).toBe(false);
  });

  it('lines 为空 → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, lines: [] } }] } as any;
    expect(validateQuotationCreateDraftSemantics(draft).ok).toBe(false);
  });

  it('line 缺 unitPrice → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, lines: [{ description: 'x', unit: 'm', quantity: 1 }] } }] } as any;
    expect(validateQuotationCreateDraftSemantics(draft).ok).toBe(false);
  });

  it('合法 draft → ok', () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    expect(validateQuotationCreateDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task quotation-flow: validateQuotationUpdateDraftSemantics（fail closed）', () => {
  it('缺 quotationId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { patch: { notes: 'x' } } }] } as any;
    expect(validateQuotationUpdateDraftSemantics(draft).ok).toBe(false);
  });

  it('patch 为空 → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { quotationId: 'Q__1', patch: {} } }] } as any;
    expect(validateQuotationUpdateDraftSemantics(draft).ok).toBe(false);
  });

  it('patch.lines 非法 → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { quotationId: 'Q__1', patch: { lines: [{ description: 'x' }] } } }] } as any;
    expect(validateQuotationUpdateDraftSemantics(draft).ok).toBe(false);
  });

  it('合法 draft → ok', () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { notes: 'updated' } });
    expect(validateQuotationUpdateDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task quotation-flow: commitQuotationCreate（复用 service）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createQuotationService as any).mockReturnValue({ createQuotation, updateQuotation });
  });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
    expect(createQuotation).not.toHaveBeenCalled();
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...createInput, currency: 'EUR' } }] };
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(createQuotation).not.toHaveBeenCalled();
  });

  it('非法字段（status 不走创建通道）→ INVALID_INPUT，service 不被调', async () => {
    const draft = buildQuotationCreateDraft({ input: { ...createInput, status: 'Accepted' } });
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_INPUT');
    expect(createQuotation).not.toHaveBeenCalled();
  });

  it('成功 commit → committed，svc.createQuotation 带注入的请求人调用一次（★ B58 补漏：位置参数也是身份位）', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockResolvedValue({ id: 'Q__1', quotationNumber: 'Q-2026-0001' });
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, actorId: 'usr_requester'});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.quotationId).toBe('Q__1');
      expect(r.feedback.quotationNumber).toBe('Q-2026-0001');
      expect(r.feedback.idempotencyKey).toBe(draft.idempotencyKey);
    }
    expect(createQuotation).toHaveBeenCalledTimes(1);
    expect(createQuotation).toHaveBeenCalledWith(expect.objectContaining({ quotationNumber: 'Q-2026-0001' }), 'usr_requester');
  });

  it('service 抛 P2002 → DUPLICATE_QUOTATION_NUMBER', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('DUPLICATE_QUOTATION_NUMBER');
  });

  it('service 抛「已存在」→ DUPLICATE_QUOTATION_NUMBER', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockRejectedValue(new Error('报价号 Q-2026-0001 已存在'));
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('DUPLICATE_QUOTATION_NUMBER');
  });

  it('service 抛未知错 → CREATE_FAILED', async () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    createQuotation.mockRejectedValue(new Error('db connection lost'));
    const r = await commitQuotationCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('CREATE_FAILED');
  });
});

describe('task quotation-flow: commitQuotationUpdate（复用 service）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createQuotationService as any).mockReturnValue({ createQuotation, updateQuotation });
  });

  it('writeOnce 双轨快照字段（trackAMedianUsd）→ INVALID_INPUT，service 不被调', async () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { trackAMedianUsd: 9.9 } });
    const r = await commitQuotationUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_INPUT');
    expect(updateQuotation).not.toHaveBeenCalled();
  });

  it('成功 commit → committed，svc.updateQuotation 带注入的请求人调用一次（★ B58 补漏：位置参数也是身份位）', async () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { paymentTerms: 'TT 30天' }, currentSnapshot: { paymentTerms: 'TT' } });
    updateQuotation.mockResolvedValue({ id: 'Q__1', quotationNumber: 'Q-2026-0001' });
    const r = await commitQuotationUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, actorId: 'usr_requester'});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(updateQuotation).toHaveBeenCalledTimes(1);
    expect(updateQuotation).toHaveBeenCalledWith('Q__1', { paymentTerms: 'TT 30天' }, 'usr_requester');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { notes: 'a' } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { quotationId: 'Q__1', patch: { notes: 'b' } } }] };
    const r = await commitQuotationUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(updateQuotation).not.toHaveBeenCalled();
  });

  it('service 抛「不存在」→ NOT_FOUND', async () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__X', patch: { notes: 'x' } });
    updateQuotation.mockRejectedValue(new Error('报价单 Q__X 不存在'));
    const r = await commitQuotationUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('NOT_FOUND');
  });

  it('service 抛「仅 Draft」→ NOT_EDITABLE', async () => {
    const draft = buildQuotationUpdateDraft({ quotationId: 'Q__1', patch: { notes: 'x' } });
    updateQuotation.mockRejectedValue(new Error('报价单状态 Sent 不可编辑（仅 Draft 可编辑）'));
    const r = await commitQuotationUpdate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('NOT_EDITABLE');
  });
});

describe('task quotation-flow: verifyQuotationCreateDraftHash', () => {
  it('原始 draft hash 自洽', () => {
    const draft = buildQuotationCreateDraft({ input: createInput });
    expect(verifyQuotationCreateDraftHash(draft).ok).toBe(true);
  });
});

describe('task quotation-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: QuotationFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'INVALID_INPUT', 'NOT_FOUND', 'DUPLICATE_QUOTATION_NUMBER', 'NOT_EDITABLE',
      'CREATE_FAILED', 'UPDATE_FAILED',
    ];
    for (const code of codes) expect(buildQuotationFlowError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});
