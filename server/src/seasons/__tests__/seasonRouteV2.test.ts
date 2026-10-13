/**
 * seasonRouteV2.test.ts — V2 季节路由契约测试（权限守卫层）
 *
 * V2 = V1 业务逻辑（seasonService，已被 seasonRoute.test.ts 覆盖）
 *      + requirePermission('seasons:read'|'seasons:write') 守卫。
 * 本文件只测路由层契约：门禁矩阵、JWT 强制、透传参数、404/400 校验、bigint 序列化。
 * 因此 seasonService 整体 mock，prisma 不参与。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const validApiKey = 'test-key';

// 带权限的 JWT（requirePermission 主要消费 actor.permissions 数组）
const readToken = jwt.sign(
  { userId: 'u_read', roles: ['viewer'], permissions: ['seasons:read'] },
  SECRET,
);
const writeToken = jwt.sign(
  { userId: 'u_rw', roles: ['manager'], permissions: ['seasons:read', 'seasons:write'] },
  SECRET,
);
const noScopeToken = jwt.sign(
  { userId: 'u_none', roles: ['viewer'], permissions: ['orders:read'] },
  SECRET,
);

const svc = {
  listSeasons: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  createSeason: vi.fn().mockImplementation(async (body: any, actorId: string) => ({
    id: 'SEAS__1', code: 'SS27', name: body?.name ?? 'x', updatedAt: 1789323600000, _actor: actorId,
  })),
  getSeason: vi.fn().mockResolvedValue(null),
  updateSeason: vi.fn().mockResolvedValue({ id: 'SEAS__1', name: 'u' }),
  deleteSeason: vi.fn().mockResolvedValue(undefined),
  computeSeasonReview: vi.fn().mockResolvedValue({ revenue: 0 }),
  generateSeasonReview: vi.fn().mockResolvedValue({ revenue: 1 }),
  listTrendTags: vi.fn().mockResolvedValue([]),
  createTrendTag: vi.fn().mockResolvedValue({ id: 'TAG__1' }),
  updateTrendTag: vi.fn().mockResolvedValue({ id: 'TAG__1' }),
  deleteTrendTag: vi.fn().mockResolvedValue(undefined),
  listTrendingFabrics: vi.fn().mockResolvedValue([]),
  listTradeShows: vi.fn().mockResolvedValue([]),
  createTradeShow: vi.fn().mockResolvedValue({ id: 'SHOW__1' }),
  getTradeShow: vi.fn().mockResolvedValue(null),
  updateTradeShow: vi.fn().mockResolvedValue({ id: 'SHOW__1' }),
  deleteTradeShow: vi.fn().mockResolvedValue(undefined),
  addLead: vi.fn().mockResolvedValue({ id: 'LEAD__1' }),
  updateLead: vi.fn().mockResolvedValue({ id: 'LEAD__1' }),
  deleteLead: vi.fn().mockResolvedValue(undefined),
  convertLead: vi.fn().mockResolvedValue({ id: 'LEAD__1' }),
  getShowROI: vi.fn().mockResolvedValue({ roi: 0 }),
};

vi.mock('../seasonService', () => ({
  createSeasonService: vi.fn(() => svc),
}));

import { createSeasonsV2Router } from '../seasonRouteV2';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/seasons', createSeasonsV2Router({
    prisma: {} as any,
    requireAuth: true,
    apiKeys: new Set([validApiKey]),
  }));
  return app;
}

let app: express.Express;
beforeEach(() => {
  app = makeApp();
  vi.clearAllMocks();
  svc.listSeasons.mockResolvedValue({ items: [], total: 0 });
  svc.getSeason.mockResolvedValue(null);
  svc.getTradeShow.mockResolvedValue(null);
});

describe('seasonRouteV2: 认证与读权限门禁', () => {
  it('无 token → 401（requireAuth=true 全路由强制 JWT）', async () => {
    const res = await request(app).get('/api/v2/seasons');
    expect(res.status).toBe(401);
  });

  it('JWT 但无 seasons:read scope → 403', async () => {
    const res = await request(app).get('/api/v2/seasons').set('Authorization', `Bearer ${noScopeToken}`);
    expect(res.status).toBe(403);
  });

  it('带 seasons:read → 200 {ok:true,...}，query.status/search/limit/offset 透传 service', async () => {
    const res = await request(app).get('/api/v2/seasons')
      .query({ status: 'active', search: 'SS27', limit: '5', offset: '10' })
      .set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(svc.listSeasons).toHaveBeenCalledWith({ status: 'active', search: 'SS27', limit: 5, offset: 10 });
  });

  it('GET /:id 不存在 → 404 NOT_FOUND（有 read scope 前提下）', async () => {
    const res = await request(app).get('/api/v2/seasons/NOPE').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('API-Key 走读端点（createModuleAuthGuard 放行 key）→ requirePermission 无 actor → 401', async () => {
    // key 只满足 moduleAuthGuard；requirePermission 需 JWT actor（fail-closed）
    const res = await request(app).get('/api/v2/seasons').set('X-Bambook-API-Key', validApiKey);
    expect(res.status).toBe(401);
  });
});

describe('seasonRouteV2: 写权限门禁与透传', () => {
  it('只读 scope 调写端点 → 403（POST /）', async () => {
    const res = await request(app).post('/api/v2/seasons')
      .set('Authorization', `Bearer ${readToken}`)
      .send({ code: 'SS27', name: 'x', startDate: '2027-01-01', endDate: '2027-06-30' });
    expect(res.status).toBe(403);
    expect(svc.createSeason).not.toHaveBeenCalled();
  });

  it('写 scope → 200，body 与 actorId 透传；BigInt 序列化为 Number', async () => {
    const res = await request(app).post('/api/v2/seasons')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ code: 'SS27', name: 'SS 2027', startDate: '2027-01-01', endDate: '2027-06-30' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // 序列化：updatedAt 为 Number 而非 bigint 字符串
    expect(typeof res.body.season.updatedAt).toBe('number');
    const [, actorId] = svc.createSeason.mock.calls[0];
    expect(actorId).toBe('u_rw');
  });

  it('PUT /:id 与 DELETE /:id：无 write scope → 403；有 → 200 透传', async () => {
    const resPut403 = await request(app).put('/api/v2/seasons/S1')
      .set('Authorization', `Bearer ${readToken}`).send({ name: 'n' });
    expect(resPut403.status).toBe(403);

    const resPut = await request(app).put('/api/v2/seasons/S1')
      .set('Authorization', `Bearer ${writeToken}`).send({ name: 'n' });
    expect(resPut.status).toBe(200);
    expect(svc.updateSeason).toHaveBeenCalledWith('S1', { name: 'n' }, 'u_rw');

    const resDel = await request(app).delete('/api/v2/seasons/S1')
      .set('Authorization', `Bearer ${writeToken}`);
    expect(resDel.status).toBe(200);
    expect(resDel.body.deleted).toBe(true);
    expect(svc.deleteSeason).toHaveBeenCalledWith('S1', 'u_rw');
  });

  it('Review：GET /:id/review（read）200；POST /:id/review/generate（write）200', async () => {
    const resGet = await request(app).get('/api/v2/seasons/S1/review')
      .set('Authorization', `Bearer ${readToken}`);
    expect(resGet.status).toBe(200);
    expect(svc.computeSeasonReview).toHaveBeenCalledWith('S1');

    const resGen = await request(app).post('/api/v2/seasons/S1/review/generate')
      .set('Authorization', `Bearer ${writeToken}`);
    expect(resGen.status).toBe(200);
    expect(svc.generateSeasonReview).toHaveBeenCalledWith('S1', 'u_rw');
  });
});

describe('seasonRouteV2: 趋势/展会/线索子资源', () => {
  it('Trend tags：GET（read）按 seasonId+type 过滤透传；POST seasonId 以路径参数覆盖 body', async () => {
    const resGet = await request(app).get('/api/v2/seasons/S1/trend-tags')
      .query({ type: 'color' }).set('Authorization', `Bearer ${readToken}`);
    expect(resGet.status).toBe(200);
    expect(svc.listTrendTags).toHaveBeenCalledWith({ seasonId: 'S1', type: 'color' });

    const resPost = await request(app).post('/api/v2/seasons/S1/trend-tags')
      .set('Authorization', `Bearer ${writeToken}`).send({ seasonId: 'FAKE', type: 'color', name: 't' });
    expect(resPost.status).toBe(200);
    expect(svc.createTrendTag).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: 'S1' }), 'u_rw',
    );
  });

  it('PUT/DELETE /trend-tags/:tagId：write 门禁 + 透传', async () => {
    const resPut = await request(app).put('/api/v2/seasons/trend-tags/T1')
      .set('Authorization', `Bearer ${writeToken}`).send({ name: 'n2' });
    expect(resPut.status).toBe(200);
    const resDel = await request(app).delete('/api/v2/seasons/trend-tags/T1')
      .set('Authorization', `Bearer ${writeToken}`);
    expect(resDel.status).toBe(200);
    expect(svc.deleteTrendTag).toHaveBeenCalledWith('T1', 'u_rw');
  });

  it('GET /trending/fabrics 与 /trade-shows：read 放行、query 透传', async () => {
    const resFab = await request(app).get('/api/v2/seasons/trending/fabrics')
      .query({ seasonId: 'S1' }).set('Authorization', `Bearer ${readToken}`);
    expect(resFab.status).toBe(200);
    expect(svc.listTrendingFabrics).toHaveBeenCalledWith({ seasonId: 'S1' });

    const resShows = await request(app).get('/api/v2/seasons/trade-shows')
      .query({ seasonId: 'S1', status: 'planned' }).set('Authorization', `Bearer ${readToken}`);
    expect(resShows.status).toBe(200);
    expect(svc.listTradeShows).toHaveBeenCalledWith({ seasonId: 'S1', status: 'planned' });
  });

  it('GET /trade-shows/:id 不存在 → 404；GET /trade-shows/:id/roi（read）200', async () => {
    const res404 = await request(app).get('/api/v2/seasons/trade-shows/NOPE')
      .set('Authorization', `Bearer ${readToken}`);
    expect(res404.status).toBe(404);

    const resRoi = await request(app).get('/api/v2/seasons/trade-shows/SHOW__1/roi')
      .set('Authorization', `Bearer ${readToken}`);
    expect(resRoi.status).toBe(200);
    expect(svc.getShowROI).toHaveBeenCalledWith('SHOW__1');
  });

  it('POST /trade-shows/:id/leads → 400 缺 relationId；POST /leads/:leadId/convert 缺 relationId → 400（守卫先于校验，用 write token）', async () => {
    const resConvert = await request(app).post('/api/v2/seasons/leads/L1/convert')
      .set('Authorization', `Bearer ${writeToken}`).send({});
    expect(resConvert.status).toBe(400);
    expect(svc.convertLead).not.toHaveBeenCalled();

    const resConvertOk = await request(app).post('/api/v2/seasons/leads/L1/convert')
      .set('Authorization', `Bearer ${writeToken}`).send({ relationId: 'SIM-CUS-03' });
    expect(resConvertOk.status).toBe(200);
    expect(svc.convertLead).toHaveBeenCalledWith('L1', 'SIM-CUS-03', 'u_rw');

    const resAdd = await request(app).post('/api/v2/seasons/trade-shows/SHOW__1/leads')
      .set('Authorization', `Bearer ${writeToken}`).send({ customerName: 'ACME' });
    expect(resAdd.status).toBe(200);
    expect(svc.addLead).toHaveBeenCalledWith('SHOW__1', { customerName: 'ACME' }, 'u_rw');
  });
});
