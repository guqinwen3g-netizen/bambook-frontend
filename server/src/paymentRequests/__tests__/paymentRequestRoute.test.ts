import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createPaymentRequestRouter } from '../paymentRequestRoute';

/**
 * DR-017 付款申请路由契约测试：
 *   POST /            — 401/403/400/201
 *   GET /             — 401 + 状态/类别过滤
 *   GET /:id          — 404/200
 *   POST /:id/cancel  — 403 非本人 / 409 非 pending 前 / 200
 */

// 可控 actor mock
let mockActor: { userId: string; roles: string[]; permissions?: string[] } | null = {
  userId: 'u_sales',
  roles: ['sales'],
  permissions: ['finance:payment_request:create'],
};

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));

const basePr = {
  id: 'PAYR__1',
  requestNumber: 'PAYR-20260816-001',
  payeeType: 'Supplier',
  supplierId: 'REL_SUP1',
  supplierName: '供应商A',
  requestDate: '2026-08-16',
  expectedPaymentDate: null,
  totalAmount: '1000.0000',
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

function makeApp(opts: { paymentRequest?: any } = {}) {
  const pr = opts.hasOwnProperty('paymentRequest') ? opts.paymentRequest : basePr;
  const prCreate = vi.fn(async ({ data }: any) => ({ ...data, createdAt: new Date(), updatedAt: new Date() }));
  const prFindUnique = vi.fn(async ({ where }: any) => (where.id === pr?.id ? pr : null));
  const prUpdate = vi.fn(async ({ where, data }: any) => ({ ...pr, ...data, id: where.id }));
  const prFindMany = vi.fn(async () => (pr ? [pr] : []));

  const prisma: any = {
    paymentRequest: {
      count: vi.fn(async () => 0),
      create: prCreate,
      findUnique: prFindUnique,
      update: prUpdate,
      findMany: prFindMany,
    },
    paymentVoucher: { findUnique: vi.fn(async () => null) },
    creditNoteRefund: { findUnique: vi.fn(async () => null) }, // Ordinary Supplier PR, no actual refund FK.
    approvalRequest: {
      create: vi.fn(async ({ data }: any) => ({ ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    // DR-007 审批路由解析（approvalRoutingService 真实实例走这些 mock）
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, status: 'active', deletedAt: null, primaryDeptId: 'dept_1' })) },
    department: { findUnique: vi.fn(async () => ({ id: 'dept_1', status: 'active', headId: 'u_head', parentId: null })) },
    userRole: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma, requireAuth: true }));

  return { app, prisma, prCreate, prFindMany, prUpdate };
}

beforeEach(() => {
  mockActor = {
    userId: 'u_sales',
    roles: ['sales'],
    permissions: ['finance:payment_request:create'],
  };
});

