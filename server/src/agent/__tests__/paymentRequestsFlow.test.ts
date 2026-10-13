import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildPaymentRequestCreateDraft,
  commitPaymentRequestCreate,
  buildPaymentRequestCancelDraft,
  commitPaymentRequestCancel,
  validatePaymentRequestCreateDraftSemantics,
  buildPaymentRequestsFlowError,
  type PaymentRequestsFlowErrorCode,
} from '../paymentRequestsFlow';

const mocks = vi.hoisted(() => ({
  createPaymentRequest: vi.fn(),
  cancelPaymentRequest: vi.fn(),
}));

vi.mock('../../paymentRequests/paymentRequestService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createPaymentRequestService: () => ({
      createPaymentRequest: mocks.createPaymentRequest,
      cancelPaymentRequest: mocks.cancelPaymentRequest,
    }),
  };
});
vi.mock('../../approvals/approvalRoutingService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createApprovalRoutingService: () => ({}) };
});
vi.mock('../../approvals/approvalCreateService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, createApprovalCreateService: () => ({}) };
});

const createInput = {
  supplierId: 'REL-S1',
  supplierName: '某面料供应商',
  totalAmount: '50000.0000',
  currency: 'CNY',
  paymentCategory: 'advance',
  expectedPaymentDate: '2026-08-30',
  applicantId: 'usr_1',
};

describe('paymentRequestsFlow create/cancel draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create draft 含 ProcessDraft 六字段 + toolId/action', () => {
    const draft = buildPaymentRequestCreateDraft({ input: createInput });
    expect(draft.subOperations[0].toolId).toBe('payment_requests.create');
    expect(draft.subOperations[0].action).toBe('create_payment_request');
    expect(draft.beforeAfterDiff.length).toBeGreaterThan(0);
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'paymentRequest', entityId: 'REL-S1', field: 'status', before: null, after: 'Pending' });
    expect(draft.impactScope).toEqual(['finance', 'approvals', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('payment_requests.create:REL-S1:pd:');
  });

  it('create commit 成功复用 createPaymentRequest service', async () => {
    const draft = buildPaymentRequestCreateDraft({ input: createInput });
    mocks.createPaymentRequest.mockResolvedValue({ ok: true, data: { paymentRequest: { id: 'PAYR_1', requestNumber: 'PAYR-20260817-001' }, approvalRequestId: 'AR-BIZ-1' } });
    const r = await commitPaymentRequestCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.paymentRequestId).toBe('PAYR_1');
      expect(r.feedback.domainApprovalId).toBe('AR-BIZ-1');
    }
    expect(mocks.createPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({
      supplierId: 'REL-S1', totalAmount: '50000.0000', currency: 'CNY', applicantId: 'usr_1',
    }));
  });

  it('create hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildPaymentRequestCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), totalAmount: '999999.0000' } }] };
    const r = await commitPaymentRequestCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('create 缺 processDraft → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitPaymentRequestCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('create 语义校验：缺付款对象 / 非法 paymentCategory → SEMANTIC_VALIDATION_FAILED', () => {
    const noPayee = buildPaymentRequestCreateDraft({ input: { ...createInput, supplierId: undefined, supplierName: undefined } });
    expect(validatePaymentRequestCreateDraftSemantics(noPayee).ok).toBe(false);
    const badCategory = buildPaymentRequestCreateDraft({ input: { ...createInput, paymentCategory: 'bogus' } });
    const r = validatePaymentRequestCreateDraftSemantics(badCategory);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error!.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });

  it('create service 返回 NO_REVIEWER_RESOLVED → failed + 错误码透传', async () => {
    const draft = buildPaymentRequestCreateDraft({ input: createInput });
    mocks.createPaymentRequest.mockResolvedValue({ ok: false, error: { code: 'NO_REVIEWER_RESOLVED', message: '无法解析审批人', statusCode: 409 } });
    const r = await commitPaymentRequestCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('NO_REVIEWER_RESOLVED');
  });

  it('cancel draft 含 status diff', () => {
    const draft = buildPaymentRequestCancelDraft({ paymentRequestId: 'PAYR_1', actorId: 'usr_1', currentSnapshot: { status: 'Pending' } });
    expect(draft.subOperations[0].toolId).toBe('payment_requests.cancel');
    expect(draft.subOperations[0].action).toBe('cancel_payment_request');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'paymentRequest', entityId: 'PAYR_1', field: 'status', before: 'Pending', after: 'Cancelled' });
    expect(draft.idempotencyKey).toContain('payment_requests.cancel:PAYR_1:pd:');
  });

  it('cancel commit 成功复用 cancelPaymentRequest service', async () => {
    const draft = buildPaymentRequestCancelDraft({ paymentRequestId: 'PAYR_1', actorId: 'usr_1' });
    mocks.cancelPaymentRequest.mockResolvedValue({ ok: true, data: { paymentRequest: { id: 'PAYR_1', requestNumber: 'PAYR-1', status: 'Cancelled' } } });
    const r = await commitPaymentRequestCancel({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(mocks.cancelPaymentRequest).toHaveBeenCalledWith({ paymentRequestId: 'PAYR_1', actorId: 'usr_1' });
  });

  it('cancel hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildPaymentRequestCancelDraft({ paymentRequestId: 'PAYR_1', actorId: 'usr_1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { paymentRequestId: 'PAYR_2', actorId: 'usr_1' } }] };
    const r = await commitPaymentRequestCancel({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.cancelPaymentRequest).not.toHaveBeenCalled();
  });

  it('cancel service 返回 PAYMENT_REQUEST_NOT_CANCELLABLE → failed + 错误码透传', async () => {
    const draft = buildPaymentRequestCancelDraft({ paymentRequestId: 'PAYR_1', actorId: 'usr_1' });
    mocks.cancelPaymentRequest.mockResolvedValue({ ok: false, error: { code: 'PAYMENT_REQUEST_NOT_CANCELLABLE', message: '仅 Draft/Pending 可作废', statusCode: 409 } });
    const r = await commitPaymentRequestCancel({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PAYMENT_REQUEST_NOT_CANCELLABLE');
  });

  it('所有 error code 有 userAction', () => {
    const codes: PaymentRequestsFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'MISSING_PAYEE', 'INVALID_AMOUNT', 'MISSING_CURRENCY', 'INVALID_PAYMENT_CATEGORY',
      'INVALID_DATE', 'PAYMENT_REQUEST_NOT_FOUND', 'PAYMENT_REQUEST_NOT_APPROVED',
      'PAYMENT_REQUEST_NOT_CANCELLABLE', 'CANCEL_NOT_BY_APPLICANT', 'VOUCHER_ISSUE_FAILED',
      'CREATE_FAILED', 'NO_REVIEWER_RESOLVED',
    ];
    for (const code of codes) expect(buildPaymentRequestsFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });
});
