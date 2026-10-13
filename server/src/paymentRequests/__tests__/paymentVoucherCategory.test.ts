import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createPaymentVoucher,
  updatePaymentVoucher,
  VALID_VOUCHER_CATEGORIES,
} from '../../finance/paymentVoucherMutationService';

/**
 * P0-9 / DR-022 voucherCategory 扩展测试（paymentVoucherMutationService）：
 *   create — 六类枚举写入 / 枚举外拒绝（INVALID_VOUCHER_CATEGORY，不进事务）
 *   patch  — 枚举内允许更新 / 枚举外拒绝
 */

function makePrisma() {
  const voucherCreate = vi.fn(async ({ data }: any) => ({ ...data, id: 'PAY__NEW' }));
  const voucherUpdate = vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data }));
  const voucherFindUnique = vi.fn(async () => ({
    id: 'PAY__1', status: 'unreconciled', amount: '100', appliedAmount: null, deletedAt: null,
  }));
  const prisma: any = {
    // Category edits and the approved supplier payment are unrelated to CN refunds.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    creditNoteRefundReturn: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRawUnsafe: vi.fn(async () => []), // Native receipt lock dependency; no refund or bank-return linkage.
    invoiceAllocation: { findMany: vi.fn().mockResolvedValue([]) }, // Category-only fixture has no posted allocation.
    paymentVoucher: { create: voucherCreate, update: voucherUpdate, findUnique: voucherFindUnique },
    // DR-017 门禁（DE-3）：Disbursement 必须关联 Approved PaymentRequest
    paymentRequest: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 'PAYR__OK' ? { id: 'PAYR__OK', status: 'Approved', deletedAt: null } : null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, voucherCreate, voucherUpdate };
}

const baseCreateInput = {
  type: 'Disbursement',
  amount: '100.0000',
  currency: 'CNY',
  paymentDate: '2026-08-16',
  paymentMethod: 'TT',
  paymentRequestId: 'PAYR__OK', // DR-017 先申请后付款门禁（DE-3）：Disbursement 必带已获批申请
};

beforeEach(() => vi.clearAllMocks());

describe('createPaymentVoucher voucherCategory', () => {
  it.each([...VALID_VOUCHER_CATEGORIES])('voucherCategory=%s 合法 → 写入落库', async (category) => {
    const { prisma, voucherCreate } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: { ...baseCreateInput, voucherCategory: category } });
    expect(res.ok).toBe(true);
    expect(voucherCreate).toHaveBeenCalledTimes(1);
    expect(voucherCreate.mock.calls[0][0].data.voucherCategory).toBe(category);
  });

  it('枚举外 voucherCategory → INVALID_VOUCHER_CATEGORY，不进事务', async () => {
    const { prisma, voucherCreate } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: { ...baseCreateInput, voucherCategory: 'bogus' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_VOUCHER_CATEGORY');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(voucherCreate).not.toHaveBeenCalled();
  });

  it('非字符串 voucherCategory → INVALID_VOUCHER_CATEGORY', async () => {
    const { prisma } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: { ...baseCreateInput, voucherCategory: 123 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_VOUCHER_CATEGORY');
  });

  it('未传 voucherCategory → 正常创建（schema default normal 兜底）', async () => {
    const { prisma, voucherCreate } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: baseCreateInput });
    expect(res.ok).toBe(true);
    expect(voucherCreate.mock.calls[0][0].data.voucherCategory).toBeUndefined();
  });
});

describe('updatePaymentVoucher voucherCategory', () => {
  it('枚举内 → PATCH 允许更新', async () => {
    const { prisma, voucherUpdate } = makePrisma();
    const res = await updatePaymentVoucher({
      prisma, voucherId: 'PAY__1', input: { voucherCategory: 'sample_express' },
    });
    expect(res.ok).toBe(true);
    expect(voucherUpdate.mock.calls[0][0].data.voucherCategory).toBe('sample_express');
  });

  it('枚举外 → INVALID_VOUCHER_CATEGORY，不更新', async () => {
    const { prisma, voucherUpdate } = makePrisma();
    const res = await updatePaymentVoucher({
      prisma, voucherId: 'PAY__1', input: { voucherCategory: 'bogus' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INVALID_VOUCHER_CATEGORY');
    expect(voucherUpdate).not.toHaveBeenCalled();
  });
});
