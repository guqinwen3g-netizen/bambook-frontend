/**
 * B42 A1（S0-A2 文案线）· products 域 12 处路由级直发的收敛守卫。
 *
 * 为什么逐个端点打，而不是"改完了 + 全量门禁绿"就算完：
 * 这 12 处的缺陷恰好是**六条既有判据全瞎**的那种形状（`message: String(e?.message ?? e)` 写在
 * 对象字面量里），所以"没有守卫变红"在这里**不构成任何证据**。唯一能证明"用户看到的不再是
 * 原始异常文本"的办法，是把每个端点真打一遍、看响应体。
 *
 * ★ 与 `domainErrorShapes.test.ts` 的关系（别误会成两支出题）：那支普查问的是
 *   "兜底码有没有登记进注册表"；本文件问的是"这个端点在这个异常下**实际**返了什么"。
 *   注册表里有条目而路由忘了接（例如回退成 `res.status(500).json({message: e.message})`），
 *   那支照样绿 —— 只有本文件会红。
 *
 * ⚠️ 未覆盖（如实记）：浏览器端真实渲染未验（无 UI 演练环境）；本文件测的是 catch 出口，
 *   不测每个端点的业务成功路径（那由 `route.test.ts` / `productImageAuditRoute.test.ts` 覆盖）。
 */
import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { lookupErrorCode } from '../../shared/errorCodes';
import { createProductsRouter } from '../route';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
/** 一段"只有数据库/驱动会说"的内部原文 —— 出现在响应体里就是本批要修的缺陷本身 */
const RAW_SENTINEL = 'PrismaClientKnownRequestError: P2010 connection terminated while touching ProductAsset';

const ROUTE_SRC = readFileSync(path.resolve(__dirname, '../route.ts'), 'utf-8');

/** 任意深度的 prisma 替身：碰到任何一次查询就**异步**抛内部原文（真 prisma 恒返 promise，同步 throw 会改变"错误在哪一帧被吞"）。 */
function throwingPrisma(): any {
  const p: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      // 不把它当 thenable，否则 await 一个代理会卡在这里而不是走到 catch
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      return p;
    },
    async apply() { throw new Error(RAW_SENTINEL); },
  });
  return p;
}

/** 上传端点的两种失败：外层 catch（productId 之前就炸）与事务 catch（审计写失败 ⇒ 回滚）。 */
function makeTxPrisma(auditFail: boolean): any {
  const prisma: any = {
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    auditLog: { create: auditFail ? vi.fn().mockRejectedValue(new Error(RAW_SENTINEL)) : vi.fn().mockResolvedValue({}) },
    productAsset: {
      findFirst: vi.fn().mockResolvedValue({ id: 'PROD-1', deletedAt: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    productImage: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'IMG-1', filePath: 'products/PROD-1/test.jpg', isPrimary: true }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue({ id: 'IMG-1', productAssetId: 'PROD-1', filePath: 'products/PROD-1/test.jpg', isPrimary: true, deletedAt: null }),
    },
  };
  return prisma;
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.headers.authorization = `Bearer ${ownerToken}`; next(); });
  app.use('/api/v1/products', createProductsRouter({
    prisma, requireAuth: false, apiKeys: new Set<string>(),
    uploadDir: '/tmp/b42-products-uploads', onDataChange: vi.fn(),
  } as any));
  return app;
}

type Case = { name: string; code: string; send: (app: express.Express) => Promise<any>; prisma?: 'wildcard' | 'auditFail' };

