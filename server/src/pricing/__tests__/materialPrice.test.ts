import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const apiKeys = new Set(['test-key']);

import { createPricingRouter } from '../pricingRoute';

function makeMockPrisma() {
  let seq = 0;
  const materialPrices: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
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
        if (x[field] === y[field]) continue;
        return x[field] < y[field] ? (dir === 'desc' ? 1 : -1) : (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  };

  const materialPriceHistory = {
    findUnique: async ({ where }: any) => materialPrices.find(r => r.id === where.id) || null,
    findFirst: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(materialPrices.filter(r => matchWhere(r, where)), orderBy)[0] || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      const rows = applyOrderBy(materialPrices.filter(r => matchWhere(r, where)), orderBy);
      return rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));
    },
    count: async ({ where }: any = {}) => materialPrices.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { currency: 'CNY', source: 'manual', deletedAt: null, ...data, id: data.id || `MPH__T${++seq}` };
      materialPrices.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = materialPrices.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  // pricing 路由聚合的其余模型（本文件不触达）
  const noop = { findUnique: async () => null, findMany: async () => [], findFirst: async () => null, count: async () => 0 };

  return {
    materialPriceHistory,
    taxRefundRate: noop,
    exchangeRate: noop,
    pricingCalculation: noop,
    order: noop,
    invoice: noop,
    purchaseOrder: noop,
    shipment: noop,
    paymentVoucher: noop,
    orderProfitSheet: noop,
    _stores: { materialPrices },
  };
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

describe('P1 · MaterialPriceHistory', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createPrice = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/pricing/material-prices').set(auth()).send(body);

  it('创建校验：类型非法 / 价格 ≤0 / 日期格式非法 → 400；currency 归一化大写', async () => {
    const app = makeApp(prisma);
    const base = { materialType: 'fabric', name: '羊毛精纺', price: 45, unit: 'M', priceDate: '2026-08-01' };
    expect((await createPrice(app, { ...base, materialType: 'cotton' })).status).toBe(400);
    expect((await createPrice(app, { ...base, price: 0 })).status).toBe(400);
    expect((await createPrice(app, { ...base, priceDate: '2026/08/01' })).status).toBe(400);
    expect((await createPrice(app, { ...base, source: 'taobao' })).status).toBe(400);

    const ok = await createPrice(app, { ...base, materialCode: 'F1001', currency: 'cny' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.currency).toBe('CNY');
  });

  it('trend：时间升序 + 日期范围过滤；latest：priceDate 最新一条', async () => {
    const app = makeApp(prisma);
    await createPrice(app, { materialType: 'fabric', materialCode: 'F1001', name: '羊毛精纺', price: 45, unit: 'M', priceDate: '2026-06-01' });
    await createPrice(app, { materialType: 'fabric', materialCode: 'F1001', name: '羊毛精纺', price: 47, unit: 'M', priceDate: '2026-08-01' });
    await createPrice(app, { materialType: 'fabric', materialCode: 'F1001', name: '羊毛精纺', price: 46, unit: 'M', priceDate: '2026-07-01' });
    await createPrice(app, { materialType: 'yarn', materialCode: 'Y2001', name: '羊毛纱线', price: 120, unit: 'KG', priceDate: '2026-08-01' });

    const trend = await request(app)
      .get('/api/v1/pricing/material-prices/trend?materialType=fabric&materialCode=F1001')
      .set(auth());
    expect(trend.status).toBe(200);
    expect(trend.body.items.map((i: any) => i.priceDate)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);

    const ranged = await request(app)
      .get('/api/v1/pricing/material-prices/trend?materialType=fabric&materialCode=F1001&from=2026-07-01&to=2026-07-31')
      .set(auth());
    expect(ranged.body.items).toHaveLength(1);
    expect(ranged.body.items[0].price).toBe(46);

    const latest = await request(app)
      .get('/api/v1/pricing/material-prices/latest?materialType=fabric&materialCode=F1001')
      .set(auth());
    expect(latest.body.item.price).toBe(47);

    expect((await request(app).get('/api/v1/pricing/material-prices/latest?materialType=fabric').set(auth())).status).toBe(400);
    expect((await request(app).get('/api/v1/pricing/material-prices/trend?materialType=cotton').set(auth())).status).toBe(400);
  });

  it('软删后 trend/latest/list 均不可见', async () => {
    const app = makeApp(prisma);
    const created = await createPrice(app, { materialType: 'trimming', materialCode: 'T3001', name: '纽扣', price: 0.5, unit: 'PC', priceDate: '2026-08-01' });
    const id = created.body.item.id;

    await request(app).delete(`/api/v1/pricing/material-prices/${id}`).set(auth());
    const list = await request(app).get('/api/v1/pricing/material-prices?materialType=trimming').set(auth());
    expect(list.body.total).toBe(0);
    const latest = await request(app).get('/api/v1/pricing/material-prices/latest?materialType=trimming&materialCode=T3001').set(auth());
    expect(latest.body.item).toBeNull();
  });
});
