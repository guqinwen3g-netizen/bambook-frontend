import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildInvoiceDeleteDraft,
  validateInvoiceDeleteDraftSemantics,
  verifyInvoiceDeleteDraftHash,
  commitInvoiceDelete,
  buildPaymentVoucherDeleteDraft,
  validatePaymentVoucherDeleteDraftSemantics,
  verifyPaymentVoucherDeleteDraftHash,
  commitPaymentVoucherDelete,
  buildFinanceSoftDeleteError,
  type FinanceSoftDeleteFlowErrorCode,
} from '../financeSoftDeleteFlow';

vi.mock('../../finance/voidDeleteService', () => ({
  deleteInvoice: vi.fn(),
  deleteVoucher: vi.fn(),
}));
import { deleteInvoice, deleteVoucher } from '../../finance/voidDeleteService';

describe('task finance-soft-delete-flow: buildInvoiceDeleteDraft', () => {
  it('生成含 invoiceId 的 ProcessDraft（deletedAt null→true，impactScope 含 finance/entity-links/audit）', () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    expect(draft.subOperations[0].toolId).toBe('invoice.delete');
    expect((draft.subOperations[0].after as any).invoiceId).toBe('INV__1');
    expect(draft.beforeAfterDiff[0].field).toBe('deletedAt');
    expect(draft.beforeAfterDiff[0].before).toBeNull();
    expect(draft.beforeAfterDiff[0].after).toBe(true);
    expect(draft.impactScope).toEqual(['finance', 'entity-links', 'audit']);
  });
});

describe('task finance-soft-delete-flow: invoice.delete hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    expect(verifyInvoiceDeleteDraftHash(draft).ok).toBe(true);
  });
  it('篡改 invoiceId → hash 不匹配', () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { invoiceId: 'HACKED' } }] };
    expect(verifyInvoiceDeleteDraftHash(tampered).ok).toBe(false);
  });
});

describe('task finance-soft-delete-flow: commitInvoiceDelete（复用 service）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitInvoiceDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('成功 commit → committed', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const r = await commitInvoiceDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(deleteInvoice).toHaveBeenCalledTimes(1);
  });

  it('service 失败（HAS_ALLOCATIONS）→ failed', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: false, error: { code: 'HAS_ALLOCATIONS', message: 'has allocations' } });
    const r = await commitInvoiceDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('HAS_ALLOCATIONS');
  });

  it('service 失败（INVOICE_NOT_FOUND）→ failed', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: false, error: { code: 'INVOICE_NOT_FOUND', message: 'not found' } });
    const r = await commitInvoiceDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVOICE_NOT_FOUND');
  });

  it('no service bypass：只调 deleteInvoice', async () => {
    const draft = buildInvoiceDeleteDraft({ invoiceId: 'INV__1' });
    (deleteInvoice as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    await commitInvoiceDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(deleteInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('task finance-soft-delete-flow: buildPaymentVoucherDeleteDraft', () => {
  it('生成含 voucherId 的 ProcessDraft', () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    expect(draft.subOperations[0].toolId).toBe('payment_voucher.delete');
    expect((draft.subOperations[0].after as any).voucherId).toBe('PV__1');
    expect(draft.beforeAfterDiff[0].field).toBe('deletedAt');
    expect(draft.impactScope).toEqual(['finance', 'entity-links', 'audit']);
  });
});

describe('task finance-soft-delete-flow: voucher.delete hash 防篡改', () => {
  it('篡改 voucherId → hash 不匹配', () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { voucherId: 'HACKED' } }] };
    expect(verifyPaymentVoucherDeleteDraftHash(tampered).ok).toBe(false);
  });
});

describe('task finance-soft-delete-flow: commitPaymentVoucherDelete（复用 service）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('成功 commit → committed', async () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    (deleteVoucher as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    const r = await commitPaymentVoucherDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(deleteVoucher).toHaveBeenCalledTimes(1);
  });

  it('service 失败（VOUCHER_NOT_FOUND）→ failed', async () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    (deleteVoucher as any).mockResolvedValue({ ok: false, error: { code: 'VOUCHER_NOT_FOUND', message: 'not found' } });
    const r = await commitPaymentVoucherDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('VOUCHER_NOT_FOUND');
  });

  it('no service bypass：只调 deleteVoucher', async () => {
    const draft = buildPaymentVoucherDeleteDraft({ voucherId: 'PV__1' });
    (deleteVoucher as any).mockResolvedValue({ ok: true, data: { auditId: 'a1' } });
    await commitPaymentVoucherDelete({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(deleteVoucher).toHaveBeenCalledTimes(1);
  });
});

describe('task finance-soft-delete-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: FinanceSoftDeleteFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'INVOICE_NOT_FOUND', 'VOUCHER_NOT_FOUND', 'INVALID_STATUS', 'HAS_ALLOCATIONS', 'CANCEL_FAILED', 'DELETE_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildFinanceSoftDeleteError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});
