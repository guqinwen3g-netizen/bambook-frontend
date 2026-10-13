import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);

// 对齐生产运行时：index.ts 全局 BigInt toJSON 补丁（测试不加载 index.ts，需显式对齐）
(BigInt.prototype as any).toJSON = function () { return Number(this); };

import { createCrmRouter } from '../crmRoute';

/**
 * P3b 品牌线/沟通日志测试。Mock Prisma 内存存储 Relation + BrandLine + CommunicationLog + Contact，
 * 语义对齐真实 client 的本测试用到的子集。
 */
function makeMockPrisma() {
  let seq = 0;
  const relations: any[] = [
    { id: 'REL__C1', name: '某欧洲品牌客户', deletedAt: null },
    { id: 'REL__DELETED', name: '已删客户', deletedAt: 1n },
  ];
  const brandLines: any[] = [];
  const commLogs: any[] = [];
  const contacts: any[] = [
    { id: 'CT__1', relationId: 'REL__C1', name: 'John', deletedAt: null },
    { id: 'CT__OTHER', relationId: 'REL__OTHER', name: 'Alien', deletedAt: null },
  ];
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

  const makeCrud = (store: any[], prefix: string) => ({
    findFirst: async ({ where }: any = {}) => store.find(r => matchWhere(r, where)) || null,
    findMany: async ({ where, orderBy, take, skip }: any = {}) => {
      const rows = applyOrderBy(store.filter(r => matchWhere(r, where)), orderBy);
      return rows.slice(skip || 0, (skip || 0) + (take ?? rows.length));
    },
    count: async ({ where }: any = {}) => store.filter(r => matchWhere(r, where)).length,
    create: async ({ data }: any) => {
      const row = { deletedAt: null, ...data, id: data.id || `${prefix}__T${++seq}` };
      store.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = store.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  });

  const prisma: any = {
    relation: makeCrud(relations, 'REL'),
    brandLine: makeCrud(brandLines, 'BL'),
    communicationLog: makeCrud(commLogs, 'CL'),
    contact: makeCrud(contacts, 'CT'),
    auditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
    _stores: { relations, brandLines, commLogs, contacts, audits },
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
  app.use('/api/v1/crm', createCrmRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  return app;
}

const AUTH = () => ({ Authorization: `Bearer ${ownerToken}` });

describe('P3b BrandLine', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeMockPrisma();
    app = makeApp(prisma);
  });

  it('创建品牌线并列表返回', async () => {
    const res = await request(app)
      .post('/api/v1/crm/REL__C1/brand-lines')
      .set(AUTH())
      .send({ name: '正装线', code: 'FORMAL', description: '西装/大衣' });
    expect(res.status).toBe(201);
    expect(res.body.item.name).toBe('正装线');
    expect(res.body.item.isActive).toBe(true);

    const list = await request(app).get('/api/v1/crm/REL__C1/brand-lines').set(AUTH());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
  });

  it('同客户下名称重复 → 409；不同客户互不影响', async () => {
    await request(app).post('/api/v1/crm/REL__C1/brand-lines').set(AUTH()).send({ name: '休闲线' });
    const dup = await request(app).post('/api/v1/crm/REL__C1/brand-lines').set(AUTH()).send({ name: '休闲线' });
    expect(dup.status).toBe(409);

    // 改名冲突同样拒绝
    const other = await request(app).post('/api/v1/crm/REL__C1/brand-lines').set(AUTH()).send({ name: '设计师线' });
    const rename = await request(app)
      .put(`/api/v1/crm/brand-lines/${other.body.item.id}`)
      .set(AUTH())
      .send({ name: '休闲线' });
    expect(rename.status).toBe(409);
  });

  it('客户不存在或已软删 → 404', async () => {
    const missing = await request(app).post('/api/v1/crm/REL__NOPE/brand-lines').set(AUTH()).send({ name: 'X' });
    expect(missing.status).toBe(404);
    const deleted = await request(app).post('/api/v1/crm/REL__DELETED/brand-lines').set(AUTH()).send({ name: 'X' });
    expect(deleted.status).toBe(404);
  });

  it('软删后列表不可见；停用后 includeInactive 可见', async () => {
    const a = await request(app).post('/api/v1/crm/REL__C1/brand-lines').set(AUTH()).send({ name: '正装线' });
    const b = await request(app).post('/api/v1/crm/REL__C1/brand-lines').set(AUTH()).send({ name: '休闲线' });

    await request(app).put(`/api/v1/crm/brand-lines/${b.body.item.id}`).set(AUTH()).send({ isActive: false });
    const activeOnly = await request(app).get('/api/v1/crm/REL__C1/brand-lines').set(AUTH());
    expect(activeOnly.body.total).toBe(1);

    const all = await request(app).get('/api/v1/crm/REL__C1/brand-lines?includeInactive=1').set(AUTH());
    expect(all.body.total).toBe(2);

    await request(app).delete(`/api/v1/crm/brand-lines/${a.body.item.id}`).set(AUTH());
    const afterDelete = await request(app).get('/api/v1/crm/REL__C1/brand-lines?includeInactive=1').set(AUTH());
    expect(afterDelete.body.total).toBe(1);
  });
});

