import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u2', roles: ['viewer'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createSupplierRouter } from '../factoryRoute';
import { createProcurementService } from '../../procurement/procurementService';
import { createFactoryService, deliveryScoreForDaysLate, inspectionScoreForResult } from '../factoryService';

/**
 * Mock Prisma：内存存储四个供应商模型 + Relation + PurchaseOrder。
 * 语义对齐真实 client 的本测试用到的子集（软删过滤、findFirst 复合条件、$transaction 直通）。
 */
function makeMockPrisma() {
  let seq = 0;
  const relations: any[] = [];
  const profiles: any[] = [];
  const evaluations: any[] = [];
  const certifications: any[] = [];
  const capacities: any[] = [];
  const purchaseOrders: any[] = [];

  const matchWhere = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('gte' in cond || 'lte' in cond) {
          if (cond.gte !== undefined && !(row[k] >= cond.gte)) return false;
          if (cond.lte !== undefined && !(row[k] <= cond.lte)) return false;
          return true;
        }
        if ('contains' in cond) return String(row[k] || '').toLowerCase().includes(String(cond.contains).toLowerCase());
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

  const factoryProfile = {
    findUnique: async ({ where, include }: any) => {
      const row = profiles.find(p => (where.id ? p.id === where.id : p.relationId === where.relationId));
      if (!row) return null;
      return include ? attachProfileIncludes(row, include) : row;
    },
    findFirst: async ({ where }: any) => profiles.find(p => matchWhere(p, where)) || null,
    findMany: async ({ where, include, orderBy }: any = {}) =>
      applyOrderBy(profiles.filter(p => matchWhere(p, where)), orderBy).map(p => (include ? attachProfileIncludes(p, include) : p)),
    count: async ({ where }: any = {}) => profiles.filter(p => matchWhere(p, where)).length,
    create: async ({ data }: any) => {
      const row = { deletedAt: null, blacklistedAt: null, blacklistReason: null, blacklistedById: null, ...data, id: data.id || `FACP__T${++seq}` };
      profiles.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = profiles.find(p => p.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  function attachProfileIncludes(row: any, include: any) {
    const out: any = { ...row };
    if (include.relation) out.relation = relations.find(r => r.id === row.relationId) || null;
    if (include.certifications) out.certifications = certifications.filter(c => c.factoryId === row.id && c.deletedAt === null);
    return out;
  }

  const factoryEvaluation = {
    findFirst: async ({ where }: any) =>
      evaluations.find(e =>
        e.factoryId === where.factoryId &&
        (where.kind === undefined || e.kind === where.kind) &&
        (where.sourceType === undefined || e.sourceType === where.sourceType) &&
        (where.sourceId === undefined || e.sourceId === where.sourceId) &&
        (where.deletedAt === null ? e.deletedAt === null : true),
      ) || null,
    findMany: async ({ where, select, orderBy }: any = {}) => {
      const rows = applyOrderBy(evaluations.filter(e => matchWhere(e, where)), orderBy);
      return select ? rows.map(r => ({ score: r.score })) : rows;
    },
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `FAEV__T${++seq}` };
      evaluations.push(row);
      return row;
    },
  };

  const factoryCertification = {
    findUnique: async ({ where }: any) => certifications.find(c => c.id === where.id) || null,
    findMany: async ({ where, include, orderBy }: any = {}) => {
      let rows = applyOrderBy(certifications.filter(c => {
        if (where.deletedAt !== undefined && c.deletedAt !== where.deletedAt) return false;
        if (where.factoryId && c.factoryId !== where.factoryId) return false;
        if (where.validUntil) {
          if (c.validUntil === null) return false;
          if (where.validUntil.gte && c.validUntil < where.validUntil.gte) return false;
          if (where.validUntil.lte && c.validUntil > where.validUntil.lte) return false;
        }
        if (where.factory?.deletedAt === null) {
          const f = profiles.find(p => p.id === c.factoryId);
          if (!f || f.deletedAt !== null) return false;
        }
        return true;
      }), orderBy);
      if (include?.factory) {
        rows = rows.map(c => {
          const f = profiles.find(p => p.id === c.factoryId);
          return { ...c, factory: f && include.factory.include?.relation ? { ...f, relation: relations.find(r => r.id === f.relationId) } : f };
        });
      }
      return rows;
    },
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `FACR__T${++seq}` };
      certifications.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = certifications.find(c => c.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const factoryCapacity = {
    findFirst: async ({ where }: any) =>
      capacities.find(c => c.factoryId === where.factoryId && c.month === where.month && (where.deletedAt === null ? c.deletedAt === null : true)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(capacities.filter(c => c.factoryId === where.factoryId && (where.deletedAt === null ? c.deletedAt === null : true)), orderBy),
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `FACC__T${++seq}` };
      capacities.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = capacities.find(c => c.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const purchaseOrder = {
    findMany: async ({ where }: any = {}) =>
      purchaseOrders
        .filter(po =>
          po.deletedAt === null &&
          po.supplierRelationId === where.supplierRelationId &&
          where.status.in.includes(po.status) &&
          (po.expectedDeliveryDate !== null || po.lines.some((line: any) => line.supplierCommittedDeliveryDate)),
        )
        .map(po => ({ expectedDeliveryDate: po.expectedDeliveryDate, lines: po.lines })),
  };

  const relation = {
    findUnique: async ({ where }: any) => relations.find(r => r.id === where.id) || null,
  };

  return {
    relation, factoryProfile, factoryEvaluation, factoryCertification, factoryCapacity, purchaseOrder,
    $transaction: async (fn: any) => fn({
      factoryProfile, factoryEvaluation, factoryCertification, factoryCapacity, relation, purchaseOrder,
    }),
    _stores: { relations, profiles, evaluations, certifications, capacities, purchaseOrders },
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
  app.use('/api/v1/suppliers', createSupplierRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });
const viewerAuth = () => ({ Cookie: `bambook_token=${viewerToken}` });

function seedSupplierRelation(prisma: any, id = 'REL_SUP1') {
  prisma._stores.relations.push({
    id, name: '某纺织厂', category: 'Supplier', isOrganization: true, deletedAt: null,
  });
  return id;
}

async function createProfile(app: any, relationId: string) {
  const res = await request(app).post('/api/v1/suppliers').set(auth()).send({
    relationId, monthlyCapacity: 50000, capacityUnit: 'M', specialties: ['西装'], priceLevel: 'Mid',
  });
  expect(res.status).toBe(201);
  return res.body.item;
}

describe('H1a · FactoryProfile 档案 CRUD', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('POST / 建立档案（校验 Relation 为 Supplier 组织）', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/suppliers').set(auth()).send({
      relationId: 'REL_SUP1', monthlyCapacity: 50000, capacityUnit: 'M', specialties: ['西装', '大衣'], priceLevel: 'Mid',
    });
    expect(res.status).toBe(201);
    expect(res.body.item.relationId).toBe('REL_SUP1');
    expect(res.body.item.qualityScore).toBe(0);
  });

  it('POST / Relation 非 Supplier → 400；非组织 → 400；不存在 → 400', async () => {
    prisma._stores.relations.push(
      { id: 'REL_CUST', name: '客户', category: 'Customer', isOrganization: true, deletedAt: null },
      { id: 'REL_PERSON', name: '个人供应商联系人', category: 'Supplier', isOrganization: false, deletedAt: null },
    );
    const app = makeApp(prisma);
    const r1 = await request(app).post('/api/v1/suppliers').set(auth()).send({ relationId: 'REL_CUST' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/v1/suppliers').set(auth()).send({ relationId: 'REL_PERSON' });
    expect(r2.status).toBe(400);
    const r3 = await request(app).post('/api/v1/suppliers').set(auth()).send({ relationId: 'REL_GONE' });
    expect(r3.status).toBe(400);
  });

  it('POST / 重复建档（1:1 约束）→ 400', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    await createProfile(app, 'REL_SUP1');
    const dup = await request(app).post('/api/v1/suppliers').set(auth()).send({ relationId: 'REL_SUP1' });
    expect(dup.status).toBe(400);
  });

  it('GET / 列表默认按质量分降序；sort=delivery 按交期分；blacklisted 过滤', async () => {
    seedSupplierRelation(prisma, 'REL_A');
    seedSupplierRelation(prisma, 'REL_B');
    const app = makeApp(prisma);
    const a = await createProfile(app, 'REL_A');
    const b = await createProfile(app, 'REL_B');
    await request(app).post(`/api/v1/suppliers/${a.id}/evaluations`).set(auth()).send({ kind: 'inspection', score: 90, evaluatedAt: '2026-08-01' });
    await request(app).post(`/api/v1/suppliers/${b.id}/evaluations`).set(auth()).send({ kind: 'delivery', score: 70, evaluatedAt: '2026-08-01' });

    const byQuality = await request(app).get('/api/v1/suppliers').set(auth());
    expect(byQuality.body.items[0].id).toBe(a.id);
    const byDelivery = await request(app).get('/api/v1/suppliers?sort=delivery').set(auth());
    expect(byDelivery.body.items[0].id).toBe(b.id);
    const onlyActive = await request(app).get('/api/v1/suppliers?blacklisted=false').set(auth());
    expect(onlyActive.body.total).toBe(2);
    const onlyBlacklisted = await request(app).get('/api/v1/suppliers?blacklisted=true').set(auth());
    expect(onlyBlacklisted.body.total).toBe(0);
  });

  it('PATCH /:id 白名单更新；DELETE 软删后 GET 404', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');
    const patched = await request(app).patch(`/api/v1/suppliers/${p.id}`).set(auth()).send({ workerCount: 120, priceLevel: 'Low' });
    expect(patched.status).toBe(200);
    expect(patched.body.item.workerCount).toBe(120);
    const del = await request(app).delete(`/api/v1/suppliers/${p.id}`).set(auth());
    expect(del.status).toBe(200);
    const get = await request(app).get(`/api/v1/suppliers/${p.id}`).set(auth());
    expect(get.status).toBe(404);
  });

  it('写操作仅 API-Key → 401（JWT 强制）', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/suppliers').set('x-bambook-api-key', validApiKey).send({ relationId: 'REL_SUP1' });
    expect(res.status).toBe(401);
  });
});

