import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBusinessProfilesRouter } from '../route';
import { ownerToken } from '../../__tests__/authTestHelper';

/**
 * business-profiles 路由契约测试（补登：本模块此前 **零测试**）。
 * 覆盖：列表（软删过滤 + kind 过滤）/ upsert（校验 + 成功 + onDataChange）/
 *       软删（isActive=false + deletedAt）/ API-Key 限只读。
 */

const validApiKey = 'test-key';

function makePrisma(seed: any[] = []) {
  const rows = [...seed];
  return {
    _rows: rows,
    businessProfile: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        rows.filter((r) => {
          if (r.deletedAt != null) return false;
          if (where?.kind && r.kind !== where.kind) return false;
          return true;
        })),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...update, id: where.id };
          return rows[idx];
        }
        const row = { ...create, id: where.id ?? create.id };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) throw new Error('NOT_FOUND');
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      }),
    },
  } as any;
}

function makeApp(prisma: any, onDataChange = vi.fn(), opts: { requireAuth?: boolean; injectJwt?: boolean } = {}) {
  const injectJwt = opts.injectJwt !== false;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    // 默认注入 owner JWT（保持「测业务、不测门禁」）；API-Key 通道用例须关闭，
    // 否则请求会同时携带 JWT 而被识别为登录用户，写操作自然放行。
    if (injectJwt && !req.headers.authorization && !req.headers.cookie) {
      req.headers.authorization = `Bearer ${ownerToken}`;
    }
    next();
  });
  app.use('/api/v1/business-profiles', createBusinessProfilesRouter({
    prisma, requireAuth: opts.requireAuth ?? true, apiKeys: new Set([validApiKey]), onDataChange,
  }));
  return app;
}

const authHeader = { Authorization: `Bearer ${ownerToken}` };

describe('businessProfilesRoute', () => {
  let onDataChange: any;
  beforeEach(() => { onDataChange = vi.fn(); });

  it('GET / 列出未软删档案；kind 过滤生效', async () => {
    const prisma = makePrisma([
      { id: 'P1', kind: 'exporter', name: '抬头A', updatedAt: 2n, deletedAt: null },
      { id: 'P2', kind: 'bank', name: '抬头B', updatedAt: 1n, deletedAt: null },
      { id: 'P3', kind: 'exporter', name: '已删', updatedAt: 3n, deletedAt: 9n },
    ]);
    const all = await request(makeApp(prisma, onDataChange)).get('/api/v1/business-profiles/').set(authHeader);
    expect(all.status).toBe(200);
    expect(all.body.profiles.map((p: any) => p.id)).toEqual(['P1', 'P2']); // 软删 P3 排除

    const filtered = await request(makeApp(prisma, onDataChange))
      .get('/api/v1/business-profiles/?kind=bank').set(authHeader);
    expect(filtered.body.profiles.map((p: any) => p.id)).toEqual(['P2']);
  });

  it('序列化：updatedAt/deletedAt 由 BigInt 转 number（BigInt 不可 JSON 化）', async () => {
    const prisma = makePrisma([{ id: 'P1', kind: 'k', name: 'n', updatedAt: 123n, deletedAt: null }]);
    const res = await request(makeApp(prisma, onDataChange)).get('/api/v1/business-profiles/').set(authHeader);
    expect(typeof res.body.profiles[0].updatedAt).toBe('number');
    expect(res.body.profiles[0].deletedAt).toBeNull();
  });

  it('POST / 缺 kind 或 name → 400 VALIDATION_FAILED（不落库）', async () => {
    const prisma = makePrisma();
    const noKind = await request(makeApp(prisma, onDataChange)).post('/api/v1/business-profiles/')
      .set(authHeader).send({ name: 'x' });
    expect(noKind.status).toBe(400);
    expect(noKind.body.error).toBe('VALIDATION_FAILED');

    const noName = await request(makeApp(prisma, onDataChange)).post('/api/v1/business-profiles/')
      .set(authHeader).send({ kind: 'exporter' });
    expect(noName.status).toBe(400);
    expect(prisma.businessProfile.upsert).not.toHaveBeenCalled();
  });

  it('POST / 正常 upsert → 200 + 触发 onDataChange；isActive 缺省 true', async () => {
    const prisma = makePrisma();
    const res = await request(makeApp(prisma, onDataChange)).post('/api/v1/business-profiles/')
      .set(authHeader).send({ id: 'BPROF-1', kind: 'exporter', name: '抬头', payload: { a: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe('BPROF-1');
    expect(res.body.profile.isActive).toBe(true);
    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'business-profiles', action: 'upsert' }),
    );
  });

  it('POST / 同 id 二次提交 → 走 update 分支（幂等更新，不新增行）', async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma, onDataChange);
    await request(app).post('/api/v1/business-profiles/')
      .set(authHeader).send({ id: 'BPROF-1', kind: 'exporter', name: '初版' });
    const second = await request(app).post('/api/v1/business-profiles/')
      .set(authHeader).send({ id: 'BPROF-1', kind: 'exporter', name: '改版' });
    expect(second.status).toBe(200);
    expect(second.body.profile.name).toBe('改版');
    expect(prisma._rows.length).toBe(1);
  });

  it('DELETE /:id → 软删（isActive=false + deletedAt），并触发 onDataChange', async () => {
    const prisma = makePrisma([{ id: 'P1', kind: 'k', name: 'n', updatedAt: 1n, deletedAt: null }]);
    const res = await request(makeApp(prisma, onDataChange)).delete('/api/v1/business-profiles/P1').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.profile.isActive).toBe(false);
    expect(res.body.profile.deletedAt).not.toBeNull();
    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'business-profiles', action: 'delete' }),
    );
  });

  it('API-Key 仅只读：POST → 401（写必须 JWT）', async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma, onDataChange, { injectJwt: false }); // 关闭 JWT 注入，仅持 API-Key
    const res = await request(app).post('/api/v1/business-profiles/')
      .set('X-Bambook-API-Key', validApiKey).send({ kind: 'exporter', name: 'x' });
    expect(res.status).toBe(401);
    expect(prisma.businessProfile.upsert).not.toHaveBeenCalled();

    // 对照：读操作持 API-Key 放行
    const read = await request(app).get('/api/v1/business-profiles/').set('X-Bambook-API-Key', validApiKey);
    expect(read.status).toBe(200);
  });
});
