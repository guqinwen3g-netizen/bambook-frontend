import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAuthService } from '../../auth/service';
import { approvalReviewContentVersion } from '../../approvals/approvalReviewContent';
vi.mock('../../customerConfirmations/customerConfirmationService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, currentCustomerConfirmationActor: vi.fn(async (_tx: any, prior: any, requiredScope: string) => {
    if (!prior?.userId) throw Object.assign(new Error('missing actor'), { code: 'UNAUTHORIZED', statusCode: 401 });
    if (prior.permissionCeiling && !prior.permissionCeiling.includes('*') && !prior.permissionCeiling.includes(requiredScope))
      throw Object.assign(new Error('permission ceiling'), { code: 'FORBIDDEN', statusCode: 403 });
    return { ...prior, permissions: [...new Set([...(prior.permissions ?? []), requiredScope])], authorizationLoaded: true };
  }) };
});
vi.mock('../../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: vi.fn(async () => ({})) }));
import { createOrderChangeRouter } from '../orderChangeRoute';

/**
 * DR-010 订单变更路由契约测试：
 *   POST /            — 401/403/400/201
 *   GET /             — 401 + 列表过滤
 *   GET /:id          — 404/200
 *   POST /:id/apply   — 403 scope / 409 幂等 / 200
 *   POST /:id/withdraw— 403 非本人 / 409 非 Pending / 200
 */

// 可控 actor mock
let mockActor: { userId: string; roles: string[]; permissions?: string[] } | null = {
  userId: 'u_sales',
  roles: ['sales'],
  permissions: ['order:change_request:create', 'order:change_request:apply'],
};

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
  pickRequestToken: (req: any) => {
    const authHeader = req.headers?.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    const cookie = typeof req.cookies?.bambook_token === 'string' ? req.cookies.bambook_token : '';
    return bearer || cookie;
  },
}));

const VALID_REASON = '客户延迟确认产前样，需要调整订单内容';
const VALID_IMPACT = 'BOM 成本变化，回款延迟风险需评估';
const authHeader = () => {
  const token = createAuthService().signToken(mockActor as any);
  return { Authorization: `Bearer ${token}` };
};
const quantityPlan = (afterQuantity = '180') => ({ version: 1, orderId: 'ORD__1', expectedUpdatedAt: '0',
  lines: [{ lineId: 'OL_1', beforeQuantity: '200', unit: 'pcs', afterQuantity }] });

const baseCr = {
  id: 'OCR_1',
  orderId: 'ORD__1',
  requestNumber: 'OCR-20260816-001',
  status: 'Pending',
  changeTypes: ['quantity'],
  beforeSnapshot: { quantity: 200 },
  afterDelta: { quantity: 180 },
  changeReason: '客户延迟确认产前样，需要调整订单内容',
  requesterId: 'u_sales',
  reviewerId: 'u_supervisor',
  approvalRequestId: 'ar_1',
  appliedAt: null,
  appliedBy: null,
  deletedAt: null,
  notes: 'BOM 成本变化，回款延迟风险需评估',
  attachments: null,
};

const baseOrder = {
  id: 'ORD__1',
  status: 'Confirmed',
  deletedAt: null,
  customer: 'ABC 贸易',
  poNumber: 'PO-2026-001',
  updatedAt: BigInt(0), quantity: 200, unit: 'pcs', type: 'Garment', businessLine: 'garment',
  capsuleExemption: false,
  moqSnapshot: { fabricDefaultMoq: 100, garmentDefaultMoq: 100, capsuleMoq: 10,
    snapshotAt: '2026-01-01T00:00:00.000Z', configId: null, source: 'moq_config' },
};
const baseReadApproval = { id: 'ar_1', actionType: 'order:change', targetType: 'OrderChangeRequest', targetId: 'ORD__1',
  requesterId: 'u_sales', reviewerId: 'u_supervisor', status: 'pending', payload: {} };

