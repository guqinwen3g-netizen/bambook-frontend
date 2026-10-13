/**
 * B261 · `ProductAsset.subCategoryId` 的存在性校验（写入侧一刀）
 *
 * 立账现场：数字档案里 3 件成衣的 `subCategoryId` 是字符串 `uncategorized`，
 * 而 `ProductSubCategory` 表里没有这一行 ⇒ "产品类别"视图没有任何一格承接它们。
 *
 * ★ 本批只补"给了 id 就必须存在"这一刀，**不动那枚哨兵**（`uncategorized` 沿用今天行为，
 *   读侧由 ProductsManager 的"未分类"分组承接）：
 *   一次性迁走所有写入点是另一件事，混进来会让"修一个悬空"变成"改四处行为"。
 *   所以第 3/6 格是把**不变**钉住 —— 有人以后偷偷把哨兵换成 null 而不同步读侧，这里会红。
 *
 * ★ 覆盖面（按落点扫 `subCategoryId` 的写入，不是按形状）：
 *   - 会落**库里不存在的值**的两处都已收口：本服务的建档/改档（这里）、
 *     前端左栏伪分类（`ProductsManager.payloadSubCategoryId`，另有用例）。
 *   - 不受本刀保护的写入点，逐条点名而不是含糊成"全仓已校验"：
 *     `pdml/route.ts` 同一事务里先 upsert 分类行（:385）⇒ 天然存在；
 *     `garmentDevelopmentService.ts:126` / `fabricDevelopmentService.ts:956` 直写 `'uncategorized'`
 *     字面量（绕过本服务）⇒ 值与哨兵一致所以不悬空，但**这两处以后写别的 id 不会被拦**。
 *
 * ★ 档位用**已登记**的 `VALIDATION_FAILED`（400），不新造码：
 *   本仓吃过"未登记的码被兜底成 500/400"的亏（台账 B25/B29 那一族），这里顺手把"码在表里"也钉上。
 */
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createProductAsset, updateProductAsset } from '../productAssetMutationService';
import { createProductsRouter } from '../route';
import { lookupErrorCode } from '../../shared/errorCodes';

const ACTOR = 'u-owner';

function makePrisma(subCategory: unknown) {
  const client: any = {
    productSubCategory: { findFirst: vi.fn(async () => subCategory) },
    productAsset: {
      findFirst: vi.fn(async () => ({ id: 'PROD-1', sku: 'S-1', name: 'N', mainCategory: 'Garment', deletedAt: null })),
      create: vi.fn(async ({ data }: any) => ({ id: 'PROD-1', ...data })),
      update: vi.fn(async ({ data }: any) => ({ id: 'PROD-1', ...data })),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => ({ id: 'AUD-1', ...data })) },
  };
  client.$transaction = async (fn: any) => fn(client);
  return client;
}

const bodyWith = (subCategoryId: unknown) => ({
  sku: 'GR-T-1', name: '测试款式', mainCategory: 'Garment', cost: '10.00', subCategoryId,
});

