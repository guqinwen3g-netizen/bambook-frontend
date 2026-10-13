import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInvoiceCancelDraft,
  validateInvoiceCancelDraftSemantics,
  verifyInvoiceCancelDraftHash,
  commitInvoiceCancel,
  buildInvoiceCancelError,
  type InvoiceCancelFlowErrorCode,
} from '../invoiceCancelFlow';

vi.mock('../../finance/voidDeleteService', () => ({
  cancelInvoice: vi.fn(),
}));
import { cancelInvoice } from '../../finance/voidDeleteService';

describe('task invoice-cancel-flow: buildInvoiceCancelDraft（what-you-approve-is-what-you-commit）', () => {
  it('生成含 invoiceId + reason 的 ProcessDraft', () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', reason: '客户退货', currentStatus: 'Issued' });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('invoice.cancel');
    expect((draft.subOperations[0].after as any).invoiceId).toBe('INV__1');
    expect((draft.subOperations[0].after as any).reason).toBe('客户退货');
    expect(draft.impactScope).toEqual(['finance']);
  });

  it('beforeAfterDiff 用真实 currentStatus（不 hardcode Issued）', () => {
    const draft1 = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'PartiallyPaid' });
    expect(draft1.beforeAfterDiff[0].before).toBe('PartiallyPaid');
    const draft2 = buildInvoiceCancelDraft({ invoiceId: 'INV__2', currentStatus: 'Paid' });
    expect(draft2.beforeAfterDiff[0].before).toBe('Paid');
  });
});

describe('task invoice-cancel-flow: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    expect(verifyInvoiceCancelDraftHash(draft).ok).toBe(true);
  });
  it('篡改 invoiceId → hash 不匹配', () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, invoiceId: 'HACKED' } }] };
    expect(verifyInvoiceCancelDraftHash(tampered).ok).toBe(false);
  });
});

describe('task invoice-cancel-flow: validateInvoiceCancelDraftSemantics（fail closed）', () => {
  it('缺 invoiceId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { reason: 'test' } }], idempotencyKey: 't' } as any;
    expect(validateInvoiceCancelDraftSemantics(draft).ok).toBe(false);
  });
});

describe('task invoice-cancel-flow: 13 error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: InvoiceCancelFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'INVOICE_NOT_FOUND', 'VOUCHER_NOT_FOUND', 'INVALID_STATUS', 'HAS_ALLOCATIONS', 'CANCEL_FAILED', 'DELETE_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildInvoiceCancelError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});

describe('task invoice-cancel-flow: commitInvoiceCancel（复用 service，不绕 route）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = {} as any;
    const r = await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    const tampered = { ...draft, idempotencyKey: 'invoice.cancel:INV__1:pd:bogus' };
    const prisma = {} as any;
    const r = await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('成功 commit（service ok）→ committed', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'a1' } });
    const prisma = {} as any;
    const r = await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.invoiceId).toBe('INV__1');
      expect(r.feedback.auditId).toBe('a1');
    }
    expect(cancelInvoice).toHaveBeenCalledTimes(1);
  });

  it('service 失败（INVOICE_NOT_FOUND）→ failed，不伪 committed', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: false, error: { code: 'INVOICE_NOT_FOUND', message: 'not found' } });
    const prisma = {} as any;
    const r = await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVOICE_NOT_FOUND');
  });

  it('service 失败（INVALID_STATUS）→ failed', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Cancelled' });
    (cancelInvoice as any).mockResolvedValue({ ok: false, error: { code: 'INVALID_STATUS', message: 'already cancelled' } });
    const prisma = {} as any;
    const r = await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_STATUS');
  });

  it('service 失败（CANCEL_FAILED）→ failed', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: false, error: { code: 'CANCEL_FAILED', message: 'sync reject' } });
    const prisma = {} as any;
    const r = await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('CANCEL_FAILED');
  });

  it('no route/service bypass：commit 只调 cancelInvoice，不直接 DB mutation', async () => {
    const draft = buildInvoiceCancelDraft({ invoiceId: 'INV__1', currentStatus: 'Issued' });
    (cancelInvoice as any).mockResolvedValue({ ok: true, data: { invoice: { id: 'INV__1' }, auditId: 'a1' } });
    const prisma = {} as any;
    await commitInvoiceCancel({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(cancelInvoice).toHaveBeenCalledTimes(1);
  });
});
