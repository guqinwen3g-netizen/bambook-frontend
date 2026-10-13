/**
 * §9 B22 第 3 域 · `seasons/seasonRouteV2.ts`（22 处）错误出口收敛的**执行**覆盖
 *
 * 这个文件族的特殊性（决定了本批的取舍，见 §12.05 D36）：
 *   路由族 2026-09-15 就标了 DEPRECATED、前端零消费，但**仍挂载且任何持凭据的调用方都能打到**
 *   ⇒ 原文外泄这条照样要堵（信息泄露不按"有没有人用"打折）；
 *   但给一个待删除的表面手写 22 句专属文案是本末倒置 ⇒ 用**一条共享文案**，真正的处置是业务确认后整族删除。
 *
 * 判据全部来自外部（G6.5 + RFC 9110 + 「前端零消费」这条声称本身），不是抄实现现值：
 *   ① 未预期异常 ⇒ 500 + 响应体不含任何内部原文（表名 / Prisma 方法名 / SQL 片段）；
 *   ② 业务错误（code+statusCode）⇒ 认它自己的档位与文案，不被兜底吞掉；
 *   ③ 对外形状 flat `{error, message}` 与码名 `INTERNAL_ERROR` 不变（旧契约）；
 *   ④ 「前端零消费」是**可被证伪的声称** ⇒ 下面那条跨树守卫盯着：一旦有人开始消费它，红，逼重新裁定（补真文案或并回 V1）。
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const HERE = path.dirname(fileURLToPath(import.meta.url));        // server/src/seasons/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');              // server/
const APP_ROOT = path.resolve(SERVER, '..');                       // 应用根（前端在此）
const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';

const svc = {
  listSeasons: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  createSeason: vi.fn().mockResolvedValue({ id: 'SEAS__1' }),
  deleteSeason: vi.fn().mockResolvedValue(undefined),
  getSeason: vi.fn().mockResolvedValue(null),
  listTradeShows: vi.fn().mockResolvedValue([]),
  getShowROI: vi.fn().mockResolvedValue({ roi: 0 }),
};

vi.mock('../seasonService', () => ({ createSeasonService: vi.fn(() => svc) }));

const { createSeasonsV2Router } = await import('../seasonRouteV2');

const readToken = jwt.sign({ userId: 'u_r', roles: ['viewer'], permissions: ['seasons:read'] }, SECRET);
const writeToken = jwt.sign({ userId: 'u_w', roles: ['manager'], permissions: ['seasons:read', 'seasons:write'] }, SECRET);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/seasons', createSeasonsV2Router({ prisma: {} as any, requireAuth: true, apiKeys: new Set() }));
  return app;
}

const RAW = 'PrismaClientKnownRequestError: Invalid `prisma.season.findMany()` invocation in /srv/app/server/src/seasons/seasonRouteV2.ts:79 — table `Season` does not exist';

beforeEach(() => {
  vi.clearAllMocks();
  svc.listSeasons.mockResolvedValue({ items: [], total: 0 });
  svc.createSeason.mockResolvedValue({ id: 'SEAS__1' });
  svc.deleteSeason.mockResolvedValue(undefined);
  svc.getSeason.mockResolvedValue(null);
  svc.listTradeShows.mockResolvedValue([]);
});

describe('B22 · seasonRouteV2 未预期异常不外发原文', () => {
  it('GET /（读）服务层炸 → 500 + INTERNAL_ERROR + 中文可行动文案 + 零内部细节', async () => {
    svc.listSeasons.mockRejectedValueOnce(new Error(RAW));
    const res = await request(makeApp()).get('/api/v2/seasons').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');          // ③ 码名与 flat 形状是旧契约
    expect(typeof res.body.message).toBe('string');
    const body = JSON.stringify(res.body);
    for (const frag of ['PrismaClient', 'prisma.season', 'seasonRouteV2.ts', 'does not exist', '/srv/app']) {
      expect(body, `响应体里不应出现内部细节片段「${frag}」`).not.toContain(frag);
    }
    expect(res.body.message).toMatch(/[\u4e00-\u9fa5]/);       // ① 必须是中文
    expect(res.body.message).toContain('未确认任何改动');        // ① 必须说清"没留下记录"
  });

  it('POST /（写）服务层炸 → 500 + 同一句「未确认任何改动」（写路径必须讲清有没有落库）', async () => {
    svc.createSeason.mockRejectedValueOnce(new Error(RAW));
    const res = await request(makeApp()).post('/api/v2/seasons')
      .set('Authorization', `Bearer ${writeToken}`).send({ code: 'DRILL-SS27', name: 'E2E-演练季节' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
    expect(res.body.message).toContain('未确认任何改动');
    expect(JSON.stringify(res.body)).not.toContain('PrismaClient');
  });

  it('DELETE /:id 服务层炸 → 500 且不得把记录状态猜成「已删除」或「仍存在」之外的断言（文案只说未确认改动）', async () => {
    svc.deleteSeason.mockRejectedValueOnce(new Error(RAW));
    const res = await request(makeApp()).delete('/api/v2/seasons/S1')
      .set('Authorization', `Bearer ${writeToken}`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('findMany');
    expect(res.body.message).toContain('请稍后重试');
  });

  it('GET /:id 业务错误（自带 code+statusCode）→ 认它自己的档位与文案（不被兜底吞）', async () => {
    svc.getSeason.mockRejectedValueOnce(
      Object.assign(new Error('季节编码已存在，请换一个'), { code: 'DUPLICATE_CODE', statusCode: 409 }),
    );
    const res = await request(makeApp()).get('/api/v2/seasons/S1').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_CODE');
    expect(res.body.message).toBe('季节编码已存在，请换一个');
  });

  it('无 token → 401（收敛没把守卫绕过去；401 响应体也不带原文）', async () => {
    const anon = await request(makeApp()).delete('/api/v2/seasons/S1');
    expect(anon.status).toBe(401);
    expect(JSON.stringify(anon.body)).not.toContain('PrismaClient');
  });
});

describe('B22 · seasonRouteV2 源码与"前端零消费"声称', () => {
  const routeSrc = () => fs.readFileSync(path.join(SERVER, 'src', 'seasons', 'seasonRouteV2.ts'), 'utf8');

  it('路由内不再有任何把原始异常写进响应体的写法；22 处出口全部走真源', () => {
    expect(routeSrc().match(/message:\s*(err|e)\??\.message/g) ?? []).toHaveLength(0);
    expect((routeSrc().match(/safeRouteError\(e, \{ fallbackCode: 'INTERNAL_ERROR'/g) ?? []).length).toBe(22);
    // 阳性对照：本族的旧写法必须被上面第一条抓到（否则那条是恒真守卫）
    expect(("} catch (e: any) { res.status(500).json({ error: 'INTERNAL_ERROR', message: e?.message }); }")
      .match(/message:\s*(err|e)\??\.message/g) ?? []).toHaveLength(1);
  });

  // 「前端零消费」这条声称的跨树守卫已并到
  // `shared/__tests__/deprecatedV2Surface.test.ts`（同时覆盖 seasons 与 suppliers 两族）——
  // 同一判据放两份迟早改一处漏一处（§5 R2）。本文件只留**行为**覆盖。

});
