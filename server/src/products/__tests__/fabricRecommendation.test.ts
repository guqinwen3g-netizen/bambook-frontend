import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createFabricRecommendationRouter } from '../fabricRecommendationRoute';
import { scoreFabricCandidate, FabricCandidate } from '../fabricRecommendationService';

// ════════════════════════════════════════════════════════════════
// 打分纯函数
// ════════════════════════════════════════════════════════════════

const baseCandidate: FabricCandidate = {
  productAssetId: 'PA__1',
  sku: 'WV-24001',
  name: '羊毛精纺斜纹 240g',
  season: '2026AW',
  latestPrice: 13.5,
  priceCurrency: 'USD',
  priceBasis: { schemaVersion: 1, priceType: 'customer', audience: 'general', customerOrganizationId: null,
    sourcePriceId: 'FPH__1', sourceUpdatedAt: '200', amount: 13.5, currency: 'USD', unit: 'M' },
  weightValue: 240,
  weightUnit: 'g/m',
  pattern: 'twill',
  stockStatus: 'in stock',
  millName: '某毛纺厂',
  compositions: [{ term: '羊毛 Wool W', percentage: 100 }],
};

describe('P2c · scoreFabricCandidate 打分口径', () => {
  it('全条件命中：季节30 + 预算30 + 成分10 + 克重20 + 花型10 + 现货5 = 105', () => {
    const r = scoreFabricCandidate(baseCandidate, {
      season: '2026AW', budgetMin: 10, budgetMax: 15, currency: 'USD', budgetUnit: 'M',
      compositionKeywords: ['羊毛'], weightMin: 200, weightMax: 280, pattern: 'twill',
    });
    expect(r.score).toBe(105);
    expect(r.reasons.length).toBe(6);
  });

  it('预算边界外 20% 内 +15，更远 +0；币种不一致不参与预算打分', () => {
    const near = scoreFabricCandidate(baseCandidate, { budgetMin: 10, budgetMax: 12, budgetUnit: 'M' });
    expect(near.score).toBe(20); // 接近预算 15（13.5 ≤ 12 × 1.2 = 14.4）+ 现货 5
    expect(near.reasons[0]).toContain('接近预算');

    const far = scoreFabricCandidate(baseCandidate, { budgetMin: 10, budgetMax: 11, budgetUnit: 'M' });
    expect(far.score).toBe(5); // 预算 0（13.5 > 11 × 1.2 = 13.2）+ 现货 5

    const ccyMiss = scoreFabricCandidate({ ...baseCandidate, priceCurrency: 'CNY', priceBasis: { ...baseCandidate.priceBasis!, currency: 'CNY' } }, { budgetMin: 10, budgetMax: 15, currency: 'USD', budgetUnit: 'M' });
    expect(ccyMiss.score).toBe(5); // 币种不一致不参与预算打分，仅现货 5
  });

  it('成分关键词至多计 3 个（每词 +10）；无命中条件仅现货分（路由层不过滤现货分）', () => {
    const multi = scoreFabricCandidate(baseCandidate, { compositionKeywords: ['wool', '羊毛', 'W', 'cashmere'] });
    expect(multi.score).toBe(35); // 3 个关键词命中 30（达上限，cashmere 未命中）+ 现货 5
    const zero = scoreFabricCandidate({ ...baseCandidate, stockStatus: null }, { season: '2027SS' });
    expect(zero.score).toBe(0);
    expect(zero.reasons).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// 路由集成（mock prisma）
// ════════════════════════════════════════════════════════════════

function makeMockPrisma() {
  let seq = 0;
  const recommendations: any[] = [];
  const profiles: any[] = [
    {
      id: 'FP__1', productAssetId: 'PA__1', weightValue: 240, weightUnit: 'g/m',
      pattern: 'twill', stockStatus: 'in stock', millName: '某毛纺厂', deletedAt: null,
      productAsset: {
        id: 'PA__1', sku: 'WV-24001', name: '羊毛精纺斜纹 240g', season: '2026AW', deletedAt: null,
        fabricPrices: [
          { id: 'FPH__1', priceType: 'customer', customerOrganizationId: null, amount: 13.5, currency: 'USD', unit: 'M', updatedAt: 200n, deletedAt: null },
          { id: 'FPH__0', priceType: 'customer', customerOrganizationId: null, amount: 14.0, currency: 'USD', unit: 'M', updatedAt: 100n, deletedAt: null },
        ],
        compositionLines: [
          { id: 'FCL__1', percentage: 100, deletedAt: null, term: { chineseName: '羊毛', englishName: 'Wool', abbreviation: 'W', deletedAt: null } },
        ],
      },
    },
    {
      id: 'FP__2', productAssetId: 'PA__2', weightValue: 320, weightUnit: 'g/m',
      pattern: 'plain', stockStatus: null, millName: '另一厂', deletedAt: null,
      productAsset: {
        id: 'PA__2', sku: 'CT-11002', name: '棉府绸', season: '2026SS', deletedAt: null,
        fabricPrices: [{ id: 'FPH__2', priceType: 'customer', customerOrganizationId: null, amount: 4.2, currency: 'USD', unit: 'M', updatedAt: 100n, deletedAt: null }],
        compositionLines: [
          { id: 'FCL__2', percentage: 100, deletedAt: null, term: { chineseName: '棉', englishName: 'Cotton', abbreviation: 'C', deletedAt: null } },
        ],
      },
    },
    {
      // 已软删档案：不可入候选
      id: 'FP__3', productAssetId: 'PA__3', weightValue: 240, weightUnit: 'g/m',
      pattern: 'twill', stockStatus: 'in stock', millName: null, deletedAt: 1n,
      productAsset: {
        id: 'PA__3', sku: 'WV-DEL', name: '已删面料', season: '2026AW', deletedAt: null,
        fabricPrices: [], compositionLines: [],
      },
    },
  ];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        return true; // 嵌套 productAsset 过滤在 mock 中简化处理
      }
      return row[k] === v;
    });

  const fabricProfile = {
    findMany: async ({ where, include }: any = {}) =>
      profiles
        .filter(p => matchWhere(p, where))
        .filter(p => !where?.productAsset || p.productAsset.deletedAt === (where.productAsset.deletedAt?.not === null ? null : where.productAsset.deletedAt))
        .map(p => ({ ...p, productAsset: { ...p.productAsset, fabricPrices: p.productAsset.fabricPrices
          .filter((price: any) => matchWhere(price, include?.productAsset?.include?.fabricPrices?.where))
          .sort((a: any, b: any) => Number(b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)) } })),
  };

  const fabricRecommendation = {
    findUnique: async ({ where }: any) => recommendations.find(r => r.id === where.id) || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      let rows = recommendations.filter(r => matchWhere(r, where));
      if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => Number(b.createdAt - a.createdAt));
      return rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));
    },
    count: async ({ where }: any = {}) => recommendations.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `FR__T${++seq}` };
      recommendations.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = recommendations.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  return { fabricProfile, fabricRecommendation, _stores: { recommendations, profiles } };
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string, string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/fabric-recommendations', createFabricRecommendationRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