describe('createProductAsset：subCategoryId 存在性', () => {
  it('★ 用一个库里不存在的子分类建档 ⇒ 拒（400 档），且一行都没写', async () => {
    const p = makePrisma(null);
    await expect(createProductAsset({ prisma: p, body: bodyWith('SUB-DOES-NOT-EXIST'), actorId: ACTOR }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', statusCode: 400 });
    expect(p.productAsset.create).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });

  it('用的码必须在注册表里（不许"看着像 400 其实是兜底档"）', () => {
    const spec = lookupErrorCode('VALIDATION_FAILED');
    expect(spec, 'VALIDATION_FAILED 未登记 ⇒ 本刀的档位无从谈起').toBeTruthy();
    expect(spec!.status).toBe(400);
  });

  it('查询必须带 deletedAt:null（软删的子分类不算存在）', async () => {
    const p = makePrisma(null);
    await expect(createProductAsset({ prisma: p, body: bodyWith('SUB-1'), actorId: ACTOR })).rejects.toBeTruthy();
    const where = p.productSubCategory.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe('SUB-1');
    expect(where.deletedAt).toBeNull();
  });

  it('子分类真实存在 ⇒ 照常建档，值原样落库', async () => {
    const p = makePrisma({ id: 'SUB-1', name: '连衣裙', deletedAt: null });
    const r = await createProductAsset({ prisma: p, body: bodyWith('SUB-1'), actorId: ACTOR });
    expect(r.ok).toBe(true);
    expect(p.productAsset.create).toHaveBeenCalled();
    expect(p.productAsset.create.mock.calls[0][0].data.subCategoryId).toBe('SUB-1');
  });

  it('★ 空值/哨兵沿用今天的行为（本批刻意不迁那两处直写的 dev-services 写入点，改这格要先动读侧）', async () => {
    for (const raw of [undefined, '', '   ', 'uncategorized']) {
      const p = makePrisma(null);
      const r = await createProductAsset({ prisma: p, body: bodyWith(raw), actorId: ACTOR });
      expect(r.ok, `入参 ${JSON.stringify(raw)} 不该被拒`).toBe(true);
      expect(p.productAsset.create.mock.calls[0][0].data.subCategoryId).toBe('uncategorized');
      expect(p.productSubCategory.findFirst, '哨兵/空值不该去查库').not.toHaveBeenCalled();
    }
  });
});

describe('updateProductAsset：同一刀，且不误伤没动这一列的更新', () => {
  it('更新成不存在的子分类 ⇒ 拒，且不写', async () => {
    const p = makePrisma(null);
    await expect(updateProductAsset({ prisma: p, assetId: 'PROD-1', patch: { subCategoryId: 'SUB-NOPE' }, actorId: ACTOR }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', statusCode: 400 });
    expect(p.productAsset.update).not.toHaveBeenCalled();
  });

  it('★ 反向：没带 subCategoryId 的更新不应多打一次子分类查询（校验没被撒到无关写上）', async () => {
    const p = makePrisma({ id: 'SUB-1', name: '连衣裙', deletedAt: null });
    const r = await updateProductAsset({ prisma: p, assetId: 'PROD-1', patch: { name: '改名' }, actorId: ACTOR });
    expect(r.ok).toBe(true);
    expect(p.productSubCategory.findFirst).not.toHaveBeenCalled();
    expect(p.productAsset.update).toHaveBeenCalled();
  });
});

/**
 * ★ 档位证人（HTTP 层）：路由的 catch 会把异常交给 `safeRouteError`，
 *   所以"服务抛业务错"必须在响应上长成 **400 + 业务码 + 中文文案**，
 *   不能被兜底成 500（那正是本仓 B42 那一族反复修的"把用户输入错误答成服务器错误"）。
 */
describe('HTTP 层：POST /assets 用不存在的子分类 ⇒ 400，不是 500', () => {
  const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';

  function appWith(prisma: any) {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/products', createProductsRouter({
      prisma, requireAuth: false, apiKeys: new Set<string>(),
      uploadDir: '/tmp/b261-products-uploads', onDataChange: vi.fn(),
    } as any));
    return app;
  }

  it('响应体带 VALIDATION_FAILED / 状态 400 / 文案是给人看的中文', async () => {
    const p = makePrisma(null);
    const res = await request(appWith(p))
      .post('/api/v1/products/assets')
      .set('Authorization', `Bearer ${jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET)}`)
      .send({ sku: 'GR-H-1', name: 'HTTP 档', mainCategory: 'Garment', cost: '1.00', subCategoryId: 'SUB-NOPE' });
    expect(res.status, `响应体：${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(String(res.body.message)).toMatch(/子分类不存在/);
    expect(p.productAsset.create).not.toHaveBeenCalled();
  });

  it('反向对照：同一套替身、不带 subCategoryId ⇒ 必须仍然建成功（证明上一条红在身份/入参，不是路由本身坏了）', async () => {
    const p = makePrisma(null);
    const res = await request(appWith(p))
      .post('/api/v1/products/assets')
      .set('Authorization', `Bearer ${jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET)}`)
      .send({ sku: 'GR-H-2', name: 'HTTP 正向', mainCategory: 'Garment', cost: '1.00' });
    expect(res.status, `响应体：${JSON.stringify(res.body)}`).toBeLessThan(500);
    expect(p.productAsset.create).toHaveBeenCalled();
  });
});
