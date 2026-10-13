/**
 * R678：GET /v1/reports/monthly-close/compare 读权限降级回归
 *
 * 拍板：compare 是纯读聚合（仅查 ReportDefinition/ReportRun 快照），
 * 从 requireReportsWrite 降为 requireReportsRead——只读角色（reports:read）
 * 进「月末结转」tab（MonthlyCloseSection 挂载即 loadCompare）不再 403。
 * POST /monthly-close（执行结转）仍保持 requireJwtForWrite + reports:write。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createReportingRouter } from '../route';

function tokenWith(permissions: string[]) {
  return createAuthService().signToken({
    userId: 'u_r678',
    displayName: 'ReadOnly',
    roles: ['viewer'],
    permissions,
    departmentIds: [],
  });
}

function makeApp() {
  const reportDefinition = {
    findMany: vi.fn().mockResolvedValue([
      { id: 'def_1', name: '订单月报', datasetKey: 'orders', metrics: [{ field: 'amount', agg: 'sum' }] },
    ]),
  };
  const reportRun = {
    findUnique: vi.fn().mockResolvedValue(null),
  };
  const prisma = { reportDefinition, reportRun } as any;
  const app = express();
  app.use(express.json());
  app.use('/v1/reports', createReportingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, reportDefinition, reportRun };
}

describe('R678: monthly-close/compare 读面权限', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('仅持 reports:read 的只读角色可读 compare（不再 403）', async () => {
    const { app } = makeApp();
    const token = tokenWith(['reports:read']);
    const res = await request(app)
      .get('/v1/reports/monthly-close/compare?periodKey=2026-07')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.periodKey).toBe('2026-07');
    expect(res.body.previousPeriodKey).toBe('2026-06');
    expect(res.body.items).toHaveLength(1);
    // 无快照 → current/previous 为 null，deltas 以 0 基线计算（不除零）
    expect(res.body.items[0].current).toBeNull();
    expect(res.body.items[0].previous).toBeNull();
  });

  it('未登录访问 compare → 401', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/v1/reports/monthly-close/compare?periodKey=2026-07');
    expect(res.status).toBe(401);
  });

  it('POST /monthly-close 执行端点仍要求 reports:write（只读角色 → 403）', async () => {
    const { app } = makeApp();
    const token = tokenWith(['reports:read']);
    const res = await request(app)
      .post('/v1/reports/monthly-close')
      .set('Authorization', `Bearer ${token}`)
      .send({ periodKey: '2026-07' });
    expect(res.status).toBe(403);
  });

  it('POST /monthly-close 持 reports:write 可进入服务层（无月度定义 → 404 NO_MONTHLY_DEFINITIONS 由 service 返回）', async () => {
    const { app, reportDefinition } = makeApp();
    reportDefinition.findMany.mockResolvedValue([]);
    const token = tokenWith(['reports:read', 'reports:write']);
    const res = await request(app)
      .post('/v1/reports/monthly-close')
      .set('Authorization', `Bearer ${token}`)
      .send({ periodKey: '2026-07' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_MONTHLY_DEFINITIONS');
  });
});
