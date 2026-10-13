import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createCreditRouter } from '../creditRoute';

/**
 * 信用控制域路由契约测试（Track F）：
 *   POST /:customerId/freeze — 401 无 JWT / 403 无 scope / 400 理由缺失 / 200 成功
 *   POST /:customerId/thaw   — 401 / 403（scope 独立）/ 409 未冻结 / 200 成功
 *   GET  /:customerId/status — 401 / 200（门禁标记 creditFrozen）
 *   GET  /:customerId/history— 401 / 200（items + total）
 */

// 可控 actor mock（财务经理持 credit:freeze:write / credit:thaw:write）
let mockActor: { userId: string; roles: string[]; permissions?: string[] } | null = {
  userId: 'u_fin_mgr',
  roles: ['finance'],
  permissions: ['credit:freeze:write', 'credit:thaw:write'],
};

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeApp(opts: { creditLimits?: any[]; history?: any[] } = {}) {
  const creditLimits = opts.creditLimits ?? [];
  const history = opts.history ?? [];

  const matchWhere = (cl: any, where: any) => {
    if (where?.relationId && cl.relationId !== where.relationId) return false;
    if (where?.status && cl.status !== where.status) return false;
    if (where && 'deletedAt' in where && where.deletedAt === null && cl.deletedAt !== null) return false;
    return true;
  };

  const prisma: any = {
    creditLimit: {
      findMany: vi.fn(async ({ where }: any = {}) => creditLimits.filter((cl) => matchWhere(cl, where))),
      findFirst: vi.fn(async ({ where }: any) => creditLimits.find((cl) => matchWhere(cl, where)) ?? null),
      update: vi.fn(async ({ where, data }: any) => ({ ...creditLimits.find((c) => c.id === where.id), ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    creditLimitHistory: {
      create: vi.fn(async ({ data }: any) => data),
      findMany: vi.fn(async ({ where }: any) => history.filter((h) => h.relationId === where.relationId)),
      count: vi.fn(async ({ where }: any) => history.filter((h) => h.relationId === where.relationId).length),
    },
    invoice: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/v1/credit', createCreditRouter({ prisma, requireAuth: true }));
  return { app, prisma };
}

const frozenCl = {
  id: 'CL_1', relationId: 'REL_A', totalLimit: 800000, usedAmount: 120000, currency: 'CNY',
  status: 'Frozen', frozenAt: new Date(2026, 7, 1), frozenBy: 'system_credit_scan',
  thawedReason: null, lastAutoScanDate: null, deletedAt: null, createdAt: BigInt(1),
};
const activeCl = { ...frozenCl, status: 'Active', frozenAt: null, frozenBy: null };

beforeEach(() => {
  mockActor = {
    userId: 'u_fin_mgr',
    roles: ['finance'],
    permissions: ['credit:freeze:write', 'credit:thaw:write'],
  };
});

describe('POST /api/v1/credit/:customerId/freeze', () => {
  it('无 JWT → 401（fail-closed）', async () => {
    mockActor = null;
    const { app } = makeApp({ creditLimits: [activeCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/freeze').send({ reason: '客户涉诉暂停授信' });
    expect(res.status).toBe(401);
  });

  it('无 credit:freeze:write scope（业务员）→ 403 FORBIDDEN', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    const { app } = makeApp({ creditLimits: [activeCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/freeze').send({ reason: '客户涉诉暂停授信' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.message).toContain('credit:freeze:write');
  });

  it('理由缺失 → 400 CREDIT_REASON_REQUIRED', async () => {
    const { app } = makeApp({ creditLimits: [activeCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/freeze').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CREDIT_REASON_REQUIRED');
  });

  it('成功 → 200 + frozen ids', async () => {
    const { app } = makeApp({ creditLimits: [activeCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/freeze').send({ reason: '客户涉诉暂停授信' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.frozen).toEqual(['CL_1']);
  });

  it('已冻结 → 409 CREDIT_ALREADY_FROZEN', async () => {
    const { app } = makeApp({ creditLimits: [frozenCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/freeze').send({ reason: '重复冻结测试理由' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CREDIT_ALREADY_FROZEN');
  });
});

describe('POST /api/v1/credit/:customerId/thaw', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp({ creditLimits: [frozenCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/thaw').send({ reason: '逾期款已全额核销' });
    expect(res.status).toBe(401);
  });

  it('仅持 freeze scope 不持 thaw scope → 403（双 scope 独立守卫）', async () => {
    // 注意：finance 角色经 rolePermissionMatrix fallback 天然持有双 scope；
    // 此处用 sales 角色 + 显式仅 freeze 权限，隔离验证 thaw scope 独立守卫
    mockActor = { userId: 'u_sales', roles: ['sales'], permissions: ['credit:freeze:write'] };
    const { app } = makeApp({ creditLimits: [frozenCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/thaw').send({ reason: '逾期款已全额核销' });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('credit:thaw:write');
  });

  it('未冻结 → 409 CREDIT_NOT_FROZEN', async () => {
    const { app } = makeApp({ creditLimits: [activeCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/thaw').send({ reason: '未冻结解冻测试理由' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CREDIT_NOT_FROZEN');
  });

  it('成功 → 200 + thawed ids（thawedReason 落库）', async () => {
    const { app, prisma } = makeApp({ creditLimits: [frozenCl] });
    const res = await request(app).post('/api/v1/credit/REL_A/thaw').send({ reason: '逾期款已全额核销并特批' });
    expect(res.status).toBe(200);
    expect(res.body.thawed).toEqual(['CL_1']);
    expect(prisma.creditLimit.update.mock.calls[0][0].data.thawedReason).toContain('全额核销');
  });
});

describe('GET /api/v1/credit/:customerId/status', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp({ creditLimits: [frozenCl] });
    const res = await request(app).get('/api/v1/credit/REL_A/status');
    expect(res.status).toBe(401);
  });

  it('Frozen 客户 → 200 + creditFrozen=true + 额度字段序列化', async () => {
    const { app } = makeApp({ creditLimits: [frozenCl] });
    const res = await request(app).get('/api/v1/credit/REL_A/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Frozen');
    expect(res.body.creditFrozen).toBe(true);
    expect(res.body.totalLimit).toBe(800000);
    expect(res.body.remaining).toBe(680000);
    expect(res.body.frozenBy).toBe('system_credit_scan');
  });

  it('无额度客户 → 200 + hasCreditLimit=false + creditFrozen=false', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/credit/REL_NONE/status');
    expect(res.status).toBe(200);
    expect(res.body.hasCreditLimit).toBe(false);
    expect(res.body.creditFrozen).toBe(false);
  });
});

describe('GET /api/v1/credit/:customerId/history', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/credit/REL_A/history');
    expect(res.status).toBe(401);
  });

  it('返回时间线 items + total（含冻结/解冻/占用事件）', async () => {
    const history = [
      { id: 'H2', relationId: 'REL_A', triggerType: 'credit_freeze', delta: 0, remark: '60 天逾期自动冻结' },
      { id: 'H1', relationId: 'REL_A', triggerType: 'order_confirm', delta: 50000 },
    ];
    const { app } = makeApp({ history });
    const res = await request(app).get('/api/v1/credit/REL_A/history');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(2);
  });
});
