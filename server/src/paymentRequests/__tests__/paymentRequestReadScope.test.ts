/**
 * 付款申请**读端点**行级收口测试 —— ★ 口径 B3（2026-09-17 业务方拍板：**三档数据范围**）
 *
 * ── 口径变更（取代 2026-09-15 的 P4-1 #18「二元档」）──────────
 * **旧（#18 二元档）**：持 `finance:read` → **全档**；否则 → **强制只看自己**。
 *   实测后果（P4-1 #18）：**业务员档可读财务/后勤/其他业务员名下的全部付款申请**
 *   （含供应商名与金额，最大一笔 166,864.00）—— 因为业务员也持 `finance:read`。
 * **新（B3 三档）**：`self`（自己）· `team`（同组）· `all`（全部）；
 *   ★ **被指派的审批人 `reviewerId` 恒可见**（否则跨组审批人看不到要批的单）。
 *   构造真源：`paymentRequestScope.ts`。见 `docs/业务口径决策单-2026-09-17.md` B3。
 *
 * ── 本测试锁定 ───────────────────────────────────────────
 *   · `self` + 非本人 → 列表 where 收窄到「本人 ∪ 本人被指派」/ 详情 404（不泄露存在性）
 *   · `self` + 本人 → 详情 200
 *   · `team` → 列表 where 的 `applicantId.in` **含同组用户**（不再只看自己）
 *   · `all` → 不过滤，`query.applicantId` 正常透传
 *   · ★ **审批人豁免**：`self` 档但 `reviewerId === 自己` → 详情 **200**（B3 新增行为）
 *   · 未登录 → 401（不被行级收口掩盖）
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaymentRequestRouter } from '../paymentRequestRoute';

let mockActor: { userId: string; roles: string[]; permissions?: string[] } | null = null;

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));

/**
 * ★ 直接 mock 数据范围解析器 —— 让三档可控且**与角色矩阵解耦**
 * （否则测试会随矩阵演化而飘，且要 mock 一堆 rbac 模型）。
 */
let mockTier: 'self' | 'team' | 'all' = 'self';
let mockAllowedUserIds: string[] = [];
vi.mock('../../auth/permissionService', async importOriginal => ({
  // Only the three-tier resolver is a substitute. Retain the real pure scope
  // check used by generate-document so a missing mock export cannot hang HTTP.
  ...await importOriginal<typeof import('../../auth/permissionService')>(),
  createPermissionService: () => ({
    getDataScopeResolver: async () => ({
      rule: { kind: mockTier },
      allowedUserIds: mockAllowedUserIds,
      allowedDepartmentIds: [],
    }),
  }),
}));

const basePr = {
  id: 'PAYR__1',
  requestNumber: 'PAYR-20260816-001',
  payeeType: 'Supplier',
  supplierId: 'REL_SUP1',
  supplierName: '供应商A',
  totalAmount: '1000.0000',
  currency: 'CNY',
  applicantId: 'u_sales',
  reviewerId: 'u_boss',
  status: 'Pending',
  approvalRequestId: null,
  paymentVoucherId: null,
  paymentCategory: 'normal',
  deletedAt: null,
};

function makeApp() {
  const prisma: any = {
    paymentRequest: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => [basePr]),
      findUnique: vi.fn(async ({ where }: any) => (where.id === basePr.id ? basePr : null)),
    },
    paymentVoucher: { findUnique: vi.fn(async () => null) },
    approvalRequest: { findUnique: vi.fn(async () => null) },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma, requireAuth: true }));
  return app;
}

/** 带 findMany/findUnique spy 的 app（用于断言行级收口 where 片段） */
function makeAppWithFindSpy() {
  const findMany = vi.fn(async () => [basePr]);
  const findUnique = vi.fn(async ({ where }: any) =>
    where.id === basePr.id ? basePr : null,
  );
  const prisma: any = {
    paymentRequest: { count: vi.fn(async () => 0), findMany, findUnique },
    paymentVoucher: { findUnique: vi.fn(async () => null) },
    approvalRequest: { findUnique: vi.fn(async () => null) },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma, requireAuth: true }));
  return { app, findMany, findUnique };
}

/** 取列表查询的 where（含本批新增的 AND 数据范围片段） */
const scopeOf = (findMany: any) => findMany.mock.calls[0][0].where.AND?.[0];

