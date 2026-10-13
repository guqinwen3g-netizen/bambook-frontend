import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  registerPaymentRequestsFlowTools,
  buildPaymentRequestCreateDraft,
  buildPaymentRequestCancelDraft,
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

registerPaymentRequestsFlowTools();

const createInput = {
  supplierId: 'REL-S1',
  totalAmount: '50000.0000',
  currency: 'CNY',
  applicantId: 'usr_1',
};

describe('payment_requests create/cancel executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('payment_requests.create approved → committed', async () => {
    const draft = buildPaymentRequestCreateDraft({ input: createInput });
    mocks.createPaymentRequest.mockResolvedValue({ ok: true, data: { paymentRequest: { id: 'PAYR_1', requestNumber: 'PAYR-1' }, approvalRequestId: 'AR-BIZ-1' } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:payment_requests.create', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.paymentRequestId).toBe('PAYR_1');
    expect(mocks.createPaymentRequest).toHaveBeenCalledTimes(1);
  });

  it('payment_requests.cancel approved → committed', async () => {
    const draft = buildPaymentRequestCancelDraft({ paymentRequestId: 'PAYR_1', actorId: 'usr_1' });
    mocks.cancelPaymentRequest.mockResolvedValue({ ok: true, data: { paymentRequest: { id: 'PAYR_1', status: 'Cancelled' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'approved', actionType: 'tool:payment_requests.cancel', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.cancel', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(mocks.cancelPaymentRequest).toHaveBeenCalledTimes(1);
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'payment_requests.create', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.cancel', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(mocks.cancelPaymentRequest).not.toHaveBeenCalled();
  });

  it('approved 但 draft hash 被篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不调用', async () => {
    const draft = buildPaymentRequestCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), totalAmount: '1.0000' } }] };
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:payment_requests.create', payload: { processDraft: tampered } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'payment_requests.create', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createPaymentRequest).not.toHaveBeenCalled();
  });
});