describe('H1a · 黑名单', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('拉黑需原因；owner 可拉黑/解除；viewer → 403', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    const noReason = await request(app).post(`/api/v1/suppliers/${p.id}/blacklist`).set(auth()).send({});
    expect(noReason.status).toBe(400);

    const forbidden = await request(app).post(`/api/v1/suppliers/${p.id}/blacklist`).set(viewerAuth()).send({ reason: '质量事故' });
    expect(forbidden.status).toBe(403);

    const blocked = await request(app).post(`/api/v1/suppliers/${p.id}/blacklist`).set(auth()).send({ reason: '质量事故' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.item.blacklistReason).toBe('质量事故');
    expect(blocked.body.item.blacklistedAt).toBeGreaterThan(0);

    const list = await request(app).get('/api/v1/suppliers?blacklisted=true').set(auth());
    expect(list.body.total).toBe(1);

    const cleared = await request(app).delete(`/api/v1/suppliers/${p.id}/blacklist`).set(auth());
    expect(cleared.status).toBe(200);
    expect(cleared.body.item.blacklistedAt).toBeNull();
  });
});

describe('R6 · 写端点 suppliers:write scope 门', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('viewer（无 suppliers:write）全部写端点 → 403；读端点不受影响', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    // 读端点仅 JWT 门：viewer 可访问
    const list = await request(app).get('/api/v1/suppliers').set(viewerAuth());
    expect(list.status).toBe(200);

    // 档案写
    expect((await request(app).post('/api/v1/suppliers').set(viewerAuth()).send({ relationId: 'REL_SUP1' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/suppliers/${p.id}`).set(viewerAuth()).send({ workerCount: 1 })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/suppliers/${p.id}`).set(viewerAuth())).status).toBe(403);
    // 评估 / 认证
    expect((await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(viewerAuth()).send({ kind: 'inspection', score: 80, evaluatedAt: '2026-08-01' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(viewerAuth()).send({ type: 'BSCI' })).status).toBe(403);
    expect((await request(app).patch('/api/v1/suppliers/certifications/FACR__X').set(viewerAuth()).send({})).status).toBe(403);
    expect((await request(app).delete('/api/v1/suppliers/certifications/FACR__X').set(viewerAuth())).status).toBe(403);
    // 产能日历
    expect((await request(app).put(`/api/v1/suppliers/${p.id}/capacity/2026-09`).set(viewerAuth()).send({ capacity: 100 })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/suppliers/${p.id}/capacity/2026-09`).set(viewerAuth())).status).toBe(403);
    // 延迟登记 / TC 证书链
    expect((await request(app).post('/api/v1/suppliers/delays').set(viewerAuth()).send({})).status).toBe(403);
    expect((await request(app).post('/api/v1/suppliers/tc-certificates').set(viewerAuth()).send({})).status).toBe(403);
    expect((await request(app).patch('/api/v1/suppliers/tc-certificates/TC__X').set(viewerAuth()).send({})).status).toBe(403);
    expect((await request(app).delete('/api/v1/suppliers/tc-certificates/TC__X').set(viewerAuth())).status).toBe(403);
  });

  it('owner 写端点不受阻（super-admin 全通回归锚点：建档 201）', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const res = await request(app).post('/api/v1/suppliers').set(auth()).send({ relationId: 'REL_SUP1' });
    expect(res.status).toBe(201);
  });

  it('API-Key 通道命中写 scope 门仍 401（requireWrite 先于 scope 校验）', async () => {
    const app = makeApp(prisma);
    const res = await request(app).patch('/api/v1/suppliers/FACP__X').set('x-bambook-api-key', validApiKey).send({ workerCount: 1 });
    expect(res.status).toBe(401);
  });
});

describe('H1a · FactoryEvaluation 评分与缓存分重算', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('追加验货/交货评分后同事务重算 qualityScore / deliveryScore（均值口径）', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'inspection', score: 80, evaluatedAt: '2026-08-01', sourceType: 'manual' });
    await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'inspection', score: 100, evaluatedAt: '2026-08-02' });
    await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'delivery', score: 60, evaluatedAt: '2026-08-03' });

    const detail = await request(app).get(`/api/v1/suppliers/${p.id}`).set(auth());
    expect(detail.body.item.qualityScore).toBe(90);
    expect(detail.body.item.deliveryScore).toBe(60);

    const evals = await request(app).get(`/api/v1/suppliers/${p.id}/evaluations?kind=inspection`).set(auth());
    expect(evals.body.total).toBe(2);
  });

  it('非法 kind / 超界 score / 非法日期 → 400', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');
    const bad1 = await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'hack', score: 50, evaluatedAt: '2026-08-01' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'inspection', score: 120, evaluatedAt: '2026-08-01' });
    expect(bad2.status).toBe(400);
    const bad3 = await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'inspection', score: 80, evaluatedAt: '08-01' });
    expect(bad3.status).toBe(400);
  });
});

describe('H1a · FactoryCertification 认证与到期预警', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('认证 CRUD + 软删；expiring-certifications 只扫区间内有有效期的', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const c1 = await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'BSCI', validUntil: soon });
    expect(c1.status).toBe(201);
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'ISO9001', validUntil: far });
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'WRAP' }); // 长期有效

    const list = await request(app).get(`/api/v1/suppliers/${p.id}/certifications`).set(auth());
    expect(list.body.total).toBe(3);

    const expiring = await request(app).get('/api/v1/suppliers/expiring-certifications?days=30').set(auth());
    expect(expiring.status).toBe(200);
    expect(expiring.body.total).toBe(1);
    expect(expiring.body.items[0].type).toBe('BSCI');
    expect(expiring.body.items[0].factory.relation.name).toBe('某纺织厂');

    const certId = c1.body.item.id;
    const patched = await request(app).patch(`/api/v1/suppliers/certifications/${certId}`).set(auth()).send({ validUntil: far });
    expect(patched.status).toBe(200);
    const expiring2 = await request(app).get('/api/v1/suppliers/expiring-certifications?days=30').set(auth());
    expect(expiring2.body.total).toBe(0);

    const del = await request(app).delete(`/api/v1/suppliers/certifications/${certId}`).set(auth());
    expect(del.status).toBe(200);
    const list2 = await request(app).get(`/api/v1/suppliers/${p.id}/certifications`).set(auth());
    expect(list2.body.total).toBe(2);
  });

  it('C8：已过期证书进预警（标记已过期 X 天），排序最逾期在前；远期证书仍不进预警', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    const expired10 = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const expired40 = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'BSCI', validUntil: expired10 });
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'SEDEX', validUntil: expired40 });
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'WRAP', validUntil: soon });
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'ISO9001', validUntil: far });

    const res = await request(app).get('/api/v1/suppliers/expiring-certifications?days=30').set(auth());
    expect(res.status).toBe(200);
    // 已过期 2 项 + 30 天内到期 1 项；远期 ISO9001 不进预警
    expect(res.body.total).toBe(3);
    const types = res.body.items.map((i: any) => i.type);
    expect(types).toEqual(['SEDEX', 'BSCI', 'WRAP']); // validUntil 升序：最逾期在前
    const sedex = res.body.items[0];
    expect(sedex.daysUntilExpiry).toBe(-40); // 已过期 40 天（服务端统一口径）
    const wrap = res.body.items[2];
    expect(wrap.daysUntilExpiry).toBe(10);
  });
});

describe('H1a · FactoryCapacity 产能日历与占用聚合', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('PUT upsert 月产能；占用由在手采购单落月实时聚合（Draft/Cancelled 不计）', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    prisma._stores.purchaseOrders.push(
      { id: 'PO1', supplierRelationId: 'REL_SUP1', status: 'Confirmed', expectedDeliveryDate: '2026-09-15', deletedAt: null, lines: [{ quantity: 12000 }, { quantity: 8000 }] },
      { id: 'PO2', supplierRelationId: 'REL_SUP1', status: 'Draft', expectedDeliveryDate: '2026-09-20', deletedAt: null, lines: [{ quantity: 5000 }] },
      { id: 'PO3', supplierRelationId: 'REL_SUP1', status: 'Sent', expectedDeliveryDate: '2026-10-01', deletedAt: null, lines: [{ quantity: 3000 }] },
      { id: 'PO4', supplierRelationId: 'REL_SUP1', status: 'Confirmed', expectedDeliveryDate: null, deletedAt: null, lines: [{ quantity: 700, supplierCommittedDeliveryDate: '2026-10-15' }] },
    );

    const up = await request(app).put('/api/v1/suppliers/' + p.id + '/capacity/2026-09').set(auth()).send({ capacity: 50000, unit: 'M' });
    expect(up.status).toBe(200);
    // 重复 PUT 同月 → 更新而非新增
    const up2 = await request(app).put('/api/v1/suppliers/' + p.id + '/capacity/2026-09').set(auth()).send({ capacity: 60000, unit: 'M' });
    expect(up2.status).toBe(200);
    await request(app).put('/api/v1/suppliers/' + p.id + '/capacity/2026-10').set(auth()).send({ capacity: 40000, unit: 'M' });

    const list = await request(app).get(`/api/v1/suppliers/${p.id}/capacity`).set(auth());
    expect(list.body.total).toBe(2);
    const sep = list.body.items.find((i: any) => i.month === '2026-09');
    expect(sep.capacity).toBe(60000);
    expect(sep.occupied).toBe(20000); // 仅 Confirmed 单计入
    const oct = list.body.items.find((i: any) => i.month === '2026-10');
    expect(oct.occupied).toBe(3700); // 已批行交期无需依赖旧主单日期

    const del = await request(app).delete('/api/v1/suppliers/' + p.id + '/capacity/2026-10').set(auth());
    expect(del.status).toBe(200);
    const list2 = await request(app).get(`/api/v1/suppliers/${p.id}/capacity`).set(auth());
    expect(list2.body.total).toBe(1);
  });

  it('D2：产能占用按单位换算聚合（YD→M 换算、不可换算单位不计入）', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1'); // capacityUnit: 'M'

    prisma._stores.purchaseOrders.push(
      { id: 'POU1', supplierRelationId: 'REL_SUP1', status: 'Confirmed', expectedDeliveryDate: '2026-09-10', deletedAt: null,
        lines: [{ quantity: 1000, unit: 'YD' }, { quantity: 500, unit: 'M' }, { quantity: 200, unit: 'KG' }] },
    );

    await request(app).put('/api/v1/suppliers/' + p.id + '/capacity/2026-09').set(auth()).send({ capacity: 50000, unit: 'M' });
    const list = await request(app).get(`/api/v1/suppliers/${p.id}/capacity`).set(auth());
    const sep = list.body.items.find((i: any) => i.month === '2026-09');
    // 1000 YD × 0.9144 = 914.4 M + 500 M = 1414.4；200 KG 不可换算 → 不计入（不再件/米混加）
    expect(sep.occupied).toBe(1414.4);
  });

  it('非法 month / 负 capacity → 400', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');
    const bad1 = await request(app).put(`/api/v1/suppliers/${p.id}/capacity/2026-9`).set(auth()).send({ capacity: 100 });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app).put(`/api/v1/suppliers/${p.id}/capacity/2026-09`).set(auth()).send({ capacity: -5 });
    expect(bad2.status).toBe(400);
  });
});

describe('H1a · 360° 总览', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('GET /:id/overview 聚合档案 + 评分 + 认证 + 产能；不存在 → 404', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');
    await request(app).post(`/api/v1/suppliers/${p.id}/evaluations`).set(auth()).send({ kind: 'inspection', score: 85, evaluatedAt: '2026-08-01' });
    await request(app).post(`/api/v1/suppliers/${p.id}/certifications`).set(auth()).send({ type: 'BSCI' });

    const res = await request(app).get(`/api/v1/suppliers/${p.id}/overview`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.profile.relation.name).toBe('某纺织厂');
    expect(res.body.evaluations).toHaveLength(1);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.capacity).toHaveLength(0);

    const missing = await request(app).get('/api/v1/suppliers/FACP__NOPE/overview').set(auth());
    expect(missing.status).toBe(404);
  });
});

describe('H1a · 黑名单阻断采购单创建（PRD 13.1 联动）', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const poInput = {
    poNumber: 'PO-TEST-001',
    currency: 'CNY',
    orderDate: '2026-08-08',
    supplierRelationId: 'REL_SUP1',
    lines: [{ description: '面料', unit: 'M', quantity: 1000, unitPrice: 10 }],
  };

  it('已拉黑工厂 → createPurchaseOrder 抛错；未拉黑 → 正常创建', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');

    // procurementService 的 $transaction/create 走真实 mock 太重，这里仅验证黑名单前置闸：
    // 未拉黑时应通过闸口（后续 DB 操作允许抛错，但错误不是拉黑）
    const service = createProcurementService(prisma);
    await expect(service.createPurchaseOrder(poInput as any, 'u1')).rejects.not.toThrow('已被拉黑');

    await request(app).post(`/api/v1/suppliers/${p.id}/blacklist`).set(auth()).send({ reason: '质量事故' });
    await expect(service.createPurchaseOrder(poInput as any, 'u1')).rejects.toThrow('已被拉黑');
  });
});

describe('H1c · 自动评分口径纯函数', () => {
  it('deliveryScoreForDaysLate：提前/准时 100，分级递减，未约定交期不惩罚', () => {
    expect(deliveryScoreForDaysLate(null)).toBe(100);
    expect(deliveryScoreForDaysLate(-3)).toBe(100);
    expect(deliveryScoreForDaysLate(0)).toBe(100);
    expect(deliveryScoreForDaysLate(7)).toBe(80);
    expect(deliveryScoreForDaysLate(14)).toBe(60);
    expect(deliveryScoreForDaysLate(30)).toBe(40);
    expect(deliveryScoreForDaysLate(31)).toBe(20);
  });

  it('inspectionScoreForResult：pass 95 / conditional 70 / fail 20；致命疵点一票否决', () => {
    expect(inspectionScoreForResult('pass', 0)).toBe(95);
    expect(inspectionScoreForResult('conditional', 0)).toBe(70);
    expect(inspectionScoreForResult('fail', 0)).toBe(20);
    expect(inspectionScoreForResult('pass', 1)).toBe(20);
  });
});

describe('H1c · recordAutoEvaluation 幂等自动评分', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('同 sourceType+sourceId+kind 只记一次；无档案 Relation 静默跳过；重算缓存分', async () => {
    seedSupplierRelation(prisma);
    const app = makeApp(prisma);
    const p = await createProfile(app, 'REL_SUP1');
    const service = createFactoryService(prisma);

    const first = await service.recordAutoEvaluation({
      relationId: 'REL_SUP1', kind: 'delivery', score: 80,
      sourceType: 'purchaseOrder', sourceId: 'PO_1', evaluatedAt: '2026-08-08', actorId: 'system',
    });
    expect(first.recorded).toBe(true);

    const dup = await service.recordAutoEvaluation({
      relationId: 'REL_SUP1', kind: 'delivery', score: 20,
      sourceType: 'purchaseOrder', sourceId: 'PO_1', evaluatedAt: '2026-08-09', actorId: 'system',
    });
    expect(dup.recorded).toBe(false);

    // 同 sourceId 不同 kind 不互相吞掉
    const other = await service.recordAutoEvaluation({
      relationId: 'REL_SUP1', kind: 'inspection', score: 95,
      sourceType: 'inspectionReport', sourceId: 'PO_1', evaluatedAt: '2026-08-09', actorId: 'system',
    });
    expect(other.recorded).toBe(true);

    const detail = await request(app).get(`/api/v1/suppliers/${p.id}`).set(auth());
    expect(detail.body.item.deliveryScore).toBe(80); // 第二次 20 分被幂等拦截
    expect(detail.body.item.qualityScore).toBe(95);

    // 无档案 Relation → 静默跳过
    const noProfile = await service.recordAutoEvaluation({
      relationId: 'REL_UNKNOWN', kind: 'delivery', score: 50,
      sourceType: 'purchaseOrder', sourceId: 'PO_2', evaluatedAt: '2026-08-08', actorId: 'system',
    });
    expect(noProfile.recorded).toBe(false);
  });
});

describe('supplier onboarding ensure association', () => {
 it('reuses one identity and profile without overwriting existing production data', async () => {
  const prisma=makeMockPrisma(); seedSupplierRelation(prisma); const app=makeApp(prisma);
  const first=await request(app).post('/api/v1/suppliers/ensure').set(auth()).send({relationId:'REL_SUP1',monthlyCapacity:50000,capacityUnit:'M'});
  expect(first.status).toBe(200);
  const again=await request(app).post('/api/v1/suppliers/ensure').set(auth()).send({relationId:'REL_SUP1',monthlyCapacity:null});
  expect(again.status).toBe(200); expect(again.body.item.id).toBe(first.body.item.id);
  expect(again.body.item.monthlyCapacity).toBe(50000);
  expect(prisma._stores.profiles).toHaveLength(1); expect(prisma._stores.relations).toHaveLength(1);
 });
 it('does not create production data or revive a retired profile through onboarding', async () => {
  const prisma=makeMockPrisma();seedSupplierRelation(prisma);const app=makeApp(prisma);
  const first=await request(app).post('/api/v1/suppliers/ensure').set(auth()).send({relationId:'REL_SUP1'});
  expect(first.status).toBe(200);expect(first.body.item.monthlyCapacity).toBeNull();
  prisma._stores.profiles[0].deletedAt=BigInt(Date.now());
  const retry=await request(app).post('/api/v1/suppliers/ensure').set(auth()).send({relationId:'REL_SUP1'});
  expect(retry.status).not.toBe(200); expect(prisma._stores.profiles).toHaveLength(1);
 });
 it('requires supplier write permission and a valid supplier identity', async () => {
  const prisma=makeMockPrisma();seedSupplierRelation(prisma);const app=makeApp(prisma);
  expect((await request(app).post('/api/v1/suppliers/ensure').set(viewerAuth()).send({relationId:'REL_SUP1'})).status).toBe(403);
  expect((await request(app).post('/api/v1/suppliers/ensure').set(auth()).send({relationId:'missing'})).status).not.toBe(200);
  expect(prisma._stores.profiles).toHaveLength(0);
 });
});
