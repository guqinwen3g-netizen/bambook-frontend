/**
 * MES list 端点分页契约测试（R678）
 *
 * 背景：六个 list 端点（work-stations / plans / work-hours / piece-rate-rules /
 * piece-rate-records / outsourcing）原先无 limit/offset，total = items.length（假计数）。
 * 本测试锁定契约：
 *   - ?limit=&offset= 透传为 Prisma take/skip（limit 收敛 [1,500]，offset 负数归零）
 *   - 响应 { items, total }，total 为真实 count（与 items.length 解耦）
 *   - 缺省不传 limit → 全量返回（向后兼容）
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createMesRouter } from '../mesRoute';
import { createAuthService } from '../../auth/service';

// The pay-row pagination case has the actual dual payroll read scope. The
// unauthenticated development reader remains a refusal control below.
const salaryReader = createAuthService().signToken({
  userId: 'u_mes_pagination_salary', roles: ['finance'],
  permissions: ['production:read', 'hr:salary:read', 'sensitive:salary'],
  authorizationLoaded: true, departmentIds: [],
});
const listRequest = (app: express.Express, path: string) => {
  const pending = request(app).get(path);
  return path.includes('/piece-rate-records') ? pending.set('Authorization', `Bearer ${salaryReader}`) : pending;
};

/** 记录最近一次 findMany 调用参数（供断言 take/skip 透传） */
const lastFindManyArgs: Record<string, any> = {};

/** 每模型 seed 5 行（行内容对契约无影响，仅计数用） */
const SEED_ROWS = Array.from({ length: 5 }, (_, i) => ({ id: `row_${i + 1}` }));

function makeModel(name: string) {
  return {
    findMany: vi.fn(async (args: any = {}) => {
      lastFindManyArgs[name] = args;
      const skip = args.skip ?? 0;
      const take = args.take ?? SEED_ROWS.length;
      return SEED_ROWS.slice(skip, skip + take);
    }),
    count: vi.fn(async () => SEED_ROWS.length),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
  };
}

function makePrismaStub() {
  return {
    // The order visibility query is a separate delegate. Nesting it inside
    // makeModel would recursively construct models before a request is made.
    // Row visibility itself is covered by the isolated PostgreSQL probes.
    order: makeModel('order'),
    workStation: makeModel('workStation'),
    productionPlan: makeModel('productionPlan'),
    workHour: makeModel('workHour'),
    pieceRateRule: makeModel('pieceRateRule'),
    pieceRateRecord: makeModel('pieceRateRecord'),
    outsourcingOrder: makeModel('outsourcingOrder'),
  } as any;
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mes', createMesRouter({ prisma, requireAuth: false, apiKeys: new Set() }));
  return app;
}

const CASES: Array<{ path: string; model: string }> = [
  { path: '/work-stations', model: 'workStation' },
  { path: '/plans', model: 'productionPlan' },
  { path: '/work-hours', model: 'workHour' },
  { path: '/piece-rate-rules', model: 'pieceRateRule' },
  { path: '/piece-rate-records', model: 'pieceRateRecord' },
  { path: '/outsourcing', model: 'outsourcingOrder' },
];

describe('MES list 端点分页（R678）', () => {
  let prisma: any;
  let app: express.Express;

  beforeEach(() => {
    for (const k of Object.keys(lastFindManyArgs)) delete lastFindManyArgs[k];
    prisma = makePrismaStub();
    app = makeApp(prisma);
  });

  it.each(CASES)('%s：?limit=2&offset=1 → take/skip 透传 + total 为真实 count', async ({ path, model }) => {
    const res = await listRequest(app, `/api/v1/mes${path}?limit=2&offset=1`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(lastFindManyArgs[model]).toEqual(expect.objectContaining({ take: 2, skip: 1 }));
  });

  it.each(CASES)('%s：缺省 limit → 全量返回（向后兼容），total = 实际条数', async ({ path, model }) => {
    const res = await listRequest(app, `/api/v1/mes${path}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.total).toBe(5);
    expect(lastFindManyArgs[model] ?? {}).not.toHaveProperty('take');
    expect(lastFindManyArgs[model] ?? {}).not.toHaveProperty('skip');
  });

  it('limit 越界收敛 500、offset 负数归零（/plans）', async () => {
    const res = await request(app).get('/api/v1/mes/plans?limit=9999&offset=-3');
    expect(res.status).toBe(200);
    expect(lastFindManyArgs.productionPlan).toEqual(expect.objectContaining({ take: 500, skip: 0 }));
  });

  it('未登录开发读者仍不能读取工资行，不能靠关闭认证绕过双权限', async () => {
    const res = await request(app).get('/api/v1/mes/piece-rate-records?limit=2&offset=1');
    expect(res.status).toBe(403);
    expect(prisma.pieceRateRecord.findMany).not.toHaveBeenCalled();
    expect(prisma.pieceRateRecord.count).not.toHaveBeenCalled();
  });

  it('非法 limit/offset（非数字）→ 按不分页处理，不 500', async () => {
    const res = await request(app).get('/api/v1/mes/work-stations?limit=abc&offset=xyz');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(lastFindManyArgs.workStation ?? {}).not.toHaveProperty('take');
  });

  it('/plans?format=xlsx 导出走全量口径（不受分页参数影响）', async () => {
    const res = await request(app).get('/api/v1/mes/plans?format=xlsx&limit=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    // 导出分支不带 take/skip（全量）
    expect(lastFindManyArgs.productionPlan ?? {}).not.toHaveProperty('take');
  });
});