function makeApp(opts: {
  changeRequest?: any;
  approvalRequest?: any;
  order?: any;
  failCreate?: boolean;
  failApply?: boolean;
  failWithdraw?: boolean;
} = {}) {
  const cr = opts.changeRequest ?? baseCr;
  const order = opts.order ?? baseOrder;

  const orderFindUnique = vi.fn(async ({ where, select }: any) => {
    if (where.id !== order.id) return null;
    if (!select || typeof select !== 'object') return order;
    return Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, order[key]]));
  });
  const crFindUnique = vi.fn(async ({ where }: any) =>
    where.id === cr?.id ? cr : null);
  const crCreate = vi.fn(async ({ data }: any) => ({ ...data, createdAt: new Date(), updatedAt: new Date() }));
  const crUpdate = vi.fn(async ({ where, data }: any) => ({ ...cr, ...data, id: where.id }));
  const orderUpdate = vi.fn(async ({ where, data }: any) => ({ ...order, ...data, id: where.id }));
  const transitionCreate = vi.fn(async () => ({}));
  const auditCreate = vi.fn(async () => ({ id: 'AL-1' }));
  const approvalCreate = vi.fn(async ({ data }: any) => ({
    ...data, id: 'ar_1', reviewerId: 'u_supervisor', status: 'pending',
  }));
  const approvalUpdateMany = vi.fn(async () => ({ count: 1 }));

  const prisma: any = {
    order: { findUnique: orderFindUnique, findFirst: vi.fn(async ({ where }: any) => {
      const id = where?.id ?? where?.AND?.find((part: any) => part?.id)?.id;
      return id === order.id ? order : null;
    }),
      update: orderUpdate, findMany: vi.fn(async () => [order]) },
    orderChangeRequest: {
      count: vi.fn(async () => 0),
      create: opts.failCreate ? vi.fn(async () => { throw new Error('DB_FAIL'); }) : crCreate,
      findUnique: crFindUnique,
      findUniqueOrThrow: vi.fn(async () => cr),
      findFirst: vi.fn(async () => null),
      update: crUpdate,
      findMany: vi.fn(async () => [cr]),
    },
    orderStatusTransition: { create: transitionCreate, findFirst: vi.fn(async () => null) },
    approvalRequest: {
      updateMany: approvalUpdateMany,
      findUnique: vi.fn(async ({ where }: any) => opts.approvalRequest?.id === where?.id ? opts.approvalRequest : null),
      create: approvalCreate,
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: auditCreate },
    // DR-007 审批路由解析（approvalRoutingService 真实实例走这些 mock）
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, status: 'active', deletedAt: null,
      primaryDeptId: 'dept_1', roles: [] })) },
    userPermissionOverrides: { findMany: vi.fn(async () => [{ scope: 'order:change_request:create' },
      { scope: 'order:change_request:apply' }, { scope: 'order:confirm' }, { scope: 'orders:read' }]) },
    department: { findUnique: vi.fn(async () => ({ id: 'dept_1', status: 'active', headId: 'u_supervisor', parentId: null })) },
    userRole: { findMany: vi.fn(async () => []) },
    purchaseOrder: { count: vi.fn(async () => 0) },
    developmentCase: { findMany: vi.fn(async () => []) },
    productionStage: { count: vi.fn(async () => 0) },
    invoice: { count: vi.fn(async () => 0) },
    paymentVoucher: { count: vi.fn(async () => 0) },
    creditLimit: { findFirst: vi.fn(async () => null) },
    preCutChecklist: { updateMany: vi.fn(async () => ({ count: 1 })) },
    orderLine: {
      findMany: vi.fn(async () => [{ id: 'OL_1', orderId: 'ORD__1', lineNumber: 1, quantity: '200', unit: 'pcs',
        unitPrice: null, netValue: null, moqOverride: null, confirmedSourceType: null, confirmedSourceId: null,
        specSnapshot: null }]),
      update: vi.fn(async () => ({})),
    },
    shipmentOrderAllocation: { findMany: vi.fn(async () => []) },
    shipment: { findMany: vi.fn(async () => []) },
    shipmentLine: { findMany: vi.fn(async () => []) },
    moqThresholdConfig: { findFirst: vi.fn(async () => null) },
    productAsset: { findMany: vi.fn(async () => []) },
    letterOfCredit: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/order-changes', createOrderChangeRouter({ prisma, requireAuth: true }));

  return { app, prisma, crCreate, orderUpdate, crUpdate, transitionCreate, approvalCreate, auditCreate };
}

beforeEach(() => {
  mockActor = {
    userId: 'u_sales',
    roles: ['sales'],
    permissions: ['order:change_request:create', 'order:change_request:apply'],
  };
});

