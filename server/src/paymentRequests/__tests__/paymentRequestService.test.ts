import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  createPaymentRequestService,
  PAYMENT_REQUEST_ERRORS,
} from '../paymentRequestService';
import { createApprovalRoutingService } from '../../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../../approvals/approvalCreateService';

/**
 * DR-017 付款申请服务测试：
 *   createPaymentRequest        — 必填校验 / paymentCategory 枚举 / 审批链 DR-007
 *   issueVoucherForApprovedRequest — 未批准拒生成 / 批准后生成 / 幂等防重复
 *   cancelPaymentRequest        — 状态机守卫 / 仅申请人本人
 *   syncApprovalDecision        — 审批决定回写
 */

const baseRequest = {
  id: 'PAYR__1',
  requestNumber: 'PAYR-20260816-001',
  supplierId: 'REL_SUP1',
  supplierName: '供应商A',
  requestDate: '2026-08-16',
  expectedPaymentDate: null,
  totalAmount: new Prisma.Decimal('1000.0000'),
  currency: 'CNY',
  applicantId: 'u_sales',
  reviewerId: 'u_head',
  status: 'Pending',
  approvalRequestId: 'ar_1',
  paymentVoucherId: null,
  paymentCategory: 'normal',
  ownerId: 'u_sales',
  departmentId: null,
  remark: null,
  attachments: null,
  deletedAt: null,
};

function makePrisma(opts: { paymentRequest?: any; approvalStatus?: string } = {}) {
  const pr = opts.hasOwnProperty('paymentRequest') ? opts.paymentRequest : baseRequest;
  const paymentRequestCreate = vi.fn(async ({ data }: any) => ({ ...data, createdAt: new Date(), updatedAt: new Date() }));
  const paymentRequestUpdate = vi.fn(async ({ where, data }: any) => ({ ...pr, ...data, id: where.id }));
  const paymentRequestUpdateMany = vi.fn(async () => ({ count: 1 }));
  const paymentRequestFindUnique = vi.fn(async ({ where }: any) => (where.id === pr?.id ? pr : null));
  const paymentVoucherCreate = vi.fn(async ({ data }: any) => ({ ...data, id: 'PAY__NEW' }));
  const auditCreate = vi.fn(async () => ({ id: 'AL-1' }));
  const notificationCreate = vi.fn(async ({ data }: any) => ({ ...data, createdAt: new Date() }));

  const prisma: any = {
    // Ordinary supplier payments in this fixture have no CN cash-refund source.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    paymentRequest: {
      count: vi.fn(async () => 0),
      create: paymentRequestCreate,
      findUnique: paymentRequestFindUnique,
      update: paymentRequestUpdate,
      updateMany: paymentRequestUpdateMany,
      findMany: vi.fn(async () => (pr ? [pr] : [])),
    },
    paymentVoucher: {
      create: paymentVoucherCreate,
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 'PAY__EXISTING'
          ? { id: 'PAY__EXISTING', voucherNumber: 'PV-2026-0001', type: 'Disbursement', status: 'unreconciled' }
          : null),
    },
    approvalRequest: {
      create: vi.fn(async ({ data }: any) => ({ ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async () =>
        opts.approvalStatus ? { id: 'ar_1', status: opts.approvalStatus } : null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: auditCreate },
    // §10.3-11 通知中心：sendToUser 落库 + 静音偏好查询
    notification: { create: notificationCreate },
    notificationPreference: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    // DR-007 审批路由解析（真实 routingService 走这些 mock）
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, primaryDeptId: 'dept_1' })) },
    department: { findUnique: vi.fn(async () => ({ id: 'dept_1', status: 'active', headId: 'u_head', parentId: null })) },
    userRole: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return {
    prisma,
    paymentRequestCreate,
    paymentRequestUpdate,
    paymentRequestUpdateMany,
    paymentRequestFindUnique,
    paymentVoucherCreate,
    auditCreate,
    notificationCreate,
  };
}

function makeStubApprovalService() {
  return {
    createBusinessApproval: vi.fn(async () => ({ id: 'ar_1', reviewerId: 'u_head', status: 'pending' })),
  } as any;
}

