import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createExceptionRouter } from '../exceptionRoute';
import { EXCEPTION_STATUS } from '../exceptionService';

/**
 * DR-013 受控例外路由契约测试：
 *   POST /               — 401/403/400/201 + DR-007 服务端解析 reviewerId（前端传入忽略）
 *   GET  /               — 401 + 状态/类别过滤
 *   GET  /gate-check     — 400 缺参 / 200 active / 200 inactive
 *   GET  /:id            — 404/200
 *   POST /:id/withdraw   — 403 非本人 / 409 非 Pending / 200
 *   POST /:id/boss-bypass— 403 非 owner / 400 reason 过短 / 200 双模型写入
 */

// 可控 actor mock
let mockActor: { userId: string; roles: string[]; permissions?: string[] } | null = {
  userId: 'u_sales',
  roles: ['sales'],
  permissions: ['exception:dr013:create'],
};

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));

const VALID_REASON = 'S/S客户10天未回复且临近ETD仅2天，客户电话承诺今日内邮件确认放行';
const VALID_RISK = '如客户最终拒绝确认，我方承担退运费用并给予下次订单5%折扣';
const BOSS_REASON = '客户为美国Top5买家且承诺明年三倍订单量及5%单价补偿，综合评估特批放行';

const baseScope = {
  targetType: 'Shipment', targetId: 'SHIP_003', action: 'shipment:release',
  validUntil: null, maxUses: 1, usedCount: 0, consumptions: [], responsibleOwnerId: 'u_sales',
};

const baseExc = {
  id: 'EXC__1',
  exceptionNumber: 'EXC-20260816-001',
  exceptionCategory: 'shipment_release',
  subCategory: 'without_ss_confirmed',
  bypassedApprovalIds: [],
  exceptionReason: VALID_REASON,
  customerCommitment: null,
  riskMitigationPlan: VALID_RISK,
  requesterId: 'u_sales',
  reviewerId: 'u_supervisor',
  approvalRequestId: 'ar_1',
  status: EXCEPTION_STATUS.PENDING,
  bossFinalBypassBy: null,
  bossFinalBypassAt: null,
  bossFinalBypassReason: null,
  notes: null,
  attachments: { files: [], scope: baseScope },
  createdAt: new Date('2026-08-16T00:00:00Z'),
  updatedAt: new Date('2026-08-16T00:00:00Z'),
  deletedAt: null,
};

const validBody = {
  exceptionCategory: 'shipment_release',
  subCategory: 'without_ss_confirmed',
  exceptionReason: VALID_REASON,
  riskMitigationPlan: VALID_RISK,
  targetType: 'Shipment',
  targetId: 'SHIP_003',
  action: 'shipment:release',
  responsibleOwnerId: 'u_sales',
};

function makeApp(opts: {
  exc?: any;
  exceptions?: any[];
  approval?: any;
} = {}) {
  const state = { stored: opts.exc === undefined ? baseExc : opts.exc };
  const calls = {
    excCreate: vi.fn(async ({ data }: any) => ({ ...data, createdAt: new Date(), updatedAt: new Date() })),
    excUpdate: vi.fn(async ({ where, data }: any) => {
      state.stored = { ...state.stored, ...data, id: where.id };
      return state.stored;
    }),
    approvalCreate: vi.fn(async ({ data }: any) => ({ ...data })),
    approvalUpdate: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    approvalUpdateMany: vi.fn(async () => ({ count: 1 })),
    auditCreate: vi.fn(async ({ data }: any) => ({ id: 'AL_1', ...data })),
  };

  const prisma: any = {
    dr013ExceptionRequest: {
      count: vi.fn(async () => 0),
      create: calls.excCreate,
      findUnique: vi.fn(async ({ where }: any) => (state.stored && state.stored.id === where.id ? state.stored : null)),
      findMany: vi.fn(async () => opts.exceptions ?? (state.stored ? [state.stored] : [])),
      update: calls.excUpdate,
    },
    approvalRequest: {
      create: calls.approvalCreate,
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async ({ where }: any) => (opts.approval && opts.approval.id === where.id ? opts.approval : null)),
      findMany: vi.fn(async () => []),
      update: calls.approvalUpdate,
      updateMany: calls.approvalUpdateMany,
    },
    auditLog: { create: calls.auditCreate },
    // DR-007 审批路由解析（真实 approvalRoutingService + approvalCreateService 走这些 mock）
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, primaryDeptId: 'dept_1' })) },
    department: { findUnique: vi.fn(async () => ({ id: 'dept_1', status: 'active', headId: 'u_supervisor', parentId: null })) },
    userRole: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/exceptions', createExceptionRouter({ prisma, requireAuth: true }));
  return { app, prisma, calls, state };
}