describe('POST /api/v1/order-changes 创建', () => {
  it('无 JWT → 401（fail-closed）', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/order-changes')
      .send({ orderId: 'ORD__1', changeType: 'quantity', beforeSnapshot: { quantity: 200 }, afterDelta: { quantity: 180 }, changeReason: VALID_REASON, impactSummary: VALID_IMPACT });
    expect(res.status).toBe(401);
  });

  it('无 scope → 403 INSUFFICIENT_SCOPE（finance 角色无 order:change_request:create）', async () => {
    mockActor = { userId: 'u_fin', roles: ['finance'] };
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/order-changes')
      .send({ orderId: 'ORD__1', changeType: 'quantity', beforeSnapshot: { quantity: 200 },
        afterDelta: { quantity: 180, lineQuantityPlan: quantityPlan() }, changeReason: VALID_REASON, impactSummary: VALID_IMPACT });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('FORBIDDEN');
  });

  it('非法 changeType → 400 INVALID_CHANGE_TYPE', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/order-changes')
      .send({ orderId: 'ORD__1', changeType: 'bogus', beforeSnapshot: {}, afterDelta: {}, changeReason: VALID_REASON, impactSummary: VALID_IMPACT });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CHANGE_TYPE');
  });

  it('未批准订单（Pending）→ 400 ORDER_NOT_APPROVED（service 层校验透传）', async () => {
    const { app } = makeApp({ order: { ...baseOrder, status: 'Pending' } });
    const res = await request(app)
      .post('/api/v1/order-changes')
      .set(authHeader())
      .send({ orderId: 'ORD__1', changeType: 'quantity', beforeSnapshot: { quantity: 200 }, afterDelta: { quantity: 180 }, changeReason: VALID_REASON, impactSummary: VALID_IMPACT });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ORDER_NOT_APPROVED');
  });

  it('成功路径 → 201 + changeRequest + approvalRequestId', async () => {
    const { app, crCreate } = makeApp();
    const res = await request(app)
      .post('/api/v1/order-changes')
      .set(authHeader())
      .send({ orderId: 'ORD__1', changeType: 'quantity', beforeSnapshot: { quantity: 200 },
        afterDelta: { quantity: 180, lineQuantityPlan: quantityPlan() }, changeReason: VALID_REASON, impactSummary: VALID_IMPACT });
    expect(res.status).toBe(201);
    expect(res.body.changeRequest).toBeTruthy();
    expect(res.body.approvalRequestId).toBe('ar_1');
    expect(crCreate).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/order-changes 列表', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/order-changes');
    expect(res.status).toBe(401);
  });

  it('按 orderId 过滤 → 200 返回 items', async () => {
    const { app } = makeApp({ approvalRequest: baseReadApproval });
    const res = await request(app).get('/api/v1/order-changes?orderId=ORD__1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual(['OCR_1']);
  });
});