const validInput = {
  supplierId: 'REL_SUP1',
  supplierName: '供应商A',
  totalAmount: '1000.0000',
  currency: 'CNY',
  applicantId: 'u_sales',
};

beforeEach(() => vi.clearAllMocks());

describe('createPaymentRequest 必填校验', () => {
  it('缺付款对象（supplierId/supplierName 均空）→ 400 MISSING_PAYEE', async () => {
    const { prisma } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.createPaymentRequest({ ...validInput, supplierId: undefined, supplierName: undefined });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.MISSING_PAYEE);
      expect(res.error.statusCode).toBe(400);
    }
  });

  it('金额非法 → 400 INVALID_AMOUNT；金额 ≤ 0 → 400', async () => {
    const { prisma } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const bad = await svc.createPaymentRequest({ ...validInput, totalAmount: 'abc' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe(PAYMENT_REQUEST_ERRORS.INVALID_AMOUNT);
    const zero = await svc.createPaymentRequest({ ...validInput, totalAmount: '0' });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.code).toBe(PAYMENT_REQUEST_ERRORS.INVALID_AMOUNT);
  });

  it('缺币种 → 400 MISSING_CURRENCY', async () => {
    const { prisma } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.createPaymentRequest({ ...validInput, currency: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.MISSING_CURRENCY);
  });

  it('paymentCategory 枚举外 → 400 INVALID_PAYMENT_CATEGORY（三类费用枚举 fail-closed）', async () => {
    const { prisma, paymentRequestCreate } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.createPaymentRequest({ ...validInput, paymentCategory: 'bogus' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.INVALID_PAYMENT_CATEGORY);
    expect(paymentRequestCreate).not.toHaveBeenCalled();
  });

  it.each(['normal', 'advance', 'deposit', 'sample_express', 'customer_reimburse', 'business_cost'])(
    'paymentCategory=%s 合法 → 创建成功并落库',
    async (category) => {
      const { prisma, paymentRequestCreate } = makePrisma();
      const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
      const res = await svc.createPaymentRequest({ ...validInput, paymentCategory: category });
      expect(res.ok).toBe(true);
      expect(paymentRequestCreate).toHaveBeenCalledTimes(1);
      expect(paymentRequestCreate.mock.calls[0][0].data.paymentCategory).toBe(category);
    },
  );

  it('成功路径 → status=Pending + approvalRequestId + reviewerId 来自审批服务 + sourceDocument 入 attachments', async () => {
    const { prisma, paymentRequestCreate } = makePrisma();
    const approvalCreateService = makeStubApprovalService();
    const svc = createPaymentRequestService({ prisma, approvalCreateService });
    const res = await svc.createPaymentRequest({
      ...validInput,
      sourceType: 'purchase_order',
      sourceId: 'PO__1',
      remark: '8 月面料货款',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.approvalRequestId).toBe('ar_1');
      expect(res.data.paymentRequest.status).toBe('Pending');
    }
    const data = paymentRequestCreate.mock.calls[0][0].data;
    expect(data.reviewerId).toBe('u_head'); // 服务端解析值，非前端传入
    expect(data.status).toBe('Pending');
    expect(data.attachments.sourceDocument).toEqual({ type: 'purchase_order', id: 'PO__1' });
    expect(approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    const approvalInput = approvalCreateService.createBusinessApproval.mock.calls[0][0];
    expect(approvalInput.actionType).toBe('finance:payment_request');
    expect(approvalInput.targetType).toBe('PaymentRequest');
  });

  it('NO_REVIEWER_RESOLVED → 409 透传（fail-closed，不允许 reviewerId=null 落库）', async () => {
    const { prisma, paymentRequestCreate } = makePrisma();
    const approvalCreateService = {
      createBusinessApproval: vi.fn(async () => {
        throw Object.assign(new Error('NO_REVIEWER_RESOLVED: 无候选'), { code: 'NO_REVIEWER_RESOLVED' });
      }),
    } as any;
    const svc = createPaymentRequestService({ prisma, approvalCreateService });
    const res = await svc.createPaymentRequest(validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NO_REVIEWER_RESOLVED');
      expect(res.error.statusCode).toBe(409);
    }
    expect(paymentRequestCreate).not.toHaveBeenCalled();
  });

  it('reviewerId 服务端 DR-007 解析：前端传入 reviewerId 被忽略并审计（真实 routing+create 服务链）', async () => {
    const { prisma, paymentRequestCreate, auditCreate } = makePrisma();
    const routingService = createApprovalRoutingService({ prisma });
    const approvalCreateService = createApprovalCreateService({ prisma, routingService });
    const svc = createPaymentRequestService({ prisma, approvalCreateService });
    const res = await svc.createPaymentRequest({
      ...validInput,
      clientSuppliedReviewerId: 'u_evil', // 越权注入尝试
    });
    expect(res.ok).toBe(true);
    // 审批单 reviewerId = 部门主管 u_head（DEPT_HEAD 路由），绝不用前端 u_evil
    const approvalData = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(approvalData.reviewerId).toBe('u_head');
    expect(approvalData.reviewerResolverRoute).toBe('DEPT_HEAD');
    expect(approvalData.clientReviewerIdSupplied).toBe(true);
    // 忽略尝试已写审计
    const ignoreAudit = auditCreate.mock.calls.find((c: any) =>
      c[0]?.data?.action === 'APPROVAL_CLIENT_REVIEWERID_IGNORED_ATTEMPT');
    expect(ignoreAudit).toBeTruthy();
    // PaymentRequest.reviewerId 同为服务端解析值
    expect(paymentRequestCreate.mock.calls[0][0].data.reviewerId).toBe('u_head');
  });
});

describe('issueVoucherForApprovedRequest 凭证生成（DR-017）', () => {
  it('未批准（Pending）→ 409 PAYMENT_REQUEST_NOT_APPROVED，不创建凭证', async () => {
    const { prisma, paymentVoucherCreate } = makePrisma({ paymentRequest: { ...baseRequest, status: 'Pending' } });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.issueVoucherForApprovedRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_finance' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_APPROVED);
      expect(res.error.statusCode).toBe(409);
    }
    expect(paymentVoucherCreate).not.toHaveBeenCalled();
  });

  it('申请不存在 → 404 PAYMENT_REQUEST_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ paymentRequest: null });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.issueVoucherForApprovedRequest({ paymentRequestId: 'PAYR__X', actorId: 'u_finance' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.statusCode).toBe(404);
  });

  it('Approved → 生成 Disbursement 凭证（voucherCategory 透传）+ 状态 VoucherIssued + 关联写回', async () => {
    const { prisma, paymentVoucherCreate, paymentRequestUpdateMany } = makePrisma({
      paymentRequest: { ...baseRequest, status: 'Approved', paymentCategory: 'business_cost' },
    });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.issueVoucherForApprovedRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_finance' });
    expect(res.ok).toBe(true);
    expect(paymentVoucherCreate).toHaveBeenCalledTimes(1);
    const voucherData = paymentVoucherCreate.mock.calls[0][0].data;
    expect(voucherData.type).toBe('Disbursement');
    expect(voucherData.voucherCategory).toBe('business_cost'); // 付款性质一并写入凭证
    expect(voucherData.currency).toBe('CNY');
    expect(voucherData.amount).toBeInstanceOf(Prisma.Decimal);
    expect(new Prisma.Decimal('1000.0000').eq(voucherData.amount)).toBe(true);
    expect(voucherData.customerRelationId).toBe('REL_SUP1');
    expect(paymentRequestUpdateMany).toHaveBeenCalledTimes(1);
    expect(paymentRequestUpdateMany.mock.calls[0][0].data.status).toBe('VoucherIssued');
    expect(paymentRequestUpdateMany.mock.calls[0][0].data.paymentVoucherId).toBe('PAY__NEW');
    if (res.ok) expect(res.data.idempotent).toBe(false);
  });

  it('幂等：已关联凭证 → 直接返回既有凭证，不重复生成', async () => {
    const { prisma, paymentVoucherCreate, paymentRequestUpdateMany } = makePrisma({
      paymentRequest: { ...baseRequest, status: 'VoucherIssued', paymentVoucherId: 'PAY__EXISTING' },
    });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.issueVoucherForApprovedRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_finance' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.idempotent).toBe(true);
      expect(res.data.voucher.id).toBe('PAY__EXISTING');
    }
    expect(paymentVoucherCreate).not.toHaveBeenCalled();
    expect(paymentRequestUpdateMany).not.toHaveBeenCalled();
  });
});