describe('POST /api/v1/payment-requests 创建', () => {
  it('无 JWT → 401（fail-closed）', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/payment-requests')
      .send({ supplierName: '供应商A', totalAmount: '1000', currency: 'CNY' });
    expect(res.status).toBe(401);
  });

  it('无 scope → 403 INSUFFICIENT_SCOPE（无权限角色无 finance:payment_request:create）', async () => {
    mockActor = { userId: 'u_qc', roles: ['qc'] };
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/payment-requests')
      .send({ supplierName: '供应商A', totalAmount: '1000', currency: 'CNY' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('FORBIDDEN');
  });

  it('缺付款对象 → 400 MISSING_PAYEE', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/payment-requests')
      .send({ totalAmount: '1000', currency: 'CNY' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_PAYEE');
  });

  it('非法 paymentCategory → 400 INVALID_PAYMENT_CATEGORY', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/payment-requests')
      .send({ supplierName: '供应商A', totalAmount: '1000', currency: 'CNY', paymentCategory: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYMENT_CATEGORY');
  });

  it('成功路径 → 201 + paymentRequest + approvalRequestId（reviewerId 服务端解析）', async () => {
    const { app, prCreate, prisma } = makeApp();
    const res = await request(app)
      .post('/api/v1/payment-requests')
      .send({ supplierName: '供应商A', totalAmount: '1000', currency: 'CNY', reviewerId: 'u_evil' });
    expect(res.status).toBe(201);
    expect(res.body.paymentRequest).toBeTruthy();
    expect(res.body.approvalRequestId).toBeTruthy();
    expect(prCreate).toHaveBeenCalledTimes(1);
    // 前端越权传入 reviewerId=u_evil，落库值必须为服务端解析的部门主管 u_head
    expect(prCreate.mock.calls[0][0].data.reviewerId).toBe('u_head');
    const approvalData = prisma.approvalRequest.create.mock.calls[0][0].data;
    expect(approvalData.reviewerId).toBe('u_head');
    expect(approvalData.clientReviewerIdSupplied).toBe(true);
  });
});

describe('GET /api/v1/payment-requests 列表', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/payment-requests');
    expect(res.status).toBe(401);
  });

  it('按 status/paymentCategory 过滤 → 200 返回 items 且过滤条件透传', async () => {
    const { app, prFindMany } = makeApp();
    const res = await request(app).get('/api/v1/payment-requests?status=Pending&paymentCategory=business_cost');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(prFindMany).toHaveBeenCalledTimes(1);
    expect(prFindMany.mock.calls[0][0].where.status).toBe('Pending');
    expect(prFindMany.mock.calls[0][0].where.paymentCategory).toBe('business_cost');
  });

  it('search → where.OR 三字段（requestNumber/supplierName/remark）contains insensitive，count 同 where', async () => {
    const { app, prFindMany, prisma } = makeApp();
    const res = await request(app).get('/api/v1/payment-requests?search=供应商A');
    expect(res.status).toBe(200);
    const where = prFindMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(3);
    expect(where.OR[0].requestNumber).toEqual({ contains: '供应商A', mode: 'insensitive' });
    expect(where.OR[1].supplierName).toEqual({ contains: '供应商A', mode: 'insensitive' });
    expect(where.OR[2].remark).toEqual({ contains: '供应商A', mode: 'insensitive' });
    expect(prisma.paymentRequest.count).toHaveBeenCalledWith({ where });
  });

  it('search 空白串 → 不附加 OR 条件', async () => {
    const { app, prFindMany } = makeApp();
    const res = await request(app).get('/api/v1/payment-requests?search=%20%20');
    expect(res.status).toBe(200);
    expect(prFindMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it('响应携带 total（服务端全量计数，供前端截断披露）', async () => {
    const { app, prisma } = makeApp();
    prisma.paymentRequest.count.mockResolvedValue(7);
    const res = await request(app).get('/api/v1/payment-requests');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.items).toHaveLength(1);
  });

  it('limit 透传且封顶 500', async () => {
    const { app, prFindMany } = makeApp();
    await request(app).get('/api/v1/payment-requests?limit=5');
    expect(prFindMany.mock.calls[0][0].take).toBe(5);
    await request(app).get('/api/v1/payment-requests?limit=9999');
    expect(prFindMany.mock.calls[1][0].take).toBe(500);
  });
});

describe('GET /api/v1/payment-requests/:id 详情', () => {
  it('不存在 → 404 NOT_FOUND', async () => {
    const { app } = makeApp({ paymentRequest: null });
    const res = await request(app).get('/api/v1/payment-requests/PAYR__X');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('正常返回 → 200 + item', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1');
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe('PAYR__1');
  });
});

describe('POST /api/v1/payment-requests/:id/cancel', () => {
  it('非申请人作废 → 403 CANCEL_NOT_BY_APPLICANT', async () => {
    mockActor = { userId: 'u_other', roles: ['sales'] };
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/payment-requests/PAYR__1/cancel').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CANCEL_NOT_BY_APPLICANT');
  });

  it('非 pending 前（Approved）→ 409 PAYMENT_REQUEST_NOT_CANCELLABLE', async () => {
    const { app } = makeApp({ paymentRequest: { ...basePr, status: 'Approved' } });
    const res = await request(app).post('/api/v1/payment-requests/PAYR__1/cancel').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PAYMENT_REQUEST_NOT_CANCELLABLE');
  });

  it('不存在 → 404', async () => {
    const { app } = makeApp({ paymentRequest: null });
    const res = await request(app).post('/api/v1/payment-requests/PAYR__X/cancel').send({});
    expect(res.status).toBe(404);
  });

  it('申请人作废 Pending → 200 Cancelled', async () => {
    const { app, prUpdate } = makeApp();
    const res = await request(app).post('/api/v1/payment-requests/PAYR__1/cancel').send({});
    expect(res.status).toBe(200);
    expect(prUpdate.mock.calls[0][0].data.status).toBe('Cancelled');
  });
});