describe('GET /api/v1/order-changes/:id 详情', () => {
  it('变更申请不存在 → 404', async () => {
    const { app } = makeApp({ changeRequest: null });
    const res = await request(app).get('/api/v1/order-changes/OCR_MISSING');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('正常返回 → 200 + item + order + approvalRequest', async () => {
    const { app } = makeApp({ approvalRequest: baseReadApproval });
    const res = await request(app).get('/api/v1/order-changes/OCR_1');
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe('OCR_1');
    expect(res.body.item.order).toBeTruthy();
    expect(res.body.item.approvalRequest).toMatchObject({ id: 'ar_1', targetId: 'ORD__1' });
    expect(res.body.item.approvalRequest.payload).toBeUndefined();
  });
});

describe('POST /api/v1/order-changes/:id/amend-preview', () => {
  it('重读当前拟案并返回可签署指纹，但不创建审批或改写业务记录', async () => {
    mockActor = { userId: 'u_supervisor', roles: ['sales'], permissions: ['order:change_request:apply'] };
    const sourcePayload = { changeType: 'price', hitChangeTypes: ['unitPrice'],
      beforeSnapshot: { unitPrice: '100' }, afterDelta: { unitPrice: '90' },
      changeReason: '客户要求调整本订单拟变更金额', impactSummary: '同步复核合同金额与订单净额' };
    const source = { ...baseCr, status: 'Pending', changeTypes: ['unitPrice'], beforeSnapshot: sourcePayload.beforeSnapshot,
      afterDelta: sourcePayload.afterDelta, changeReason: sourcePayload.changeReason, notes: sourcePayload.impactSummary,
      requesterId: 'u_sales', reviewerId: 'u_supervisor', approvalRequestId: 'ar_old' };
    const approval = { id: 'ar_old', requesterId: 'u_sales', reviewerId: 'u_supervisor', status: 'pending',
      actionType: 'order:change', targetType: 'OrderChangeRequest', targetId: 'ORD__1', payload: sourcePayload };
    const { app, crCreate, crUpdate, orderUpdate, approvalCreate, auditCreate } = makeApp({ changeRequest: source, approvalRequest: approval });
    const res = await request(app).post('/api/v1/order-changes/OCR_1/amend-preview').set(authHeader()).send({
      reviewContentVersion: approvalReviewContentVersion(approval as any), afterDelta: { unitPrice: '95' },
      changeReason: '客户核对成本后要求调整最终拟变更金额', impactSummary: '合同金额与订单净额需同步复核',
    });
    expect(res.status).toBe(200);
    expect(res.body.finalProposalFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.proposal.displayDiff).toEqual([{ label: '订单金额', before: '0', after: '95', unit: null }]);
    expect(crCreate).not.toHaveBeenCalled();
    expect(crUpdate).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(approvalCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/order-changes/:id/apply', () => {
  it('无 scope order:change_request:apply → 403', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    const { app } = makeApp({ changeRequest: { ...baseCr, status: 'Approved' } });
    const res = await request(app).post('/api/v1/order-changes/OCR_1/apply').send({});
    expect(res.status).toBe(403);
  });

  it('重复 apply（幂等）→ 409 ALREADY_APPLIED', async () => {
    const { app } = makeApp({ changeRequest: { ...baseCr, status: 'Applied', appliedAt: new Date() } });
    const res = await request(app).post('/api/v1/order-changes/OCR_1/apply').set(authHeader()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_APPLIED');
  });

  it('旧数量申请缺少绑定后的冻结审批/客户确认依据时拒绝生效，订单不写入', async () => {
    const { app, orderUpdate } = makeApp({ changeRequest: { ...baseCr, status: 'Approved' } });
    const res = await request(app).post('/api/v1/order-changes/OCR_1/apply').set(authHeader()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ORDER_CHANGE_VERSION_MISMATCH');
    expect(orderUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/order-changes/:id/withdraw', () => {
  it('非申请人撤回 → 403 WITHDRAW_NOT_BY_REQUESTER', async () => {
    const { app } = makeApp({ changeRequest: baseCr });
    mockActor = { userId: 'u_other', roles: ['sales'] };
    const res = await request(app).post('/api/v1/order-changes/OCR_1/withdraw').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WITHDRAW_NOT_BY_REQUESTER');
  });

  it('非 Pending（已 Approved）→ 409 CHANGE_REQUEST_NOT_PENDING', async () => {
    const { app } = makeApp({ changeRequest: { ...baseCr, status: 'Approved' } });
    const res = await request(app).post('/api/v1/order-changes/OCR_1/withdraw').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CHANGE_REQUEST_NOT_PENDING');
  });

  it('成功撤回 → 200 + 订单恢复 Confirmed（时间线回查 fromStatus）', async () => {
    const { app, orderUpdate, transitionCreate } = makeApp({
      changeRequest: { ...baseCr, changeTypes: ['other'] }, // cancel 申请（无 attachments.pause → cancel）
      // ★ A10-①（拍板件 §2.3）：恢复回 `Confirmed` 现在要**先过确认门禁** ⇒
      //   订单 mock 必须带齐门禁读的字段（原先 `baseOrder` 没有 `quantity` ⇒
      //   `moqValidationService.ts:242` 判「必须为正数」抛错 ⇒ fail-closed 挡下恢复）。
      //   ★ 本用例走的是**兜底值**那条路：`orderStatusTransition.findFirst` 返回 null
      //     ⇒ 回查不到时间线 ⇒ `restoreStatus = 'Confirmed'`（硬编码兜底）。
      //     硬条件 2 给的两条路是「补门禁」或「改成显式失败」，实现取前者 ⇒ 门禁必须能跑通。
      order: {
        ...baseOrder, status: 'CancelRequested',
        type: 'Garment', businessLine: 'garment', quantity: 200, unit: 'pcs',
        capsuleExemption: false, quoteAmount: 10000,
        moqSnapshot: {
          fabricDefaultMoq: 100, garmentDefaultMoq: 100, capsuleMoq: 10,
          snapshotAt: '2026-01-01T00:00:00.000Z', configId: null, source: 'moq_config',
        },
      },
    });
    const res = await request(app).post('/api/v1/order-changes/OCR_1/withdraw').send({});
    expect(res.status).toBe(200);
    expect(orderUpdate).toHaveBeenCalledTimes(1);
    expect(orderUpdate.mock.calls[0][0].data.status).toBe('Confirmed');
    expect(transitionCreate).toHaveBeenCalledTimes(1);
  });
});