beforeEach(() => {
  mockActor = { userId: 'u_sales', roles: ['sales'], permissions: ['exception:dr013:create'] };
});

// ══════════════════════════════════════════════════════════════════
describe('POST /api/v1/exceptions 创建', () => {
  it('无 JWT → 401（fail-closed）', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send(validBody);
    expect(res.status).toBe(401);
  });

  it('无 scope → 403 FORBIDDEN（QC 容器无 exception:dr013:create，DR013-C2）', async () => {
    mockActor = { userId: 'u_qc', roles: ['qc'] };
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('INSUFFICIENT_SCOPE');
  });

  it('非法 exceptionCategory → 400 INVALID_EXCEPTION_CATEGORY', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send({ ...validBody, exceptionCategory: 'force_bypass' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_EXCEPTION_CATEGORY');
  });

  it('缺必填字段 → 400 MISSING_MANDATORY_EXCEPTION_FIELDS（DR013-C3）', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send({ exceptionCategory: 'shipment_release' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_MANDATORY_EXCEPTION_FIELDS');
  });

  it('reason ≤29 字 → 400 EXCEPTION_REASON_TOO_SHORT', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send({ ...validBody, exceptionReason: '客户要' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EXCEPTION_REASON_TOO_SHORT');
  });

  it('合法创建 → 201 + reviewerId 服务端 DR-007 解析（u_supervisor=部门 head）+ approvalRequestId 回写', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.approvalRequestId).toBeTruthy();

    // 审批单：actionType=order:dr013-exception，reviewerId=组织归属解析（非前端传入）
    const approvalData = calls.approvalCreate.mock.calls[0][0].data;
    expect(approvalData.actionType).toBe('order:dr013-exception');
    expect(approvalData.reviewerId).toBe('u_supervisor');
    expect(approvalData.reviewerResolverRoute).toBe('DEPT_HEAD');
    expect(approvalData.clientReviewerIdSupplied).toBe(false);

    // EXC：reviewerId 回写 + status=Pending
    const excData = calls.excCreate.mock.calls[0][0].data;
    expect(excData.reviewerId).toBe('u_supervisor');
    expect(excData.status).toBe(EXCEPTION_STATUS.PENDING);
  });

  it('前端越权传 reviewerId → 忽略 + clientReviewerIdSupplied=true + 越权审计（DEV-11-B4）', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/v1/exceptions').send({ ...validBody, reviewerId: 'u_hacker' });
    expect(res.status).toBe(201);
    const approvalData = calls.approvalCreate.mock.calls[0][0].data;
    expect(approvalData.reviewerId).toBe('u_supervisor'); // 绝不使用前端值
    expect(approvalData.clientReviewerIdSupplied).toBe(true);
    const audit = calls.auditCreate.mock.calls.find((c) => c[0].data.action === 'APPROVAL_CLIENT_REVIEWERID_IGNORED_ATTEMPT');
    expect(audit).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /api/v1/exceptions 列表', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/exceptions');
    expect(res.status).toBe(401);
  });

  it('按 status/exceptionCategory 过滤 → 透传 where + 返回视图（含解析后 scope）', async () => {
    const { app, prisma } = makeApp();
    const res = await request(app).get('/api/v1/exceptions?status=Pending&exceptionCategory=shipment_release');
    expect(res.status).toBe(200);
    expect(prisma.dr013ExceptionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null, status: 'Pending', exceptionCategory: 'shipment_release' }),
      }),
    );
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items[0].scope).toMatchObject({ targetType: 'Shipment', targetId: 'SHIP_003' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /api/v1/exceptions/gate-check 门禁查询', () => {
  it('缺 targetType/targetId/action → 400 INVALID_SCOPE', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/exceptions/gate-check?targetType=Shipment');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SCOPE');
  });

  it('生效例外精确命中 → 200 active=true', async () => {
    const { app } = makeApp({ exceptions: [{ ...baseExc, status: EXCEPTION_STATUS.REVIEWER_APPROVED }] });
    const res = await request(app).get(
      '/api/v1/exceptions/gate-check?targetType=Shipment&targetId=SHIP_003&action=shipment:release',
    );
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.exception.exceptionNumber).toBe('EXC-20260816-001');
  });

  it('无例外 → 200 active=false + reason（gate-check 不被 /:id 路由捕获）', async () => {
    const { app } = makeApp({ exceptions: [] });
    const res = await request(app).get(
      '/api/v1/exceptions/gate-check?targetType=Shipment&targetId=SHIP_404&action=shipment:release',
    );
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.reason).toBe('NO_ACTIVE_EXCEPTION');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /api/v1/exceptions/:id 详情', () => {
  it('不存在 → 404 EXCEPTION_NOT_FOUND', async () => {
    const { app } = makeApp({ exc: null });
    const res = await request(app).get('/api/v1/exceptions/EXC__ghost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('EXCEPTION_NOT_FOUND');
  });

  it('存在 → 200（含 scope 视图）', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/exceptions/EXC__1');
    expect(res.status).toBe(200);
    expect(res.body.exception.id).toBe('EXC__1');
    expect(res.body.exception.scope.action).toBe('shipment:release');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('POST /api/v1/exceptions/:id/withdraw 撤回', () => {
  it('非申请人 → 403 WITHDRAW_NOT_BY_REQUESTER', async () => {
    mockActor = { userId: 'u_other', roles: ['sales'], permissions: ['exception:dr013:create'] };
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions/EXC__1/withdraw');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WITHDRAW_NOT_BY_REQUESTER');
  });

  it('非 Pending → 409 EXCEPTION_NOT_PENDING', async () => {
    const { app } = makeApp({ exc: { ...baseExc, status: EXCEPTION_STATUS.REVIEWER_APPROVED } });
    const res = await request(app).post('/api/v1/exceptions/EXC__1/withdraw');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EXCEPTION_NOT_PENDING');
  });

  it('申请人撤回 Pending → 200 Cancelled', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/v1/exceptions/EXC__1/withdraw');
    expect(res.status).toBe(200);
    expect(calls.excUpdate.mock.calls[0][0].data.status).toBe(EXCEPTION_STATUS.CANCELLED);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('POST /api/v1/exceptions/:id/boss-bypass BOSS 最终兜底', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions/EXC__1/boss-bypass').send({ reason: BOSS_REASON });
    expect(res.status).toBe(401);
  });

  it('非 owner（admin）→ 403 BOSS_BYPASS_REQUIRES_OWNER（系统管理员也不得兜底）', async () => {
    mockActor = { userId: 'u_admin', roles: ['admin'] };
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions/EXC__1/boss-bypass').send({ reason: BOSS_REASON });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BOSS_BYPASS_REQUIRES_OWNER');
  });

  it('owner + reason ≤29 字 → 400 BOSS_REASON_TOO_SHORT', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/exceptions/EXC__1/boss-bypass').send({ reason: '客户要' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BOSS_REASON_TOO_SHORT');
  });

  it('owner + reason ≥30 字 → 200 双模型写入（EXC + ApprovalRequest bossFinalBypass*）', async () => {
    mockActor = { userId: 'u_boss', roles: ['owner'] };
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/v1/exceptions/EXC__1/boss-bypass').send({ reason: BOSS_REASON });
    expect(res.status).toBe(200);
    expect(res.body.exception.status).toBe(EXCEPTION_STATUS.BOSS_FINAL_BYPASS);
    expect(res.body.exception.bossFinalBypassBy).toBe('u_boss');
    expect(calls.approvalUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ar_1', status: 'pending' },
      data: expect.objectContaining({ status: 'approved', bossFinalBypassBy: 'u_boss', bossFinalBypassReason: BOSS_REASON }),
    });
  });
});
