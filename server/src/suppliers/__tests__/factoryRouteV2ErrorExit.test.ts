/**
 * §9 B22 第 4 域 · `suppliers/factoryRouteV2.ts`（19 处）收敛后的**执行**覆盖
 *
 * 与 seasons 族同一情形（D36：已废弃、前端零消费、但仍挂载）⇒ 共享一条文案，不逐端点精修；
 * 「零消费」这条声称的守卫在 `shared/__tests__/deprecatedV2Surface.test.ts`，本文件只管**行为**：
 *   ① 未预期异常 ⇒ 500 + `INTERNAL_ERROR` + 中文文案，且响应体里**没有任何内部细节**；
 *   ② 业务错误（自带 code+statusCode）⇒ 认它自己的档位与文案（G6.5，不再一律 500）；
 *   ③ 无凭据 ⇒ 401（收敛没绕过守卫）。
 * 判据是外部口径（RFC 9110 + G6.5），不是"实现现在答什么"。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { createSuppliersV2Router } from '../factoryRouteV2';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const readToken = jwt.sign({ userId: 'u_r', roles: ['viewer'], permissions: ['suppliers:read'] }, SECRET);

const RAW = 'PrismaClientKnownRequestError: Invalid `prisma.supplierProfile.findMany()` invocation in /srv/app/server/src/suppliers/factoryRouteV2.ts:52 — table `SupplierProfile` does not exist';

/** 任何 prisma.<model>.<method>() 都抛内部原文 —— 只用来构造"服务层炸了"这一可达输入 */
function angryPrisma(error: Error): any {
  return new Proxy({}, {
    get: () => new Proxy({}, { get: () => () => Promise.reject(error) }),
  });
}

function appWith(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/suppliers', createSuppliersV2Router({ prisma, requireAuth: true, apiKeys: new Set() }));
  return app;
}

describe('B22 · suppliers V2 出口：内部原文不上屏', () => {
  it('GET /（供应商列表）服务层炸 → 500 + INTERNAL_ERROR + 中文可行动文案 + 零内部细节', async () => {
    const res = await request(appWith(angryPrisma(new Error(RAW))))
      .get('/api/v2/suppliers').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
    const body = JSON.stringify(res.body);
    for (const frag of ['PrismaClient', 'prisma.supplierProfile', 'factoryRouteV2.ts', 'does not exist', '/srv/app']) {
      expect(body, `响应体不应出现内部细节「${frag}」`).not.toContain(frag);
    }
    expect(res.body.message).toMatch(/[一-龥]/);
    expect(res.body.message).toContain('未确认任何改动');
    expect(res.body.message).toContain('供应商');
  });

  it('业务错误（自带 code + statusCode 404）→ 认它自己的档位与文案，不被兜底吞成 500', async () => {
    const res = await request(appWith(angryPrisma(
      Object.assign(new Error('供应商不存在或已被删除'), { code: 'SUPPLIER_NOT_FOUND', statusCode: 404 }),
    ))).get('/api/v2/suppliers').set('Authorization', `Bearer ${readToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SUPPLIER_NOT_FOUND');
    expect(res.body.message).toBe('供应商不存在或已被删除');
  });

  it('无凭据 → 401（守卫仍在最前面；401 响应体也不带原文）', async () => {
    const res = await request(appWith(angryPrisma(new Error(RAW)))).get('/api/v2/suppliers');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('PrismaClient');
  });
});