describe('syncApprovalDecision 审批决定回写', () => {
  it('审批 approved → PaymentRequest Approved', async () => {
    const { prisma, paymentRequestUpdate } = makePrisma({ approvalStatus: 'approved' });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__1', actorId: 'u_head' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.synced).toBe(true);
    expect(paymentRequestUpdate.mock.calls[0][0].data.status).toBe('Approved');
  });

  it('审批 rejected → PaymentRequest Rejected', async () => {
    const { prisma, paymentRequestUpdate } = makePrisma({ approvalStatus: 'rejected' });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__1', actorId: 'u_head' });
    expect(res.ok).toBe(true);
    expect(paymentRequestUpdate.mock.calls[0][0].data.status).toBe('Rejected');
  });

  it('审批仍 pending → 无操作（synced=false，不写库）', async () => {
    const { prisma, paymentRequestUpdate } = makePrisma({ approvalStatus: 'pending' });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__1', actorId: 'u_head' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.synced).toBe(false);
    expect(paymentRequestUpdate).not.toHaveBeenCalled();
  });
});

describe('cancelPaymentRequest 状态机守卫', () => {
  it('Approved → 409 PAYMENT_REQUEST_NOT_CANCELLABLE（仅 pending 前可作废）', async () => {
    const { prisma } = makePrisma({ paymentRequest: { ...baseRequest, status: 'Approved' } });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.cancelPaymentRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_sales' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.PAYMENT_REQUEST_NOT_CANCELLABLE);
      expect(res.error.statusCode).toBe(409);
    }
  });

  it('非申请人 → 403 CANCEL_NOT_BY_APPLICANT', async () => {
    const { prisma } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.cancelPaymentRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_other' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.CANCEL_NOT_BY_APPLICANT);
      expect(res.error.statusCode).toBe(403);
    }
  });

  it('申请人作废 Pending → 200 Cancelled + 关联审批单一并撤回', async () => {
    const { prisma, paymentRequestUpdate } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.cancelPaymentRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_sales' });
    expect(res.ok).toBe(true);
    expect(paymentRequestUpdate.mock.calls[0][0].data.status).toBe('Cancelled');
    expect(prisma.approvalRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.approvalRequest.updateMany.mock.calls[0][0].data.status).toBe('cancelled');
  });

  it('申请不存在 → 404', async () => {
    const { prisma } = makePrisma({ paymentRequest: null });
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });
    const res = await svc.cancelPaymentRequest({ paymentRequestId: 'PAYR__X', actorId: 'u_sales' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.statusCode).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
// §10.3-11 通知中心接线：付款申请提交 → 单播审批人（不是广播，避免全员噪声）
// ══════════════════════════════════════════════════════════════════
describe('createPaymentRequest · 通知接线（§10.3-11）', () => {
  it('提交成功后通知审批人（含单号/金额/跳转链接），且不广播', async () => {
    const { prisma, notificationCreate } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: makeStubApprovalService() });

    const r = await svc.createPaymentRequest(validInput as any);
    expect(r.ok).toBe(true);

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    const data = notificationCreate.mock.calls[0][0].data;
    expect(data.userId).toBe('u_head');              // 审批人（单播）
    expect(data.type).toBe('payment_request_submitted');
    expect(data.link).toBe('/finance?tab=paymentRequests');
    expect(String(data.body)).toContain('1000');
    expect(data.metadata.paymentRequestId).toBeTruthy();
  });

  it('审批人解析不出来时静默跳过，不阻断申请创建', async () => {
    const { prisma, notificationCreate } = makePrisma();
    const svc = createPaymentRequestService({
      prisma,
      approvalCreateService: { createBusinessApproval: vi.fn(async () => ({ id: 'ar_1', status: 'pending' })) } as any,
    });

    const r = await svc.createPaymentRequest(validInput as any);
    expect(r.ok).toBe(true);
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});