describe('付款申请读端点行级收口（口径 B3：三档数据范围）', () => {
  beforeEach(() => {
    mockActor = null;
    mockTier = 'self';
    mockAllowedUserIds = [];
  });

  // ── self 档 ──

  it('★ self 档 → 列表 where 收窄为 OR[applicantId∈用户集, reviewerId=自己]', async () => {
    mockActor = { userId: 'u_other', roles: [] };
    const { app, findMany } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests');
    expect(res.status).toBe(200);

    const scope = scopeOf(findMany);
    expect(scope).toBeDefined();
    expect(scope.OR[0].applicantId.in).toContain('u_other');
    // ★ 豁免分支必须在
    expect(scope.OR[1]).toEqual({ reviewerId: 'u_other' });
  });

  it('★ self 档 + ?applicantId=someone → 该 query **不得**出现在 where（防绕过）', async () => {
    mockActor = { userId: 'u_other', roles: [] };
    const { app, findMany } = makeAppWithFindSpy();
    await request(app).get('/api/v1/payment-requests?applicantId=u_other_target');
    const where = findMany.mock.calls[0][0].where;
    expect(where.applicantId).toBeUndefined(); // 不再透传（收窄由 AND 片段表达）
    expect(scopeOf(findMany).OR[0].applicantId.in).toContain('u_other');
    expect(scopeOf(findMany).OR[0].applicantId.in).not.toContain('u_other_target');
  });

  it('self 档 + 非本人（也非审批人）→ 详情 404（按不存在处理，防越权嗅探存在性）', async () => {
    mockActor = { userId: 'u_other', roles: [] };
    const { app } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1');
    expect(res.status).toBe(404);
    expect(res.body.message).toContain('不存在');
  });

  it('非本人且非审批人不能通过生成文件绕过同一B3数据范围', async () => {
    mockActor = { userId: 'u_other', roles: [], permissions: ['finance:payment_request:create'] };
    const { app } = makeAppWithFindSpy();
    const response = await request(app).post('/api/v1/payment-requests/PAYR__1/generate-document').send({});
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
  });

  it('self 档 + 本人 → 详情 200（不影响申请人查自己的）', async () => {
    mockActor = { userId: 'u_sales', roles: [] }; // 与 basePr.applicantId 同
    const { app } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1');
    expect(res.status).toBe(200);
  });

  // ── ★ B3 新增行为：审批人豁免 ──

  it('★ 审批人豁免：self 档 + 非本人，但 reviewerId === 自己 → 详情 200', async () => {
    mockActor = { userId: 'u_boss', roles: [] }; // basePr.reviewerId = 'u_boss'
    const { app } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1');
    // ★ 去掉豁免会变 404 ⇒ 跨组审批人看不到自己要批的单
    expect(res.status).toBe(200);
  });

  it('★ 审批人豁免同样作用于 HTML 预览端点', async () => {
    mockActor = { userId: 'u_boss', roles: [] };
    const { app } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1/preview.html');
    expect(res.status).not.toBe(404); // 渲染数据缺失时也不是 404 越权响应
  });

  it('self 档 + 非本人非审批人 → 单据 HTML 预览 404（与详情同门）', async () => {
    mockActor = { userId: 'u_other', roles: [] };
    const { app } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1/preview.html');
    expect(res.status).toBe(404);
  });

  // ── team 档 ──

  it('★ team 档 → 列表 where 的 applicantId.in **含同组用户**（不再只看自己）', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    mockTier = 'team';
    mockAllowedUserIds = ['u_sales', 'u_teammate'];
    const { app, findMany } = makeAppWithFindSpy();
    await request(app).get('/api/v1/payment-requests');
    const ids = scopeOf(findMany).OR[0].applicantId.in;
    expect(ids).toContain('u_sales');
    expect(ids).toContain('u_teammate'); // ← 二元档下这里只有自己
  });

  // ── all 档 ──

  it('all 档 → 列表**不加**范围片段，且 query.applicantId 正常透传', async () => {
    mockActor = { userId: 'u_fin', roles: ['finance'] };
    mockTier = 'all';
    const { app, findMany } = makeAppWithFindSpy();
    await request(app).get('/api/v1/payment-requests?applicantId=other_user');
    const where = findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined(); // 不过滤
    expect(where.applicantId).toBe('other_user'); // 透传
  });

  it('all 档 + 非本人 → 详情 200（全档不受 applicantId 限制）', async () => {
    mockActor = { userId: 'u_fin', roles: ['finance'] };
    mockTier = 'all';
    const { app } = makeAppWithFindSpy();
    const res = await request(app).get('/api/v1/payment-requests/PAYR__1');
    expect(res.status).toBe(200);
  });

  // ── 未登录 → 401（不被行级收口掩盖）──

  it('未登录 → 仍是 401（不被 200 掩盖）', async () => {
    mockActor = null;
    const res = await request(makeApp()).get('/api/v1/payment-requests');
    expect(res.status).toBe(401);
  });
});
