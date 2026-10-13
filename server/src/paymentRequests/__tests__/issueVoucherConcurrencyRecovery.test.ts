import { describe, expect, it, vi } from 'vitest';

vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn() }));
vi.mock('../../finance/paymentVoucherMutationService', () => ({
  createPaymentVoucher: vi.fn(),
  VALID_VOUCHER_CATEGORIES: ['normal'],
}));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { createPaymentRequestService } from '../paymentRequestService';
import { createPaymentVoucher } from '../../finance/paymentVoucherMutationService';
import { writeRouteAuditLog } from '../../audit/routeAudit';

const approved = {
  id: 'PAYR__CONCURRENT', requestNumber: 'PAYR-20261005-001', status: 'Approved',
  paymentVoucherId: null, paymentCategory: 'normal', totalAmount: '1000.0000', currency: 'CNY',
  expectedPaymentDate: null, supplierId: 'REL_SUP1', supplierName: 'Supplier', remark: null,
  deletedAt: null, approvalRequestId: 'AR__1',
};
const winnerRequest = { ...approved, status: 'VoucherIssued', paymentVoucherId: 'PAY__WINNER' };
const winnerVoucher = { id: 'PAY__WINNER', voucherNumber: 'PV-2026-0042', type: 'Disbursement' };

describe('DR-017 concurrent voucher issuance convergence', () => {
  it('when the transactional CAS loses, reads back and returns the winner idempotently', async () => {
    vi.mocked(createPaymentVoucher).mockResolvedValue({
      ok: false,
      error: { code: 'PAYMENT_REQUEST_ALREADY_LINKED', message: '付款申请已关联其他凭证，本次凭证创建已回滚；请刷新申请后重试。' },
    } as any);
    const findPaymentRequest = vi.fn()
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(winnerRequest);
    const prisma: any = {
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
      paymentRequest: { findUnique: findPaymentRequest },
      paymentVoucher: { findUnique: vi.fn().mockResolvedValue(winnerVoucher) },
    };

    const result = await createPaymentRequestService({ prisma } as any)
      .issueVoucherForApprovedRequest({ paymentRequestId: approved.id, actorId: 'u_finance' });

    expect(createPaymentVoucher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { paymentRequest: winnerRequest, voucher: winnerVoucher, idempotent: true } });
    expect(prisma.paymentVoucher.findUnique).toHaveBeenCalledWith({ where: { id: winnerVoucher.id } });
    expect(writeRouteAuditLog).not.toHaveBeenCalled();
  });
});
