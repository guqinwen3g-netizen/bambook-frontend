/**
 * disbursementPaymentRequestGate.test.ts — W-A 走查 P1-1（DE-3）回归
 *
 * 「先申请后付款」唯一通道：
 *   - POST /api/v1/finance/vouchers（及一切 createPaymentVoucher 调用方）Disbursement
 *     无 paymentRequestId / 申请未获批 → PAYMENT_REQUEST_REQUIRED（route 403，不进事务）
 *   - 关联 Approved 申请 → 放行 + attachments.paymentRequestId 落链 + 事务内 CAS 回写申请单
 *   - Receipt（收款）不受此限
 *   - 审批通过 → syncApprovalDecision 自动生成付款凭证（issueVoucherForApprovedRequest 闭环）
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createPaymentVoucher } from '../paymentVoucherMutationService';
import { createFinanceRouter } from '../route';
import { createPaymentRequestService } from '../../paymentRequests/paymentRequestService';
import { authHeader } from '../../__tests__/authTestHelper';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const APPROVED_PR = {
  id: 'PAYR__OK',
  requestNumber: 'PAYR-20260827-001',
  supplierId: 'REL_SUP1',
  supplierName: '供应商A',
  totalAmount: new Prisma.Decimal('1000.0000'),
  currency: 'CNY',
  expectedPaymentDate: null,
  paymentCategory: 'normal',
  status: 'Approved',
  approvalRequestId: 'ar_1',
  paymentVoucherId: null,
  remark: null,
  deletedAt: null,
};

function makePrisma(opts: { paymentRequest?: any } = {}) {
  const pr = 'paymentRequest' in opts ? opts.paymentRequest : APPROVED_PR;
  const voucherCreate = vi.fn(async ({ data }: any) => ({ ...data, id: 'PAY__NEW' }));
  const paymentRequestFindUnique = vi.fn(async ({ where }: any) => (where.id === pr?.id ? pr : null));
  const paymentRequestUpdateMany = vi.fn(async () => ({ count: 1 }));
  const prisma: any = {
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary supplier payment.
    paymentVoucher: { create: voucherCreate, findUnique: vi.fn(async () => null) },
    paymentRequest: {
      findUnique: paymentRequestFindUnique,
      updateMany: paymentRequestUpdateMany,
    },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, voucherCreate, paymentRequestUpdateMany, paymentRequestFindUnique };
}

const disbursementInput = {
  type: 'Disbursement',
  amount: '1000.0000',
  currency: 'CNY',
  paymentDate: '2026-08-27',
  paymentMethod: 'TT',
};

beforeEach(() => vi.clearAllMocks());

describe('P1-1（DE-3）Disbursement 直付门禁（service 层）', () => {
  it('Disbursement 无 paymentRequestId → PAYMENT_REQUEST_REQUIRED，不进事务', async () => {
    const { prisma, voucherCreate } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: disbursementInput });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(voucherCreate).not.toHaveBeenCalled();
  });

  it('Disbursement + 申请不存在 → PAYMENT_REQUEST_REQUIRED', async () => {
    const { prisma } = makePrisma({ paymentRequest: null });
    const res = await createPaymentVoucher({ prisma, input: { ...disbursementInput, paymentRequestId: 'PAYR__X' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Disbursement + 申请未获批（Pending）→ PAYMENT_REQUEST_REQUIRED', async () => {
    const { prisma } = makePrisma({ paymentRequest: { ...APPROVED_PR, status: 'Pending' } });
    const res = await createPaymentVoucher({ prisma, input: { ...disbursementInput, paymentRequestId: 'PAYR__OK' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
      expect(res.error.message).toContain('Pending');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Disbursement + Approved 申请 → 放行 + attachments.paymentRequestId 落链 + 事务内 CAS 回写申请单', async () => {
    const { prisma, voucherCreate, paymentRequestUpdateMany } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: { ...disbursementInput, paymentRequestId: 'PAYR__OK' } });
    expect(res.ok).toBe(true);
    expect(voucherCreate).toHaveBeenCalledTimes(1);
    const data = voucherCreate.mock.calls[0][0].data;
    expect(data.attachments.paymentRequestId).toBe('PAYR__OK');
    expect(paymentRequestUpdateMany).toHaveBeenCalledTimes(1);
    expect(paymentRequestUpdateMany.mock.calls[0][0].where).toEqual({ id: 'PAYR__OK', status: 'Approved', paymentVoucherId: null });
    expect(paymentRequestUpdateMany.mock.calls[0][0].data).toEqual({ paymentVoucherId: 'PAY__NEW', status: 'VoucherIssued' });
  });

  it('Disbursement + CAS 未占用成功 → 返回 409，不同步引用或写审计', async () => {
    const { prisma, paymentRequestUpdateMany } = makePrisma();
    paymentRequestUpdateMany.mockResolvedValue({ count: 0 });
    const res = await createPaymentVoucher({ prisma, input: { ...disbursementInput, paymentRequestId: 'PAYR__OK' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('PAYMENT_REQUEST_ALREADY_LINKED');
      expect(res.error.message).toContain('已回滚');
    }
    expect(prisma.paymentVoucher.create).toHaveBeenCalledTimes(1);
    expect(prisma.entityReference.upsert).not.toHaveBeenCalled();
    expect(prisma.entityLink.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('Receipt（收款）无申请 → 不受限，正常创建', async () => {
    const { prisma, voucherCreate } = makePrisma({ paymentRequest: null });
    const res = await createPaymentVoucher({ prisma, input: { ...disbursementInput, type: 'Receipt' } });
    expect(res.ok).toBe(true);
    expect(voucherCreate).toHaveBeenCalledTimes(1);
  });
});

describe('P1-1（DE-3）Disbursement 直付门禁（HTTP 契约）', () => {
  function makeApp(prisma: any) {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: false, apiKeys: new Set(), onDataChange: vi.fn() }));
    return app;
  }

  it('POST /api/v1/finance/vouchers Disbursement 无申请 → 403 PAYMENT_REQUEST_REQUIRED', async () => {
    const { prisma } = makePrisma();
    const res = await request(makeApp(prisma)).post('/api/v1/finance/vouchers').set(authHeader()).send(disbursementInput);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PAYMENT_REQUEST_REQUIRED');
  });

  it('POST /api/v1/finance/vouchers Disbursement + Approved 申请 → 201', async () => {
    const { prisma } = makePrisma();
    const res = await request(makeApp(prisma))
      .post('/api/v1/finance/vouchers')
      .set(authHeader())
      .send({ ...disbursementInput, paymentRequestId: 'PAYR__OK' });
    expect(res.status).toBe(201);
  });

  it('POST /api/v1/finance/vouchers CAS 未占用成功 → 409 且返回可识别冲突', async () => {
    const { prisma, paymentRequestUpdateMany } = makePrisma();
    paymentRequestUpdateMany.mockResolvedValue({ count: 0 });
    const res = await request(makeApp(prisma)).post('/api/v1/finance/vouchers').set(authHeader())
      .send({ ...disbursementInput, paymentRequestId: 'PAYR__OK' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_REQUEST_ALREADY_LINKED');
  });
});

describe('P1-1（DE-3）审批通过自动生成付款凭证（DR-017 闭环）', () => {
  it('syncApprovalDecision：审批 approved → Approved 回写 + 自动发凭证（状态 VoucherIssued + 凭证关联）', async () => {
    // 可变状态 mock：update 后 findUnique 反映新状态（模拟真实落库）
    const state: any = {
      pr: { ...APPROVED_PR, status: 'Pending', paymentVoucherId: null },
    };
    const voucherCreate = vi.fn(async ({ data }: any) => ({ ...data, id: 'PAY__NEW', voucherNumber: 'PV-2026-0001' }));
    const prisma: any = {
      creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Ordinary supplier-payment projection.
      paymentRequest: {
        findUnique: vi.fn(async ({ where }: any) => (where.id === state.pr.id ? state.pr : null)),
        update: vi.fn(async ({ data }: any) => {
          state.pr = { ...state.pr, ...data };
          return state.pr;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (state.pr.status === where.status && state.pr.paymentVoucherId === where.paymentVoucherId) {
            state.pr = { ...state.pr, ...data };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      paymentVoucher: {
        create: voucherCreate,
        findUnique: vi.fn(async () => null),
      },
      approvalRequest: {
        findUnique: vi.fn(async () => ({ id: 'ar_1', status: 'approved' })),
      },
      auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
      entityReference: { upsert: vi.fn(async () => ({})) },
      entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (fn: any) => fn(prisma)),
    };
    const svc = createPaymentRequestService({ prisma, approvalCreateService: { createBusinessApproval: vi.fn() } as any });
    const res = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__OK', actorId: 'u_head' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.synced).toBe(true);
      expect(res.data.voucher).toBeTruthy();
    }
    // 自动发凭证：Disbursement + paymentRequestId 关联
    expect(voucherCreate).toHaveBeenCalledTimes(1);
    const voucherData = voucherCreate.mock.calls[0][0].data;
    expect(voucherData.type).toBe('Disbursement');
    expect(voucherData.attachments.paymentRequestId).toBe('PAYR__OK');
    // 申请单闭环：VoucherIssued + paymentVoucherId
    expect(state.pr.status).toBe('VoucherIssued');
    expect(state.pr.paymentVoucherId).toBe('PAY__NEW');
  });
});
