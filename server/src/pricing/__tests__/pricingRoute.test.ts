import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createPricingRouter } from '../pricingRoute';

/**
 * Mock Prisma：内存存储 TaxRefundRate + ExchangeRate + PricingCalculation + Order。
 * 语义对齐真实 client 的本测试用到的子集。
 */
function makeMockPrisma() {
  let seq = 0;
  const taxRefundRates: any[] = [];
  const exchangeRates: any[] = [];
  const calculations: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('equals' in cond) return row[k] === cond.equals;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('gte' in cond && !(row[k] >= cond.gte)) return false;
        if ('lte' in cond && !(row[k] <= cond.lte)) return false;
        return true;
      }
      return row[k] === v;
    });

  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const orders_ = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((x, y) => {
      for (const o of orders_) {
        const [[field, dir]] = Object.entries(o) as [string, string][];
        const xv = x[field] ?? null;
        const yv = y[field] ?? null;
        if (xv === yv) continue;
        if (xv === null) return 1;
        if (yv === null) return -1;
        if (xv < yv) return dir === 'desc' ? 1 : -1;
        if (xv > yv) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };

  const taxRefundRate = {
    findUnique: async ({ where }: any) =>
      taxRefundRates.find(r => (where.id !== undefined ? r.id === where.id : r.hsCode === where.hsCode)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(taxRefundRates.filter(r => matchWhere(r, where)), orderBy),
    count: async ({ where }: any = {}) => taxRefundRates.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { description: null, isActive: true, deletedAt: null, ...data, id: data.id || `TRR__T${++seq}` };
      taxRefundRates.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = taxRefundRates.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const exchangeRate = {
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = applyOrderBy(exchangeRates.filter(r => matchWhere(r, where)), orderBy);
      return rows[0] || null;
    },
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(exchangeRates.filter(r => matchWhere(r, where)), orderBy),
  };

  const pricingCalculation = {
    findUnique: async ({ where }: any) => calculations.find(c => c.id === where.id) || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      const rows = applyOrderBy(calculations.filter(c => matchWhere(c, where)), orderBy);
      return rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));
    },
    count: async ({ where }: any = {}) => calculations.filter(c => matchWhere(c, where)).length,
    create: async ({ data }: any) => {
      const row = { status: 'Draft', commissionRate: 0, deletedAt: null, ...data, id: data.id || `PRC__T${++seq}` };
      calculations.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = calculations.find(c => c.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  return { taxRefundRate, exchangeRate, pricingCalculation, _stores: { taxRefundRates, exchangeRates, calculations } };
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
  app.use('/api/v1/pricing', createPricingRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

// ════════════════════════════════════════════════════════════════
// 守卫
// ════════════════════════════════════════════════════════════════

describe('P1 · pricing 守卫', () => {
  it('POST /tax-refund-rates API-Key → 401（写必须 JWT）', async () => {
    const app = makeApp(makeMockPrisma());
    const res = await request(app)
      .post('/api/v1/pricing/tax-refund-rates')
      .set('x-bambook-api-key', validApiKey)
      .send({ hsCode: '5112', rate: 13 });
    expect(res.status).toBe(401);
  });

  it('GET /tax-refund-rates API-Key → 401（W-C 权限收口：读端点挂 pricing:read scope 门，无 actor 的 API-Key 通道拒）', async () => {
    const app = makeApp(makeMockPrisma());
    const res = await request(app)
      .get('/api/v1/pricing/tax-refund-rates')
      .set('x-bambook-api-key', validApiKey);
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════
// 退税率表 CRUD + 最长前缀命中
// ════════════════════════════════════════════════════════════════

describe('P1 · TaxRefundRate CRUD + lookup', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createRate = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/pricing/tax-refund-rates').set(auth()).send(body);

  it('创建校验：hsCode 位数非法 / rate 超界 → 400；重复 hsCode → 400', async () => {
    const app = makeApp(prisma);
    expect((await createRate(app, { hsCode: '511', rate: 13 })).status).toBe(400);
    expect((await createRate(app, { hsCode: '5112', rate: 17 })).status).toBe(400);
    expect((await createRate(app, { hsCode: '5112', rate: -1 })).status).toBe(400);

    const ok = await createRate(app, { hsCode: '5112', rate: 13, description: '羊毛精纺面料' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.hsCode).toBe('5112');

    const dup = await createRate(app, { hsCode: '5112', rate: 16 });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('已存在');
  });

  it('lookup：最长前缀命中（10 位命中 4 位注册项），无命中返回 null', async () => {
    const app = makeApp(prisma);
    await createRate(app, { hsCode: '51', rate: 13 });
    await createRate(app, { hsCode: '5112', rate: 16 });
    await createRate(app, { hsCode: '6203', rate: 13 });

    const hit10 = await request(app).get('/api/v1/pricing/tax-refund-rates/lookup?hsCode=5112110000').set(auth());
    expect(hit10.status).toBe(200);
    expect(hit10.body.hit).toEqual({ hsCode: '5112', rate: 16 });

    const hit2 = await request(app).get('/api/v1/pricing/tax-refund-rates/lookup?hsCode=5199').set(auth());
    expect(hit2.body.hit).toEqual({ hsCode: '51', rate: 13 });

    const miss = await request(app).get('/api/v1/pricing/tax-refund-rates/lookup?hsCode=999999').set(auth());
    expect(miss.body.hit).toBeNull();

    expect((await request(app).get('/api/v1/pricing/tax-refund-rates/lookup').set(auth())).status).toBe(400);
  });

  it('更新：hsCode 不可改 → 400；rate 可改；软删后不再命中 lookup', async () => {
    const app = makeApp(prisma);
    const created = await createRate(app, { hsCode: '6203', rate: 13 });
    const id = created.body.item.id;

    const badPatch = await request(app).patch(`/api/v1/pricing/tax-refund-rates/${id}`).set(auth()).send({ hsCode: '6204' });
    expect(badPatch.status).toBe(400);

    const okPatch = await request(app).patch(`/api/v1/pricing/tax-refund-rates/${id}`).set(auth()).send({ rate: 16 });
    expect(okPatch.status).toBe(200);
    expect(okPatch.body.item.rate).toBe(16);

    await request(app).delete(`/api/v1/pricing/tax-refund-rates/${id}`).set(auth());
    const lookup = await request(app).get('/api/v1/pricing/tax-refund-rates/lookup?hsCode=6203').set(auth());
    expect(lookup.body.hit).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// 轨道 B 试算（PRD 8.2 示例口径）
// ════════════════════════════════════════════════════════════════

describe('P1 · 轨道 B track-b-preview', () => {
  it('PRD 8.2 示例：¥80 / 退 13% / 汇率 7.2 / 利 25% / E10 → $13.06', async () => {
    const app = makeApp(makeMockPrisma());
    const res = await request(app)
      .post('/api/v1/pricing/track-b-preview')
      .set(auth())
      .send({ purchaseCostCny: 80, refundRate: 13, exchangeRate: 7.2, profitMargin: 25, commissionRate: 10 });
    expect(res.status).toBe(200);
    expect(res.body.netUsdCost).toBeCloseTo(9.6667, 3);
    expect(res.body.profitAmount).toBeCloseTo(2.4167, 3);
    expect(res.body.commissionAmount).toBeCloseTo(0.9667, 3);
    expect(res.body.finalUnitPrice).toBeCloseTo(13.05, 1);
  });

  it('校验：佣金率任意百分比 0-100（J2，7.5% 合法）；超界 / 汇率 ≤ 0 / 退税率超 16% → 400', async () => {
    const app = makeApp(makeMockPrisma());
    const base = { purchaseCostCny: 80, refundRate: 13, exchangeRate: 7.2, profitMargin: 25 };
    const custom = await request(app).post('/api/v1/pricing/track-b-preview').set(auth()).send({ ...base, commissionRate: 7.5 });
    expect(custom.status).toBe(200);
    expect(custom.body.commissionAmount).toBeCloseTo(9.6667 * 0.075, 3);
    expect((await request(app).post('/api/v1/pricing/track-b-preview').set(auth()).send({ ...base, commissionRate: -1 })).status).toBe(400);
    expect((await request(app).post('/api/v1/pricing/track-b-preview').set(auth()).send({ ...base, commissionRate: 101 })).status).toBe(400);
    expect((await request(app).post('/api/v1/pricing/track-b-preview').set(auth()).send({ ...base, exchangeRate: 0 })).status).toBe(400);
    expect((await request(app).post('/api/v1/pricing/track-b-preview').set(auth()).send({ ...base, refundRate: 20 })).status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════
// PricingCalculation：派生值服务端重算 + 默认值填充
// ════════════════════════════════════════════════════════════════

describe('P1 · PricingCalculation', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._stores.taxRefundRates.push(
      { id: 'TRR__1', hsCode: '5112', rate: 13, isActive: true, deletedAt: null },
    );
    prisma._stores.exchangeRates.push(
      { id: 'FXR__1', currency: 'USD', rate: 7.2, effectiveDate: '2026-08-08', createdAt: 1n },
    );
  });

  it('创建：退税率按 hsCode 命中、汇率取最新 USD；客户端传入派生值被忽略并重算', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({
        purchaseCostCny: 80, profitMargin: 25, commissionRate: 5, hsCode: '5112110000',
        // 客户端伪造派生值（必须被服务端覆盖）
        netUsdCost: 999, profitAmount: 999, commissionAmount: 999, finalUnitPrice: 999,
      });
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item.refundRate).toBe(13); // 5112 最长前缀命中
    expect(item.exchangeRate).toBe(7.2); // 最新 USD
    expect(item.netUsdCost).toBeCloseTo(9.6667, 3);
    expect(item.finalUnitPrice).not.toBe(999);
    expect(item.finalUnitPrice).toBeCloseTo(9.6667 * 1.25 + 9.6667 * 0.05, 2);
  });

  it('J1 归属：创建携带订单/报价单/产品关联并落库；列表可按 orderId/quotationId 过滤；PATCH 可改关联', async () => {
    const app = makeApp(prisma);
    const res = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({
        purchaseCostCny: 80, refundRate: 13, exchangeRate: 7.2, profitMargin: 25,
        orderId: 'ORD__1', quotationId: 'QUO__1', productAssetId: 'PA__1',
      });
    expect(res.status).toBe(201);
    expect(res.body.item.orderId).toBe('ORD__1');
    expect(res.body.item.quotationId).toBe('QUO__1');
    expect(res.body.item.productAssetId).toBe('PA__1');

    // 无关联记录不应被 orderId 过滤命中
    await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({ purchaseCostCny: 100, refundRate: 13, exchangeRate: 7.0, profitMargin: 20 });

    const byOrder = await request(app).get('/api/v1/pricing/calculations?orderId=ORD__1').set(auth());
    expect(byOrder.body.total).toBe(1);
    expect(byOrder.body.items[0].orderId).toBe('ORD__1');
    const byQuotation = await request(app).get('/api/v1/pricing/calculations?quotationId=QUO__1').set(auth());
    expect(byQuotation.body.total).toBe(1);

    const patched = await request(app)
      .patch(`/api/v1/pricing/calculations/${res.body.item.id}`)
      .set(auth())
      .send({ orderId: 'ORD__2', productAssetId: null });
    expect(patched.status).toBe(200);
    expect(patched.body.item.orderId).toBe('ORD__2');
    expect(patched.body.item.productAssetId).toBeNull();
    expect(patched.body.item.quotationId).toBe('QUO__1'); // 未传字段保持不变
  });

  it('创建：hsCode 无映射且未传 refundRate → 400；无汇率记录且未传 exchangeRate → 400', async () => {
    const app = makeApp(prisma);
    const noMap = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({ purchaseCostCny: 80, profitMargin: 25, hsCode: '9999' });
    expect(noMap.status).toBe(400);
    expect(noMap.body.error.message).toContain('无退税率映射');

    // 清空汇率记录
    prisma._stores.exchangeRates.length = 0;
    const noFx = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({ purchaseCostCny: 80, profitMargin: 25, refundRate: 13 });
    expect(noFx.status).toBe(400);
    expect(noFx.body.error.message).toContain('汇率缺失');
  });

  it('更新：修改利润率触发重算；Archived 不可修改；软删后列表不可见', async () => {
    const app = makeApp(prisma);
    const created = await request(app)
      .post('/api/v1/pricing/calculations')
      .set(auth())
      .send({ purchaseCostCny: 100, refundRate: 13, exchangeRate: 7.0, profitMargin: 20 });
    const id = created.body.item.id;
    const before = created.body.item.finalUnitPrice;

    const patched = await request(app)
      .patch(`/api/v1/pricing/calculations/${id}`)
      .set(auth())
      .send({ profitMargin: 30 });
    expect(patched.status).toBe(200);
    expect(patched.body.item.finalUnitPrice).toBeGreaterThan(before);

    await request(app).patch(`/api/v1/pricing/calculations/${id}`).set(auth()).send({ status: 'Archived' });
    const blocked = await request(app)
      .patch(`/api/v1/pricing/calculations/${id}`)
      .set(auth())
      .send({ profitMargin: 40 });
    expect(blocked.status).toBe(400);

    await request(app).delete(`/api/v1/pricing/calculations/${id}`).set(auth());
    const list = await request(app).get('/api/v1/pricing/calculations').set(auth());
    expect(list.body.total).toBe(0);
  });
});
