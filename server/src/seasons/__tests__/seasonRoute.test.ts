import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createSeasonRouter } from '../seasonRoute';

/**
 * Mock Prisma：内存存储 H2 五个模型 + Order + Relation + FabricProfile/ProductAsset。
 * 语义对齐真实 client 的本测试用到的子集（软删过滤、关系 include、关系 where、$transaction 直通）。
 */
function makeMockPrisma() {
  let seq = 0;
  const seasons: any[] = [];
  const trendTags: any[] = [];
  const trendTagFabrics: any[] = [];
  const tradeShows: any[] = [];
  const tradeShowLeads: any[] = [];
  const orders: any[] = [];
  const relations: any[] = [];
  const fabricProfiles: any[] = [];
  const productAssets: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as any[]).some(sub => matchWhere(row, sub));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('equals' in cond) {
          return cond.mode === 'insensitive'
            ? String(row[k] ?? '').toLowerCase() === String(cond.equals).toLowerCase()
            : row[k] === cond.equals;
        }
        if ('contains' in cond) return String(row[k] || '').toLowerCase().includes(String(cond.contains).toLowerCase());
        if ('lt' in cond && !(row[k] < cond.lt)) return false;
        if ('lte' in cond && !(row[k] <= cond.lte)) return false;
        if ('gt' in cond && !(row[k] > cond.gt)) return false;
        if ('gte' in cond && !(row[k] >= cond.gte)) return false;
        return true;
      }
      return row[k] === v;
    });

  const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const [[field, dir]] = Object.entries(orderBy);
    return [...rows].sort((x, y) => {
      const xv = x[field] ?? null;
      const yv = y[field] ?? null;
      if (xv === yv) return 0;
      if (xv === null) return 1;
      if (yv === null) return -1;
      return dir === 'desc' ? (xv < yv ? 1 : -1) : (xv > yv ? 1 : -1);
    });
  };

  const applyTakeSkip = (rows: any[], take?: number, skip?: number) =>
    rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));

  const attachFabric = (f: any) =>
    f ? { ...f, productAsset: productAssets.find(p => p.id === f.productAssetId) || null } : null;

  const season = {
    findUnique: async ({ where, include }: any) => {
      const row = seasons.find(s => (where.id !== undefined ? s.id === where.id : s.code === where.code));
      if (!row) return null;
      if (!include) return row;
      const out: any = { ...row };
      if (include.trendTags) {
        out.trendTags = trendTags.filter(t =>
          t.seasonId === row.id && (include.trendTags.where?.deletedAt === null ? t.deletedAt === null : true));
      }
      if (include.tradeShows) {
        out.tradeShows = tradeShows.filter(s =>
          s.seasonId === row.id && (include.tradeShows.where?.deletedAt === null ? s.deletedAt === null : true));
      }
      return out;
    },
    findMany: async ({ where, orderBy, take, skip }: any = {}) =>
      applyTakeSkip(applyOrderBy(seasons.filter(s => matchWhere(s, where)), orderBy), take, skip),
    count: async ({ where }: any = {}) => seasons.filter(s => matchWhere(s, where)).length,
    create: async ({ data }: any) => {
      const row = { deletedAt: null, reviewJson: null, reviewedAt: null, ...data, id: data.id || `SEAS__T${++seq}` };
      seasons.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = seasons.find(s => s.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const trendTag = {
    findUnique: async ({ where }: any) => trendTags.find(t => t.id === where.id) || null,
    findMany: async ({ where, include, orderBy }: any = {}) =>
      applyOrderBy(trendTags.filter(t => matchWhere(t, where)), orderBy).map(t => {
        if (!include) return t;
        const out: any = { ...t };
        if (include.fabricLinks) {
          out.fabricLinks = trendTagFabrics
            .filter(l => l.trendTagId === t.id)
            .map(l => ({ ...l, fabric: attachFabric(fabricProfiles.find(f => f.id === l.fabricId) || null) }));
        }
        if (include.tradeShow) out.tradeShow = tradeShows.find(s => s.id === t.tradeShowId) || null;
        return out;
      }),
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `TRDT__T${++seq}` };
      trendTags.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = trendTags.find(t => t.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const trendTagFabric = {
    findFirst: async ({ where }: any) =>
      trendTagFabrics.find(l =>
        (where.trendTagId === undefined || l.trendTagId === where.trendTagId) &&
        (where.fabricId === undefined || l.fabricId === where.fabricId)) || null,
    findMany: async ({ where, include, orderBy }: any = {}) => {
      const rows = trendTagFabrics.filter(l => {
        if (where?.trendTag) {
          const tag = trendTags.find(t => t.id === l.trendTagId);
          if (!tag) return false;
          if (where.trendTag.deletedAt === null && tag.deletedAt !== null) return false;
          if (where.trendTag.seasonId !== undefined && tag.seasonId !== where.trendTag.seasonId) return false;
        }
        if (where?.fabric?.deletedAt === null) {
          const f = fabricProfiles.find(x => x.id === l.fabricId);
          if (!f || f.deletedAt !== null) return false;
        }
        return true;
      });
      return applyOrderBy(rows, orderBy).map(l => {
        if (!include) return l;
        return {
          ...l,
          trendTag: include.trendTag ? trendTags.find(t => t.id === l.trendTagId) || null : undefined,
          fabric: include.fabric ? attachFabric(fabricProfiles.find(f => f.id === l.fabricId) || null) : undefined,
        };
      });
    },
    create: async ({ data }: any) => {
      const row = { ...data, id: data.id || `TRTF__T${++seq}` };
      trendTagFabrics.push(row);
      return row;
    },
    delete: async ({ where }: any) => {
      const i = trendTagFabrics.findIndex(l => l.id === where.id);
      if (i < 0) throw new Error('not found');
      const [r] = trendTagFabrics.splice(i, 1);
      return r;
    },
  };

  const tradeShow = {
    findUnique: async ({ where, include }: any) => {
      const row = tradeShows.find(s => s.id === where.id);
      if (!row) return null;
      if (!include) return row;
      const out: any = { ...row };
      if (include.leads) {
        out.leads = tradeShowLeads.filter(l =>
          l.tradeShowId === row.id && (include.leads.where?.deletedAt === null ? l.deletedAt === null : true));
      }
      return out;
    },
    findMany: async ({ where, orderBy, take }: any = {}) =>
      applyTakeSkip(applyOrderBy(tradeShows.filter(s => matchWhere(s, where)), orderBy), take),
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `TRDS__T${++seq}` };
      tradeShows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = tradeShows.find(s => s.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const tradeShowLead = {
    findUnique: async ({ where }: any) => tradeShowLeads.find(l => l.id === where.id) || null,
    findMany: async ({ where }: any = {}) => tradeShowLeads.filter(l => matchWhere(l, where)),
    create: async ({ data }: any) => {
      const row = { deletedAt: null, convertedRelationId: null, convertedAt: null, ...data, id: data.id || `TRDL__T${++seq}` };
      tradeShowLeads.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = tradeShowLeads.find(l => l.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const order = {
    findMany: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)),
  };

  const relation = {
    findUnique: async ({ where }: any) => relations.find(r => r.id === where.id) || null,
  };

  const fabricProfile = {
    findUnique: async ({ where }: any) => fabricProfiles.find(f => f.id === where.id) || null,
  };

  const tx = {
    season, trendTag, trendTagFabric, tradeShow, tradeShowLead, order, relation, fabricProfile,
  };

  return {
    ...tx,
    $transaction: async (fn: any) => fn(tx),
    _stores: { seasons, trendTags, trendTagFabrics, tradeShows, tradeShowLeads, orders, relations, fabricProfiles, productAssets },
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
  app.use('/api/v1/seasons', createSeasonRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

async function createSeason(app: any, overrides: Record<string, any> = {}) {
  const res = await request(app).post('/api/v1/seasons').set(auth()).send({
    code: 'SS26', name: '2026 春夏', startDate: '2026-01-01', endDate: '2026-06-30', ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.item;
}

async function createTradeShow(app: any, overrides: Record<string, any> = {}) {
  const res = await request(app).post('/api/v1/seasons/shows').set(auth()).send({
    name: 'Intertextile 上海面辅料展', startDate: '2026-03-11', ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.item;
}

async function createTrendTag(app: any, overrides: Record<string, any> = {}) {
  const res = await request(app).post('/api/v1/seasons/trends').set(auth()).send({
    type: 'fabric', name: '环保再生面料', ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.item;
}

async function addLead(app: any, showId: string, overrides: Record<string, any> = {}) {
  const res = await request(app).post(`/api/v1/seasons/shows/${showId}/leads`).set(auth()).send({
    customerName: '张三', ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.item;
}

describe('H2 · Season 季度 CRUD', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('POST / 创建季度：code 归一化大写；calendar 数组原样存；列表按 startDate 降序', async () => {
    const app = makeApp(prisma);
    const s1 = await createSeason(app, {
      code: 'ss26',
      calendar: [{ key: 'dev', label: '开发', startDate: '2026-01-01', endDate: '2026-02-01' }],
    });
    expect(s1.code).toBe('SS26');
    expect(s1.status).toBe('Planning');
    expect(s1.calendar).toHaveLength(1);
    await createSeason(app, { code: 'AW26', name: '2026 秋冬', startDate: '2026-07-01', endDate: '2026-12-31' });

    const list = await request(app).get('/api/v1/seasons').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].code).toBe('AW26'); // startDate 降序
  });

  it('code 格式非法 / 重复 / 缺必填 / 日期倒置 → 400', async () => {
    const app = makeApp(prisma);
    await createSeason(app);
    const badFmt = await request(app).post('/api/v1/seasons').set(auth()).send({ code: '2026SS', name: 'x', startDate: '2026-01-01', endDate: '2026-06-30' });
    expect(badFmt.status).toBe(400);
    const dup = await request(app).post('/api/v1/seasons').set(auth()).send({ code: 'SS26', name: 'x', startDate: '2026-01-01', endDate: '2026-06-30' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('季度代码已存在');
    const noName = await request(app).post('/api/v1/seasons').set(auth()).send({ code: 'AW26', startDate: '2026-07-01', endDate: '2026-12-31' });
    expect(noName.status).toBe(400);
    const inverted = await request(app).post('/api/v1/seasons').set(auth()).send({ code: 'AW26', name: 'x', startDate: '2026-12-31', endDate: '2026-01-01' });
    expect(inverted.status).toBe(400);
  });

  it('GET / search 匹配 code/name（不区分大小写）；status 过滤', async () => {
    const app = makeApp(prisma);
    await createSeason(app);
    await createSeason(app, { code: 'AW26', name: '2026 秋冬', startDate: '2026-07-01', endDate: '2026-12-31', status: 'Active' });
    const byCode = await request(app).get('/api/v1/seasons?search=ss26').set(auth());
    expect(byCode.body.total).toBe(1);
    expect(byCode.body.items[0].code).toBe('SS26');
    const byName = await request(app).get('/api/v1/seasons?search=秋冬').set(auth());
    expect(byName.body.total).toBe(1);
    const byStatus = await request(app).get('/api/v1/seasons?status=Active').set(auth());
    expect(byStatus.body.total).toBe(1);
    expect(byStatus.body.items[0].code).toBe('AW26');
  });

  it('GET /:id 含 trendTags/tradeShows；PATCH 白名单 + code 不可修改；DELETE 软删后 404', async () => {
    const app = makeApp(prisma);
    const s = await createSeason(app);
    await createTrendTag(app, { seasonId: s.id });
    await createTradeShow(app, { seasonId: s.id });

    const detail = await request(app).get(`/api/v1/seasons/${s.id}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.item.trendTags).toHaveLength(1);
    expect(detail.body.item.tradeShows).toHaveLength(1);

    const patched = await request(app).patch(`/api/v1/seasons/${s.id}`).set(auth()).send({ status: 'Active', notes: '主推针织' });
    expect(patched.status).toBe(200);
    expect(patched.body.item.status).toBe('Active');
    expect(patched.body.item.notes).toBe('主推针织');

    const codePatch = await request(app).patch(`/api/v1/seasons/${s.id}`).set(auth()).send({ code: 'AW26' });
    expect(codePatch.status).toBe(400);
    expect(codePatch.body.error.message).toContain('不可修改');
    const badStatus = await request(app).patch(`/api/v1/seasons/${s.id}`).set(auth()).send({ status: 'Archived' });
    expect(badStatus.status).toBe(400);

    const del = await request(app).delete(`/api/v1/seasons/${s.id}`).set(auth());
    expect(del.status).toBe(200);
    const gone = await request(app).get(`/api/v1/seasons/${s.id}`).set(auth());
    expect(gone.status).toBe(404);
  });

  it('写操作仅 API-Key → 401（JWT 强制）', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/seasons').set('x-bambook-api-key', validApiKey).send({
      code: 'SS26', name: '2026 春夏', startDate: '2026-01-01', endDate: '2026-06-30',
    });
    expect(res.status).toBe(401);
  });
});

describe('H2 · 季度回顾（PRD 14.1 聚合口径）', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('POST /:id/review 聚合订单：接单量/出货量/收入/成本/毛利/topCustomers；快照落 reviewJson', async () => {
    const app = makeApp(prisma);
    const s = await createSeason(app); // SS26
    prisma._stores.orders.push(
      // ★ 订单金额真源 = totalNet（≡ Σ明细行；Kevin 2026-09-18 拍板「以明细行为准」）
      //   totalNet 优先于 quoteAmount；status=Shipped 计入出货
      { id: 'O1', customer: 'Alpha', status: 'Shipped', season: 'SS26', shipmentDate: null, totalNet: 100, contractAmount: 100, quoteAmount: 90, supplierInvoiceAmount: 60, deletedAt: null },
      // season 小写不敏感匹配；shipmentDate 非空计入出货
      { id: 'O2', customer: 'Alpha', status: 'Confirmed', season: 'ss26', shipmentDate: '2026-05-01', totalNet: 200, contractAmount: null, quoteAmount: 200, supplierInvoiceAmount: null, deletedAt: null },
      // 未出运：状态与 shipmentDate 均不满足
      { id: 'O3', customer: 'Beta', status: 'Draft', season: 'SS26', shipmentDate: null, totalNet: 50, contractAmount: null, quoteAmount: 50, supplierInvoiceAmount: null, deletedAt: null },
      // 其他季度不计入
      { id: 'O4', customer: 'Alpha', status: 'Shipped', season: 'AW26', shipmentDate: '2026-01-01', totalNet: 999, contractAmount: 999, quoteAmount: 999, supplierInvoiceAmount: 1, deletedAt: null },
      // 已软删不计入
      { id: 'O5', customer: 'Alpha', status: 'Shipped', season: 'SS26', shipmentDate: '2026-02-01', totalNet: 777, contractAmount: 777, quoteAmount: 777, supplierInvoiceAmount: 7, deletedAt: BigInt(Date.now()) },
    );

    // 无快照时 GET review → null
    const before = await request(app).get(`/api/v1/seasons/${s.id}/review`).set(auth());
    expect(before.status).toBe(200);
    expect(before.body.review).toBeNull();

    const res = await request(app).post(`/api/v1/seasons/${s.id}/review`).set(auth());
    expect(res.status).toBe(200);
    const r = res.body.review;
    expect(r.code).toBe('SS26');
    expect(r.orderCount).toBe(3);
    expect(r.shippedCount).toBe(2);
    expect(r.revenue).toBe(350); // 100 + 200 + 50
    expect(r.cost).toBe(60);
    expect(r.grossProfit).toBe(290);
    expect(r.topCustomers).toHaveLength(2);
    expect(r.topCustomers[0]).toEqual({ customer: 'Alpha', orderCount: 2, revenue: 300 });
    expect(r.topCustomers[1]).toEqual({ customer: 'Beta', orderCount: 1, revenue: 50 });
    expect(r.generatedAt).toBeGreaterThan(0);

    // 快照已写入，GET 直接返回
    const after = await request(app).get(`/api/v1/seasons/${s.id}/review`).set(auth());
    expect(after.body.review.orderCount).toBe(3);
    expect(after.body.review.grossProfit).toBe(290);
  });

  it('季度不存在 → POST review 404', async () => {
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/seasons/SEAS__NOPE/review').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('H2 · TrendTag 趋势标签与趋势面料', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  function seedFabric(prisma: any, id: string, deleted = false) {
    prisma._stores.productAssets.push({ id: `PA_${id}`, deletedAt: null });
    prisma._stores.fabricProfiles.push({ id, productAssetId: `PA_${id}`, articleNo: `ART-${id}`, deletedAt: deleted ? BigInt(Date.now()) : null });
  }

  it('趋势 CRUD：type 封闭集校验；seasonId 必须存在；按 seasonId/type 过滤', async () => {
    const app = makeApp(prisma);
    const s = await createSeason(app);

    const badType = await request(app).post('/api/v1/seasons/trends').set(auth()).send({ type: 'hack', name: 'x' });
    expect(badType.status).toBe(400);
    const noSeason = await request(app).post('/api/v1/seasons/trends').set(auth()).send({ type: 'fabric', name: 'x', seasonId: 'SEAS__NOPE' });
    expect(noSeason.status).toBe(404);

    const tag = await createTrendTag(app, { seasonId: s.id, description: 'GRS 认证优先' });
    expect(tag.source).toBe('manual');
    await createTrendTag(app, { type: 'color', name: '大地色系' });

    const all = await request(app).get('/api/v1/seasons/trends').set(auth());
    expect(all.body.total).toBe(2);
    const bySeason = await request(app).get(`/api/v1/seasons/trends?seasonId=${s.id}`).set(auth());
    expect(bySeason.body.total).toBe(1);
    const byType = await request(app).get('/api/v1/seasons/trends?type=color').set(auth());
    expect(byType.body.items[0].name).toBe('大地色系');

    const patched = await request(app).patch(`/api/v1/seasons/trends/${tag.id}`).set(auth()).send({ name: '再生涤纶' });
    expect(patched.status).toBe(200);
    expect(patched.body.item.name).toBe('再生涤纶');

    const del = await request(app).delete(`/api/v1/seasons/trends/${tag.id}`).set(auth());
    expect(del.status).toBe(200);
    const after = await request(app).get('/api/v1/seasons/trends').set(auth());
    expect(after.body.total).toBe(1);
  });

  it('linkFabric 唯一约束；trending-fabrics 按 seasonId 过滤且含 fabric→productAsset；unlink 硬删除', async () => {
    const app = makeApp(prisma);
    const sA = await createSeason(app); // SS26
    const sB = await createSeason(app, { code: 'AW26', name: '2026 秋冬', startDate: '2026-07-01', endDate: '2026-12-31' });
    const tagA = await createTrendTag(app, { seasonId: sA.id, name: '环保面料' });
    const tagB = await createTrendTag(app, { seasonId: sB.id, name: '厚重呢料' });
    seedFabric(prisma, 'FAB1');
    seedFabric(prisma, 'FAB2');

    const link = await request(app).post(`/api/v1/seasons/trends/${tagA.id}/fabrics`).set(auth()).send({ fabricId: 'FAB1', note: '主推' });
    expect(link.status).toBe(201);
    await request(app).post(`/api/v1/seasons/trends/${tagB.id}/fabrics`).set(auth()).send({ fabricId: 'FAB2' });

    // 重复关联 → 400
    const dup = await request(app).post(`/api/v1/seasons/trends/${tagA.id}/fabrics`).set(auth()).send({ fabricId: 'FAB1' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('已关联');
    // 面料不存在 → 404
    const noFabric = await request(app).post(`/api/v1/seasons/trends/${tagA.id}/fabrics`).set(auth()).send({ fabricId: 'FAB_GONE' });
    expect(noFabric.status).toBe(404);

    const all = await request(app).get('/api/v1/seasons/trending-fabrics').set(auth());
    expect(all.body.total).toBe(2);
    const onlyA = await request(app).get(`/api/v1/seasons/trending-fabrics?seasonId=${sA.id}`).set(auth());
    expect(onlyA.body.total).toBe(1);
    expect(onlyA.body.items[0].tag.id).toBe(tagA.id);
    expect(onlyA.body.items[0].fabric.id).toBe('FAB1');
    expect(onlyA.body.items[0].fabric.productAsset.id).toBe('PA_FAB1');
    expect(onlyA.body.items[0].link.note).toBe('主推');

    const unlink = await request(app).delete(`/api/v1/seasons/trends/${tagA.id}/fabrics/FAB1`).set(auth());
    expect(unlink.status).toBe(200);
    const after = await request(app).get(`/api/v1/seasons/trending-fabrics?seasonId=${sA.id}`).set(auth());
    expect(after.body.total).toBe(0);
    // 重复解除 → 404
    const again = await request(app).delete(`/api/v1/seasons/trends/${tagA.id}/fabrics/FAB1`).set(auth());
    expect(again.status).toBe(404);
  });

  it('listTrendTags 不展示已软删 fabric 的关联', async () => {
    const app = makeApp(prisma);
    const tag = await createTrendTag(app);
    seedFabric(prisma, 'FAB1');
    seedFabric(prisma, 'FAB_DEL', true);
    await request(app).post(`/api/v1/seasons/trends/${tag.id}/fabrics`).set(auth()).send({ fabricId: 'FAB1' });
    // 已删面料无法通过 linkFabric 校验，直接塞关联行模拟「关联后面料被删」
    prisma._stores.trendTagFabrics.push({ id: 'TRTF__X', trendTagId: tag.id, fabricId: 'FAB_DEL', note: null, createdAt: BigInt(Date.now()) });

    const list = await request(app).get('/api/v1/seasons/trends').set(auth());
    expect(list.body.items[0].fabricLinks).toHaveLength(1);
    expect(list.body.items[0].fabricLinks[0].fabric.id).toBe('FAB1');

    // trending-fabrics 同样过滤已删 fabric
    const trending = await request(app).get('/api/v1/seasons/trending-fabrics').set(auth());
    expect(trending.body.total).toBe(1);
  });
});

describe('H2 · TradeShow 展会 + Lead 线索 + ROI', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('展会 CRUD：status 封闭集校验；GET /shows/:id 返回 { item, roi }', async () => {
    const app = makeApp(prisma);
    const s = await createSeason(app);
    const show = await createTradeShow(app, { seasonId: s.id, cost: 10000, boothNo: 'E7-A01' });
    await createTradeShow(app, { name: 'Première Vision', startDate: '2026-09-15', status: 'Completed' });

    const byStatus = await request(app).get('/api/v1/seasons/shows?status=Planned').set(auth());
    expect(byStatus.body.total).toBe(1);
    const bySeason = await request(app).get(`/api/v1/seasons/shows?seasonId=${s.id}`).set(auth());
    expect(bySeason.body.items[0].id).toBe(show.id);

    const detail = await request(app).get(`/api/v1/seasons/shows/${show.id}`).set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.item.boothNo).toBe('E7-A01');
    expect(detail.body.item.leads).toHaveLength(0);
    expect(detail.body.roi.leadsTotal).toBe(0);
    expect(detail.body.roi.cost).toBe(10000);

    const patched = await request(app).patch(`/api/v1/seasons/shows/${show.id}`).set(auth()).send({ status: 'Ongoing' });
    expect(patched.body.item.status).toBe('Ongoing');
    const badStatus = await request(app).patch(`/api/v1/seasons/shows/${show.id}`).set(auth()).send({ status: 'Done' });
    expect(badStatus.status).toBe(400);

    const del = await request(app).delete(`/api/v1/seasons/shows/${show.id}`).set(auth());
    expect(del.status).toBe(200);
    const gone = await request(app).get(`/api/v1/seasons/shows/${show.id}`).set(auth());
    expect(gone.status).toBe(404);
  });

  it('线索 CRUD：customerName 必填；convertedRelationId 禁改；status 封闭集校验', async () => {
    const app = makeApp(prisma);
    const show = await createTradeShow(app);

    const noName = await request(app).post(`/api/v1/seasons/shows/${show.id}/leads`).set(auth()).send({ company: '某品牌' });
    expect(noName.status).toBe(400);
    const noShow = await request(app).post('/api/v1/seasons/shows/TRDS__NOPE/leads').set(auth()).send({ customerName: '张三' });
    expect(noShow.status).toBe(404);

    const lead = await addLead(app, show.id, { company: '某品牌', country: 'FR', demand: '找再生尼龙' });
    expect(lead.status).toBe('New');

    const patched = await request(app).patch(`/api/v1/seasons/leads/${lead.id}`).set(auth()).send({ status: 'Following', nextFollowUpAt: '2026-08-20' });
    expect(patched.body.item.status).toBe('Following');

    const forbid = await request(app).patch(`/api/v1/seasons/leads/${lead.id}`).set(auth()).send({ convertedRelationId: 'REL_X' });
    expect(forbid.status).toBe(400);
    expect(forbid.body.error.message).toContain('不允许');
    const badStatus = await request(app).patch(`/api/v1/seasons/leads/${lead.id}`).set(auth()).send({ status: 'Done' });
    expect(badStatus.status).toBe(400);

    const del = await request(app).delete(`/api/v1/seasons/leads/${lead.id}`).set(auth());
    expect(del.status).toBe(200);
    const detail = await request(app).get(`/api/v1/seasons/shows/${show.id}`).set(auth());
    expect(detail.body.item.leads).toHaveLength(0); // 已软删不出现在详情
  });

  it('线索转化：仅 category=Customer 的 Relation；重复转化拒绝；ROI 聚合转化客户订单', async () => {
    const app = makeApp(prisma);
    const show = await createTradeShow(app, { cost: 10000, currency: 'CNY' });
    prisma._stores.relations.push(
      { id: 'REL_C1', name: '客户A', category: 'Customer', isOrganization: true, deletedAt: null },
      { id: 'REL_S1', name: '供应商B', category: 'Supplier', isOrganization: true, deletedAt: null },
    );
    const lead1 = await addLead(app, show.id, { customerName: '张三' });
    await addLead(app, show.id, { customerName: '李四' });

    // 非 Customer → 400
    const badCategory = await request(app).post(`/api/v1/seasons/leads/${lead1.id}/convert`).set(auth()).send({ relationId: 'REL_S1' });
    expect(badCategory.status).toBe(400);
    expect(badCategory.body.error.message).toContain('仅 category=Customer');
    // Relation 不存在 → 404
    const noRelation = await request(app).post(`/api/v1/seasons/leads/${lead1.id}/convert`).set(auth()).send({ relationId: 'REL_GONE' });
    expect(noRelation.status).toBe(404);

    const converted = await request(app).post(`/api/v1/seasons/leads/${lead1.id}/convert`).set(auth()).send({ relationId: 'REL_C1' });
    expect(converted.status).toBe(200);
    expect(converted.body.item.status).toBe('Converted');
    expect(converted.body.item.convertedRelationId).toBe('REL_C1');
    expect(converted.body.item.convertedAt).toBeGreaterThan(0);

    // 重复转化 → 400
    const dup = await request(app).post(`/api/v1/seasons/leads/${lead1.id}/convert`).set(auth()).send({ relationId: 'REL_C1' });
    expect(dup.status).toBe(400);

    // 转化客户的订单归入展会 ROI（★ totalNet 优先，见订单金额真源；已删订单不计）
    prisma._stores.orders.push(
      { id: 'O9', customer: '客户A', status: 'Shipped', season: 'SS26', shipmentDate: '2026-03-01', totalNet: 5000, contractAmount: 5000, quoteAmount: 4800, supplierInvoiceAmount: null, customerRelationId: 'REL_C1', deletedAt: null },
      { id: 'O10', customer: '其他', status: 'Draft', season: 'SS26', shipmentDate: null, totalNet: 100, contractAmount: null, quoteAmount: 100, supplierInvoiceAmount: null, customerRelationId: 'REL_X', deletedAt: null },
      { id: 'O11', customer: '客户A', status: 'Draft', season: 'SS26', shipmentDate: null, totalNet: 3000, contractAmount: null, quoteAmount: 3000, supplierInvoiceAmount: null, customerRelationId: 'REL_C1', deletedAt: BigInt(Date.now()) },
    );

    const roi = await request(app).get(`/api/v1/seasons/shows/${show.id}/roi`).set(auth());
    expect(roi.status).toBe(200);
    expect(roi.body.roi.cost).toBe(10000);
    expect(roi.body.roi.currency).toBe('CNY');
    expect(roi.body.roi.leadsTotal).toBe(2);
    expect(roi.body.roi.leadsConverted).toBe(1);
    expect(roi.body.roi.orderCount).toBe(1);
    expect(roi.body.roi.orderAmount).toBe(5000);
    expect(roi.body.roi.roi).toBe(0.5);

    // 无成本展会 → roi = null
    const freeShow = await createTradeShow(app, { name: '线上展', startDate: '2026-05-01' });
    const roi2 = await request(app).get(`/api/v1/seasons/shows/${freeShow.id}/roi`).set(auth());
    expect(roi2.body.roi.cost).toBeNull();
    expect(roi2.body.roi.roi).toBeNull();
  });
});