const CASES: Case[] = [
  { name: 'GET /assets 列表', code: 'PRODUCT_LIST_FAILED', send: (a) => request(a).get('/api/v1/products/assets') },
  { name: 'POST /fabric-exclusivity/check 预检', code: 'PRODUCT_EXCLUSIVITY_CHECK_FAILED', send: (a) => request(a).post('/api/v1/products/fabric-exclusivity/check').send({ fabricCode: 'F-1' }) },
  { name: 'POST /assets/query 查询', code: 'PRODUCT_QUERY_FAILED', send: (a) => request(a).post('/api/v1/products/assets/query').send({}) },
  { name: 'GET /assets/:id 详情', code: 'PRODUCT_DETAIL_FAILED', send: (a) => request(a).get('/api/v1/products/assets/PROD-1') },
  { name: 'POST /assets 建资产', code: 'PRODUCT_CREATE_FAILED', send: (a) => request(a).post('/api/v1/products/assets').send({ sku: 'S-1', name: 'N', mainCategory: 'fabric', cost: 12.34 }) },
  { name: 'PATCH /assets/:id 改资产', code: 'PRODUCT_UPDATE_FAILED', send: (a) => request(a).patch('/api/v1/products/assets/PROD-1').send({ name: 'N2' }) },
  { name: 'DELETE /assets/:id 删资产', code: 'PRODUCT_DELETE_FAILED', send: (a) => request(a).delete('/api/v1/products/assets/PROD-1') },
  { name: 'POST /assets/:id/images 外层 catch', code: 'PRODUCT_IMAGE_UPLOAD_FAILED', send: (a) => request(a).post('/api/v1/products/assets/PROD-1/images').attach('files', Buffer.from('fakeimg'), 't.jpg') },
  { name: 'POST /assets/:id/images 事务 catch（审计写失败）', code: 'PRODUCT_IMAGE_UPLOAD_FAILED', prisma: 'auditFail', send: (a) => request(a).post('/api/v1/products/assets/PROD-1/images').attach('files', Buffer.from('fakeimg'), 't.jpg') },
  { name: 'DELETE /assets/:id/images/:imageId 删图', code: 'PRODUCT_DELETE_FAILED', send: (a) => request(a).delete('/api/v1/products/assets/PROD-1/images/IMG-1') },
  { name: 'PATCH .../images/:imageId/primary 设主图', code: 'PRODUCT_UPDATE_FAILED', send: (a) => request(a).patch('/api/v1/products/assets/PROD-1/images/IMG-1/primary').send({}) },
  { name: 'PATCH .../images/reorder 排序', code: 'PRODUCT_UPDATE_FAILED', send: (a) => request(a).patch('/api/v1/products/assets/PROD-1/images/reorder').send({ orders: [{ id: 'IMG-1', sortOrder: 0 }] }) },
];

describe('B42 A1 · products 路由出口：12 处逐个打，响应体里不许有原始异常文本', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ 用例条数必须等于源码里的 safeRouteError 站点数（漏一条 = 这张表在假装覆盖全量）', () => {
    const sites = (ROUTE_SRC.match(/safeRouteError\(/g) ?? []).length;
    expect(sites, '源码站点数变了 ⇒ 同步本表（新增端点不许静默不测）').toBe(12);
    expect(CASES.length).toBe(sites);
  });

  for (const c of CASES) {
    it(`${c.name} ⇒ 500 + ${c.code} + 注册表那句中文`, async () => {
      const prisma = c.prisma === 'auditFail' ? makeTxPrisma(true) : throwingPrisma();
      const res = await c.send(makeApp(prisma));
      const body = JSON.stringify(res.body);
      expect(res.status, `${c.name} 的档位不对：${body}`).toBe(500);
      expect(res.body.error, `${c.name} 的码不对：${body}`).toBe(c.code);
      // 认的是注册表那一份，不在测试里重抄文案（重抄 = 第二套真源）
      expect(res.body.message).toBe(lookupErrorCode(c.code)!.message);
      expect(body, `${c.name} 把内部异常原文发给了用户`).not.toContain('P2010');
      expect(body).not.toContain('Prisma');
      expect(body).not.toContain('ProductAsset');
    });
  }

  // GET /assets 走的是 Promise.all([findMany, count]) —— 两个替身都得抛**同一个**业务错，
  // 否则 count 缺失会先抛出 TypeError，测的就不是"业务错透传"而是兜底那一支了。
  const rejectBoth = (err: Error) => ({
    productAsset: { findMany: vi.fn().mockRejectedValue(err), count: vi.fn().mockRejectedValue(err) },
  }) as any;

  it('★ 正向对照：带 code+statusCode 的业务错误原样透传（收敛不许把有意的中文提示换成兜底文案）', async () => {
    const res = await request(makeApp(rejectBoth(
      Object.assign(new Error('币种必填'), { code: 'CURRENCY_REQUIRED', statusCode: 400 }),
    ))).get('/api/v1/products/assets');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CURRENCY_REQUIRED');
    expect(res.body.message).toBe('币种必填');
  });

  it('★ 反向对照：注册表外的业务码仍认它自己的 statusCode、文案透传（钉住"码没登记"这条真实边界）', async () => {
    const unregistered = lookupErrorCode('SKU_LOCKED_BY_OTHER');
    expect(unregistered, '这枚码若被登记进注册表，本用例的前提（表外业务码）就消失了，必须改写').toBeUndefined();
    const res = await request(makeApp(rejectBoth(
      Object.assign(new Error('该品号已被锁定'), { code: 'SKU_LOCKED_BY_OTHER', statusCode: 409 }),
    ))).get('/api/v1/products/assets');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SKU_LOCKED_BY_OTHER');
    expect(res.body.message).toBe('该品号已被锁定');
  });
});
