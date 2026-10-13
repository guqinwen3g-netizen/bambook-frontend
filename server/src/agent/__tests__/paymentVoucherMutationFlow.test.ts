import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/routeAudit';
import {
  buildPaymentVoucherCreateDraft,
  commitPaymentVoucherCreate,
  buildPaymentVoucherUpdateDraft,
  commitPaymentVoucherUpdate,
  buildPaymentVoucherFlowError,
  type PaymentVoucherFlowErrorCode,
} from '../paymentVoucherMutationFlow';

vi.mock('../../finance/paymentVoucherMutationService', () => ({
  createPaymentVoucher: vi.fn(),
  updatePaymentVoucher: vi.fn(),
  VALID_PAYMENT_VOUCHER_STATUS: ['unreconciled', 'partially_reconciled', 'reconciled'],
  PAYMENT_VOUCHER_CREATE_FIELDS: ['voucherNumber','type','amount','currency','paymentDate','paymentMethod','status','bankFee','exchangeRate','baseCurrency','invoiceId','appliedAmount','orderId','customerRelationId','customerName','notes','attachments'],
  PAYMENT_VOUCHER_PATCH_FIELDS: ['type','amount','currency','paymentDate','paymentMethod','status','bankFee','exchangeRate','baseCurrency','invoiceId','appliedAmount','orderId','customerRelationId','customerName','notes','attachments'],
}));
import { createPaymentVoucher, updatePaymentVoucher } from '../../finance/paymentVoucherMutationService';

const createInput = { voucherNumber: 'PV-1', type: 'Receipt', amount: '100.0000', currency: 'USD', paymentDate: '2026-07-02', paymentMethod: 'TT' };

describe('paymentVoucherMutationFlow create/update draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create draft 含 ProcessDraft 六字段 + toolId/action', () => {
    const draft = buildPaymentVoucherCreateDraft({ input: createInput });
    expect(draft.subOperations[0].toolId).toBe('payment_voucher.create');
    expect(draft.subOperations[0].action).toBe('create_payment_voucher');
    expect(draft.beforeAfterDiff.length).toBeGreaterThan(0);
    expect(draft.impactScope).toEqual(['finance', 'entity-links', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('payment_voucher.create:PV-1:pd:');
  });

  it('create commit 成功复用 createPaymentVoucher service', async () => {
    const draft = buildPaymentVoucherCreateDraft({ input: createInput });
    (createPaymentVoucher as any).mockResolvedValue({ ok: true, data: { voucher: { id: 'PAY__1' }, auditId: 'AL-1' } });
    const r = await commitPaymentVoucherCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(createPaymentVoucher).toHaveBeenCalledWith(expect.objectContaining({ input: createInput, actorId: SYSTEM_AUDIT_ACTOR }));
  });

  it('create hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildPaymentVoucherCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...createInput, amount: '999.0000' } }] };
    const r = await commitPaymentVoucherCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(createPaymentVoucher).not.toHaveBeenCalled();
  });

  it('update draft 含 beforeAfterDiff + voucherId/patch', () => {
    const draft = buildPaymentVoucherUpdateDraft({ voucherId: 'PAY__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    expect(draft.subOperations[0].toolId).toBe('payment_voucher.update');
    expect((draft.subOperations[0].after as any).voucherId).toBe('PAY__1');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'paymentVoucher', entityId: 'PAY__1', field: 'amount', before: '100.0000', after: '120.0000' });
  });

  it('update commit 成功复用 updatePaymentVoucher service', async () => {
    const draft = buildPaymentVoucherUpdateDraft({ voucherId: 'PAY__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    (updatePaymentVoucher as any).mockResolvedValue({ ok: true, data: { voucher: { id: 'PAY__1' }, auditId: 'AL-2' } });
    const r = await commitPaymentVoucherUpdate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(updatePaymentVoucher).toHaveBeenCalledWith(expect.objectContaining({ voucherId: 'PAY__1', input: { amount: '120.0000' }, actorId: SYSTEM_AUDIT_ACTOR }));
  });

  it('update hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，updatePaymentVoucher 不被调', async () => {
    const draft = buildPaymentVoucherUpdateDraft({ voucherId: 'PAY__1', patch: { amount: '120.0000' }, currentSnapshot: { amount: '100.0000' } });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { voucherId: 'PAY__1', patch: { amount: '999.0000' } } }] };
    const r = await commitPaymentVoucherUpdate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(updatePaymentVoucher).not.toHaveBeenCalled();
  });

  it('update service INVALID_AMOUNT → failed', async () => {
    const draft = buildPaymentVoucherUpdateDraft({ voucherId: 'PAY__1', patch: { amount: 'bad' }, currentSnapshot: { amount: '100' } });
    (updatePaymentVoucher as any).mockResolvedValue({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'bad amount' } });
    const r = await commitPaymentVoucherUpdate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_AMOUNT');
  });

  it('所有 error code 有 userAction', () => {
    const codes: PaymentVoucherFlowErrorCode[] = ['APPROVAL_ID_MISSING','APPROVAL_NOT_FOUND','APPROVAL_MODIFIED_UNSUPPORTED','PROCESS_DRAFT_MISSING','PROCESS_DRAFT_HASH_MISMATCH','SEMANTIC_VALIDATION_FAILED','INVALID_STATUS','INVALID_AMOUNT','NOT_FOUND','CREATE_FAILED','UPDATE_FAILED'];
    for (const code of codes) expect(buildPaymentVoucherFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });
});