describe('P2c · fabric-recommendations 路由', () => {
  it('POST /recommend API-Key → 401（写必须 JWT）', async () => {
    const app = makeApp(makeMockPrisma());
    const res = await request(app)
      .post('/api/v1/fabric-recommendations/recommend')
      .set('x-bambook-api-key', validApiKey)
      .send({ season: '2026AW' });
    expect(res.status).toBe(401);
  });

  it('校验：空条件 → 400；预算下限>上限 → 400', async () => {
    const app = makeApp(makeMockPrisma());
    expect((await request(app).post('/api/v1/fabric-recommendations/recommend').set(auth()).send({})).status).toBe(400);
    const inverted = await request(app)
      .post('/api/v1/fabric-recommendations/recommend')
      .set(auth())
      .send({ budgetMin: 20, budgetMax: 10 });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.message).toContain('不可大于');
  });

  it('推荐：命中排序 + 理由可解释 + 快照落库；0 分候选被过滤；软删档案不入候选', async () => {
    const prisma = makeMockPrisma();
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/fabric-recommendations/recommend')
      .set(auth())
      .send({ season: '2026AW', compositionKeywords: ['羊毛'], weightMin: 200, weightMax: 280 });
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item.criteria.currency).toBe('USD');
    const results = item.results;
    expect(results.length).toBe(1); // PA__3 软删被过滤；PA__2 得 0 分被过滤
    expect(results[0].sku).toBe('WV-24001');
    expect(results[0].score).toBe(65); // 季节30 + 成分10 + 克重20 + 现货5
    expect(results[0].reasons.join(' ')).toContain('季节匹配');
    // 最新价取 updatedAt 最大者
    expect(results[0].latestPrice).toBe(13.5);
  });

  it('历史列表 + 详情 + 软删后 404', async () => {
    const app = makeApp(makeMockPrisma());
    const created = await request(app)
      .post('/api/v1/fabric-recommendations/recommend')
      .set(auth())
      .send({ pattern: 'twill' });
    const id = created.body.item.id;

    const list = await request(app).get('/api/v1/fabric-recommendations').set(auth());
    expect(list.body.total).toBe(1);

    const detail = await request(app).get(`/api/v1/fabric-recommendations/${id}`).set(auth());
    expect(detail.body.item.id).toBe(id);

    await request(app).delete(`/api/v1/fabric-recommendations/${id}`).set(auth());
    expect((await request(app).get(`/api/v1/fabric-recommendations/${id}`).set(auth())).status).toBe(404);
  });
});
