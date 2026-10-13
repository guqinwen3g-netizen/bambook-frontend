import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createBusinessLineRouter } from '../businessLineRoute';
import type { TokenPayload } from '../../auth/service';

/**
 * Mock Prisma：内存存储 BusinessLine + Order。
 * 语义对齐真实 client 的本测试用到的子集（where 条件、多字段 orderBy）。
 */
function makeMockPrisma() {
  let seq = 0;
  const businessLines: any[] = [];
  const orders: any[] = [];
  const audits: any[] = [];
  // The original positive actor now has an actual loaded, active account.
  // No role-name/default permission substitutes for the DB authorization tree.
  const user = { id: 'u1', displayName: 'Fixture owner', status: 'active', deletedAt: null,
    roles: [{ roleId: 'owner', role: { permissions: ['orders:read', 'orders:write', 'dictionary:write']
      .map(scope => ({ permission: { scope } })) } }] };

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as any[]).some(sub => matchWhere(row, sub));
      if (k === 'AND') return (v as any[]).every(sub => matchWhere(row, sub));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('equals' in cond) {
          return cond.mode === 'insensitive'
            ? String(row[k] ?? '').toLowerCase() === String(cond.equals).toLowerCase()
            : row[k] === cond.equals;
        }
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

  const businessLine = {
    findUnique: async ({ where }: any) =>
      businessLines.find(b => (where.id !== undefined ? b.id === where.id : b.code === where.code)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(businessLines.filter(b => matchWhere(b, where)), orderBy),
    count: async ({ where }: any = {}) => businessLines.filter(b => matchWhere(b, where)).length,
    create: async ({ data }: any) => {
      const row = { description: null, moqValue: null, moqUnit: null, productionCycleDays: null, paymentTermsHint: null, isActive: true, sortOrder: 0, deletedAt: null, ...data, id: data.id || `BL__T${++seq}` };
      businessLines.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = businessLines.find(b => b.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const order = {
    findUnique: async ({ where }: any) => orders.find(o => o.id === where.id) || null,
    findFirst: async ({ where }: any) => orders.find(o => matchWhere(o, where)) || null,
    findMany: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)),
    count: async ({ where }: any = {}) => orders.filter(o => matchWhere(o, where)).length,
    update: async ({ where, data }: any) => {
      const row = orders.find(o => o.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  const prisma: any = { businessLine, order,
    userAccount: { findFirst: async ({ where }: any) => matchWhere(user, where) ? user : null },
    userPermissionOverrides: { findMany: async () => [] },
    auditLog: { create: async ({ data }: any) => { audits.push(structuredClone(data)); return data; } },
    $queryRaw: async (query: any) => {
      const source = query.strings.join(' ').includes('"BusinessLine"') ? businessLines : orders;
      const value = query.values[0];
      return source.filter(row => row.id === value || row.code === value).map(row => ({ id: row.id }));
    },
    _stores: { businessLines, orders, audits, user },
  };
  prisma.$transaction = async (work: any) => {
    const before = structuredClone({ businessLines, orders, audits });
    try { return await work(prisma); }
    catch (error) {
      businessLines.splice(0, businessLines.length, ...before.businessLines);
      orders.splice(0, orders.length, ...before.orders);
      audits.splice(0, audits.length, ...before.audits);
      throw error;
    }
  };
  return prisma;
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
  // API-key read is still supported, with an explicit server-bound principal.
  app.use('/api/v1/business-lines', createBusinessLineRouter({ prisma, requireAuth: true, apiKeys,
    apiKeyActors: new Map<string, TokenPayload>([[validApiKey, { userId: 'u1', roles: ['owner'], permissions: [], departmentIds: [] }]]) }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

function seedOrder(prisma: any, over: Record<string, any> = {}) {
  const row = {
    id: `ORD-${prisma._stores.orders.length + 1}`,
    customer: 'Acme',
    product: 'Tee',
    quantity: 1000,
    status: 'InProduction',
    dueDate: '2026-09-01',
    clientDate: '2026-08-20',
    businessLine: null,
    millRelationId: null,
    deletedAt: null,
    updatedAt: null,
    ...over,
  };
  prisma._stores.orders.push(row);
  return row;
}

// ════════════════════════════════════════════════════════════════
// 业务线 CRUD
// ════════════════════════════════════════════════════════════════

describe('P0 · 业务线 CRUD', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createBL = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/business-lines').set(auth()).send(body);

  it('创建校验：code 必填 / 格式非法 / name 必填 → 400；code 归一化小写', async () => {
    const app = makeApp(prisma);
    expect((await createBL(app, { name: '面料大货' })).status).toBe(400);
    expect((await createBL(app, { code: '1fabric', name: '面料大货' })).status).toBe(400);
    expect((await createBL(app, { code: 'Fabric-Line', name: '面料大货' })).status).toBe(400);
    expect((await createBL(app, { code: 'fabric' })).status).toBe(400);

    const ok = await createBL(app, { code: 'Fabric', name: '面料大货', moqValue: 3000, moqUnit: 'M', sortOrder: 2 });
    expect(ok.status).toBe(201);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.item.code).toBe('fabric');
    expect(ok.body.item.isActive).toBe(true);
    expect(ok.body.item.moqValue).toBe(3000);
  });

  it('code 重复（含大小写变体）→ 400「业务线代码已存在」', async () => {
    const app = makeApp(prisma);
    await createBL(app, { code: 'fabric', name: '面料大货' });
    const dup = await createBL(app, { code: 'FABRIC', name: '面料大货二' });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('业务线代码已存在');
  });

  it('列表：默认仅 isActive；?includeInactive=true 含停用；sortOrder 升序', async () => {
    const app = makeApp(prisma);
    await createBL(app, { code: 'garment', name: '成衣大货', sortOrder: 2 });
    await createBL(app, { code: 'fabric', name: '面料大货', sortOrder: 1 });
    const inactive = await createBL(app, { code: 'capsule', name: '成衣 Capsule', sortOrder: 3 });
    await request(app).patch(`/api/v1/business-lines/${inactive.body.item.id}`).set(auth()).send({ isActive: false });

    const activeOnly = await request(app).get('/api/v1/business-lines').set(auth());
    expect(activeOnly.body.total).toBe(2);
    expect(activeOnly.body.items.map((b: any) => b.code)).toEqual(['fabric', 'garment']);

    const all = await request(app).get('/api/v1/business-lines?includeInactive=true').set(auth());
    expect(all.body.total).toBe(3);
    expect(all.body.items[2].code).toBe('capsule');
  });

  it('更新：白名单生效；code 不可改 → 400；不存在 → 404', async () => {
    const app = makeApp(prisma);
    const created = await createBL(app, { code: 'fabric', name: '面料大货' });
    const id = created.body.item.id;

    const updated = await request(app).patch(`/api/v1/business-lines/${id}`).set(auth())
      .send({ name: '面料大货（更新）', productionCycleDays: 70, hackerField: 'x' });
    expect(updated.status).toBe(200);
    expect(updated.body.item.name).toBe('面料大货（更新）');
    expect(updated.body.item.productionCycleDays).toBe(70);
    expect(updated.body.item.hackerField).toBeUndefined();

    const codeChange = await request(app).patch(`/api/v1/business-lines/${id}`).set(auth()).send({ code: 'other' });
    expect(codeChange.status).toBe(400);
    expect(codeChange.body.error.message).toContain('不可修改');

    expect((await request(app).patch('/api/v1/business-lines/BL__NOPE').set(auth()).send({ name: 'x' })).status).toBe(404);
  });

  it('删除：软删成功；仍有订单引用 → 400「仍有订单引用此业务线，不可删除」', async () => {
    const app = makeApp(prisma);
    const fabric = (await createBL(app, { code: 'fabric', name: '面料大货' })).body.item;
    const garment = (await createBL(app, { code: 'garment', name: '成衣大货' })).body.item;

    seedOrder(prisma, { id: 'ORD-REF', businessLine: 'fabric' });

    const blocked = await request(app).delete(`/api/v1/business-lines/${fabric.id}`).set(auth());
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toContain('仍有订单引用此业务线，不可删除');

    expect((await request(app).delete(`/api/v1/business-lines/${garment.id}`).set(auth())).status).toBe(200);
    const all = await request(app).get('/api/v1/business-lines').set(auth());
    expect(all.body.items.map((b: any) => b.code)).toEqual(['fabric']);
  });

  it('API-Key 写操作 → 401；读操作放行', async () => {
    const app = makeApp(prisma);
    await createBL(app, { code: 'fabric', name: '面料大货' });

    const byKey = request(app).post('/api/v1/business-lines').set('X-Bambook-API-Key', validApiKey);
    expect((await byKey.send({ code: 'garment', name: '成衣大货' })).status).toBe(401);

    const read = await request(app).get('/api/v1/business-lines').set('X-Bambook-API-Key', validApiKey);
    expect(read.status).toBe(200);
    expect(read.body.total).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// 订单业务线标记 + MOQ 软校验
// ════════════════════════════════════════════════════════════════

describe('P0 · 订单业务线标记与 MOQ 校验', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  const createBL = (app: any, body: Record<string, any>) =>
    request(app).post('/api/v1/business-lines').set(auth()).send(body);

  it('setOrderBusinessLine：设置 / 清除 / 停用拒绝 / 订单不存在 404 / 业务线不存在 404', async () => {
    const app = makeApp(prisma);
    const fabric = (await createBL(app, { code: 'fabric', name: '面料大货' })).body.item;
    const capsule = (await createBL(app, { code: 'capsule', name: '成衣 Capsule' })).body.item;
    await request(app).patch(`/api/v1/business-lines/${capsule.id}`).set(auth()).send({ isActive: false });
    seedOrder(prisma, { id: 'ORD-1' });

    const set = await request(app).put('/api/v1/business-lines/order/ORD-1').set(auth()).send({ businessLine: 'FABRIC' });
    expect(set.status).toBe(200);
    expect(set.body.item.businessLine).toBe('fabric'); // 归一化小写

    const inactive = await request(app).put('/api/v1/business-lines/order/ORD-1').set(auth()).send({ businessLine: 'capsule' });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.message).toContain('业务线已停用');

    const missingBL = await request(app).put('/api/v1/business-lines/order/ORD-1').set(auth()).send({ businessLine: 'nope' });
    expect(missingBL.status).toBe(404);

    const missingOrder = await request(app).put('/api/v1/business-lines/order/ORD-NOPE').set(auth()).send({ businessLine: 'fabric' });
    expect(missingOrder.status).toBe(404);

    const cleared = await request(app).put('/api/v1/business-lines/order/ORD-1').set(auth()).send({ businessLine: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.item.businessLine).toBeNull();
    void fabric;
  });

  it('moq-check 三分支：未标记 / 未配置 MOQ / 合规与违规', async () => {
    const app = makeApp(prisma);
    await createBL(app, { code: 'fabric', name: '面料大货', moqValue: 3000, moqUnit: 'M' });
    await createBL(app, { code: 'garment', name: '成衣大货' }); // 未配置 MOQ

    seedOrder(prisma, { id: 'ORD-UNMARKED' });
    seedOrder(prisma, { id: 'ORD-NOMOQ', businessLine: 'garment' });
    seedOrder(prisma, { id: 'ORD-OK', businessLine: 'fabric', quantity: 5000 });
    seedOrder(prisma, { id: 'ORD-LOW', businessLine: 'fabric', quantity: 1000 });

    const unmarked = await request(app).get('/api/v1/business-lines/order/ORD-UNMARKED/moq-check').set(auth());
    expect(unmarked.body).toEqual({ checked: false, reason: '未标记业务线' });

    const noMoq = await request(app).get('/api/v1/business-lines/order/ORD-NOMOQ/moq-check').set(auth());
    expect(noMoq.body).toEqual({ checked: false, reason: '该业务线未配置 MOQ' });

    const ok = await request(app).get('/api/v1/business-lines/order/ORD-OK/moq-check').set(auth());
    expect(ok.body.checked).toBe(true);
    expect(ok.body.compliant).toBe(true);
    expect(ok.body.violations).toEqual([]);
    expect(ok.body.businessLine).toBe('fabric');

    const low = await request(app).get('/api/v1/business-lines/order/ORD-LOW/moq-check').set(auth());
    expect(low.body.checked).toBe(true);
    expect(low.body.compliant).toBe(false);
    expect(low.body.violations).toEqual([{ rule: 'moq', expected: 3000, actual: 1000, unit: 'M' }]);

    expect((await request(app).get('/api/v1/business-lines/order/ORD-NOPE/moq-check').set(auth())).status).toBe(404);
  });

  it('遗漏 businessLine 不再隐式清除；成功回包只含该命令的订单字段与审计', async () => {
    const app = makeApp(prisma);
    await createBL(app, { code: 'fabric', name: '面料大货' });
    seedOrder(prisma, { id: 'ORD-EXPLICIT', businessLine: 'fabric', actualCost: 9999 });
    const before = structuredClone(prisma._stores);
    expect((await request(app).put('/api/v1/business-lines/order/ORD-EXPLICIT').set(auth()).send({})).status).toBe(400);
    expect(prisma._stores).toEqual(before);
    const cleared = await request(app).put('/api/v1/business-lines/order/ORD-EXPLICIT').set(auth()).send({ businessLine: null });
    expect(cleared.status).toBe(200);
    expect(Object.keys(cleared.body.item).sort()).toEqual(['auditId', 'businessLine', 'id', 'updatedAt']);
    expect(cleared.body.item.actualCost).toBeUndefined();
    expect(prisma._stores.audits.at(-1).actorId).toBe('u1');
  });

  it('当前已加载的空权限不能由旧 JWT owner 恢复；未知错误不泄内部详情', async () => {
    const app = makeApp(prisma);
    prisma._stores.user.roles = [{ roleId: 'custom-role', role: { permissions: [] } }];
    expect((await request(app).get('/api/v1/business-lines').set(auth())).status).toBe(403);
    expect((await createBL(app, { code: 'fabric', name: '面料大货' })).status).toBe(403);
    expect(prisma._stores.businessLines).toEqual([]);
    prisma.userAccount.findFirst = async () => { throw Error('private SQL /not/public'); };
    const unavailable = await request(app).get('/api/v1/business-lines').set(auth());
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(JSON.stringify(unavailable.body)).not.toContain('private SQL');
  });
});
