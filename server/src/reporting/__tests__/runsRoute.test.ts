/**
 * R3：GET /v1/reports/runs offset 分页 + total 契约测试
 * （原端点仅 limit；补 offset/total 供前端「加载更多」消费）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthService } from '../../auth/service';
import { createReportingRouter } from '../route';

function readerToken() {
  return createAuthService().signToken({
    userId: 'reader-1',
    displayName: 'Reader',
    roles: ['sales'],
    permissions: ['reports:read'],
    departmentIds: [],
  });
}

function makeApp(opts: { runs?: any[]; total?: number } = {}) {
  const runs = opts.runs ?? [];
  const findMany = vi.fn().mockResolvedValue(runs);
  const count = vi.fn().mockResolvedValue(opts.total ?? runs.length);
  const prisma = {
    reportRun: { findMany, count },
    reportDefinition: { findMany: vi.fn().mockResolvedValue([]) },
  } as any;
  const app = express();
  app.use(express.json());
  app.use('/v1/reports', createReportingRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return { app, findMany, count, token: readerToken() };
}

describe('R3: GET /runs offset 分页与 total', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('默认 limit=50 / offset=0，响应携带 total', async () => {
    const { app, findMany, token } = makeApp({ runs: [{ id: 'r1' }], total: 1 });
    const res = await request(app).get('/v1/reports/runs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(findMany.mock.calls[0][0].take).toBe(50);
    expect(findMany.mock.calls[0][0].skip).toBe(0);
  });

  it('offset 透传 skip，total 为全量计数（不受分页影响）', async () => {
    const { app, findMany, token } = makeApp({ runs: [{ id: 'r101' }], total: 250 });
    const res = await request(app).get('/v1/reports/runs?limit=100&offset=100').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(250);
    expect(findMany.mock.calls[0][0].take).toBe(100);
    expect(findMany.mock.calls[0][0].skip).toBe(100);
  });

  it('definitionId 过滤时 findMany/count 用同一 where', async () => {
    const { app, findMany, count, token } = makeApp();
    await request(app).get('/v1/reports/runs?definitionId=d1&offset=50').set('Authorization', `Bearer ${token}`);
    expect(findMany.mock.calls[0][0].where).toEqual({ definitionId: 'd1' });
    expect(findMany.mock.calls[0][0].skip).toBe(50);
    expect(count.mock.calls[0][0].where).toEqual({ definitionId: 'd1' });
  });

  it('limit 超上限截 200，非法 offset 回退 0', async () => {
    const { app, findMany, token } = makeApp();
    await request(app).get('/v1/reports/runs?limit=1000&offset=abc').set('Authorization', `Bearer ${token}`);
    expect(findMany.mock.calls[0][0].take).toBe(200);
    expect(findMany.mock.calls[0][0].skip).toBe(0);
  });
});