describe('P3b CommunicationLog', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeMockPrisma();
    app = makeApp(prisma);
  });

  const LOG_BODY = {
    type: 'Email',
    direction: 'Outbound',
    subject: '报价跟进',
    summary: '发送 QT-2026-001 报价单，客户要求本周五前确认',
    occurredAt: '2026-08-08',
  };

  it('创建沟通日志并列表返回（按日期倒序）', async () => {
    const res = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send(LOG_BODY);
    expect(res.status).toBe(201);
    expect(res.body.item.loggedBy).toBe('u1');

    await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH())
      .send({ ...LOG_BODY, type: 'Call', occurredAt: '2026-08-07', summary: '电话确认交期' });

    const list = await request(app).get('/api/v1/crm/REL__C1/comm-logs').set(AUTH());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].occurredAt).toBe('2026-08-08');
    expect(list.body.items[1].occurredAt).toBe('2026-08-07');
  });

  it('非法类型/方向/日期格式/缺摘要 → 400', async () => {
    const badType = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send({ ...LOG_BODY, type: 'SMS' });
    expect(badType.status).toBe(400);

    const badDir = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send({ ...LOG_BODY, direction: 'Sideways' });
    expect(badDir.status).toBe(400);

    const badDate = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send({ ...LOG_BODY, occurredAt: '08/08/2026' });
    expect(badDate.status).toBe(400);

    const noSummary = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send({ ...LOG_BODY, summary: ' ' });
    expect(noSummary.status).toBe(400);
  });

  it('联系人须属于该客户（跨客户联系人 → 400）', async () => {
    const ok = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send({ ...LOG_BODY, contactId: 'CT__1' });
    expect(ok.status).toBe(201);

    const alien = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send({ ...LOG_BODY, contactId: 'CT__OTHER' });
    expect(alien.status).toBe(400);
  });

  it('按 type/direction 过滤', async () => {
    await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send(LOG_BODY);
    await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH())
      .send({ ...LOG_BODY, type: 'WeChat', direction: 'Inbound', summary: '微信收到客户确认' });

    const emailOnly = await request(app).get('/api/v1/crm/REL__C1/comm-logs?type=Email').set(AUTH());
    expect(emailOnly.body.total).toBe(1);

    const inbound = await request(app).get('/api/v1/crm/REL__C1/comm-logs?direction=Inbound').set(AUTH());
    expect(inbound.body.total).toBe(1);
    expect(inbound.body.items[0].type).toBe('WeChat');
  });

  it('更新与软删', async () => {
    const created = await request(app).post('/api/v1/crm/REL__C1/comm-logs').set(AUTH()).send(LOG_BODY);
    const id = created.body.item.id;

    const updated = await request(app).put(`/api/v1/crm/comm-logs/${id}`).set(AUTH())
      .send({ summary: '更新摘要：客户已确认报价', orderId: 'ORD__1' });
    expect(updated.status).toBe(200);
    expect(updated.body.item.summary).toContain('已确认');
    expect(updated.body.item.orderId).toBe('ORD__1');

    await request(app).delete(`/api/v1/crm/comm-logs/${id}`).set(AUTH());
    const list = await request(app).get('/api/v1/crm/REL__C1/comm-logs').set(AUTH());
    expect(list.body.total).toBe(0);

    const updateDeleted = await request(app).put(`/api/v1/crm/comm-logs/${id}`).set(AUTH()).send({ summary: 'x' });
    expect(updateDeleted.status).toBe(404);
  });
});
