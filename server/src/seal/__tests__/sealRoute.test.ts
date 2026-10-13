import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const adminToken = jwt.sign({ userId: 'u1', roles: ['role-super-admin'] }, SECRET);
const salesToken = jwt.sign({ userId: 'u2', roles: ['role-sales'] }, SECRET);

import { createSealRouter } from '../sealRoute';

/**
 * §10.3-9 印章库测试。Mock Prisma 内存存储 Seal，语义对齐真实 client 子集
 * （含 $transaction / updateMany）。印章敏感，路由强制 JWT-only + 管理员角色。
 */
function makeMockPrisma() {
  let seq = 0;
  const seals: any[] = [];
  const audits: any[] = [];

  const matchWhere = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const cond: any = v;
        if ('in' in cond) return cond.in.includes(row[k]);
        if ('not' in cond) return cond.not === null ? row[k] !== null : row[k] !== cond.not;
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

  const seal = {
    findFirst: async ({ where }: any = {}) => seals.find((r) => matchWhere(r, where)) || null,
    findMany: async ({ where, orderBy }: any = {}) => applyOrderBy(seals.filter((r) => matchWhere(r, where)), orderBy),
    create: async ({ data }: any) => {
      const row = { isDefault: false, isActive: true, deletedAt: null, ownerRoleId: null, ownerUserId: null, notes: null, ...data, id: data.id || `SEAL__T${++seq}` };
      seals.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = seals.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of seals) {
        if (matchWhere(row, where)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
  };

  const auditLog = { create: async ({ data }: any) => { audits.push(data); return data; } };

  const prisma: any = { seal, auditLog, $transaction: async (fn: any) => fn(prisma), _stores: { seals, audits } };
  return prisma;
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string, string> = {};
      req.headers.cookie.split(';').forEach((c: string) => { const [k, v] = c.trim().split('='); cookies[k] = v; });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/seals', createSealRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return app;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SEAL_BODY = { name: '公司公章', type: 'company_seal', imageDataUrl: PNG, isDefault: true };

describe('§10.3-9 Seal', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeMockPrisma();
    app = makeApp(prisma);
  });

  it('创建印章校验：缺名/非图片/非法类型 → 400', async () => {
    const noName = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send({ ...SEAL_BODY, name: '' });
    expect(noName.status).toBe(400);
    const noImg = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send({ ...SEAL_BODY, imageDataUrl: 'https://x/y.png' });
    expect(noImg.status).toBe(400);
    const badType = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send({ ...SEAL_BODY, type: 'stamp' });
    expect(badType.status).toBe(400);
  });

  it('默认章全局唯一：新默认清除旧默认', async () => {
    const first = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send(SEAL_BODY);
    const second = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send({ ...SEAL_BODY, name: '老板私章', type: 'legal_rep_seal' });
    expect(second.status).toBe(201);
    const stores = (prisma as any)._stores;
    expect(stores.seals.find((s: any) => s.id === first.body.item.id).isDefault).toBe(false);
    expect(stores.seals.find((s: any) => s.id === second.body.item.id).isDefault).toBe(true);
  });

  it('resolve 优先级：ownerUser > ownerRole > isDefault > null', async () => {
    await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send(SEAL_BODY); // 默认公司公章
    await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send({ name: '销售主管章', type: 'other', imageDataUrl: PNG, ownerRoleId: 'role-sales-manager' });
    await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send({ name: '老板私章', type: 'legal_rep_seal', imageDataUrl: PNG, ownerUserId: 'u-boss' });

    const byUser = await request(app).get('/api/v1/seals/resolve?userId=u-boss').set('Authorization', `Bearer ${adminToken}`);
    expect(byUser.body.seal.name).toBe('老板私章');

    const byRole = await request(app).get('/api/v1/seals/resolve?roleId=role-sales-manager').set('Authorization', `Bearer ${adminToken}`);
    expect(byRole.body.seal.name).toBe('销售主管章');

    const fallback = await request(app).get('/api/v1/seals/resolve?roleId=role-qc').set('Authorization', `Bearer ${adminToken}`);
    expect(fallback.body.seal.name).toBe('公司公章');

    const none = await request(app).get('/api/v1/seals/resolve').set('Authorization', `Bearer ${adminToken}`);
    expect(none.body.seal.name).toBe('公司公章');
  });

  it('软删后 GET 404 / 列表不可见', async () => {
    const created = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`).send(SEAL_BODY);
    const id = created.body.item.id;
    await request(app).delete(`/api/v1/seals/${id}`).set('Authorization', `Bearer ${adminToken}`);
    const got = await request(app).get(`/api/v1/seals/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(got.status).toBe(404);
    const list = await request(app).get('/api/v1/seals').set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.total).toBe(0);
  });

  it('非管理员 403；API-Key 写/读均 401（强制 JWT-only）', async () => {
    const salesWrite = await request(app).post('/api/v1/seals').set('Authorization', `Bearer ${salesToken}`).send(SEAL_BODY);
    expect(salesWrite.status).toBe(403);
    const salesRead = await request(app).get('/api/v1/seals').set('Authorization', `Bearer ${salesToken}`);
    expect(salesRead.status).toBe(403);

    const keyWrite = await request(app).post('/api/v1/seals').set('x-bambook-api-key', 'k').send(SEAL_BODY);
    expect(keyWrite.status).toBe(401);
    const keyRead = await request(app).get('/api/v1/seals').set('x-bambook-api-key', 'k');
    expect(keyRead.status).toBe(401);
  });
});
