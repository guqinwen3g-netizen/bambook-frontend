import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

// 对齐生产运行时：index.ts 全局 BigInt toJSON 补丁（测试不加载 index.ts，需显式对齐）
(BigInt.prototype as any).toJSON = function () { return Number(this); };

import { createDocumentTemplateRouter } from '../documentTemplateRoute';
import { createCustomsRouter } from '../customsRoute';

/**
 * P3a 单据模板/版本测试。Mock Prisma 内存存储 DocumentTemplate + DocumentVersion + TradeDocument，
 * 语义对齐真实 client 的本测试用到的子集（含 $transaction / updateMany / 唯一键 documentId_version）。
 */
function makeMockPrisma() {
  let seq = 0;
  const templates: any[] = [];
  const versions: any[] = [];
  const documents: any[] = [
    { id: 'TD__1', documentNumber: 'INV-2026-001', type: 'Other', status: 'Draft', deletedAt: null },
    { id: 'TD__DELETED', documentNumber: 'INV-DEL', type: 'Other', status: 'Draft', deletedAt: 1n },
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

  const documentTemplate = {
    findFirst: async ({ where }: any = {}) => templates.find(r => matchWhere(r, where)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(templates.filter(r => matchWhere(r, where)), orderBy),
    create: async ({ data }: any) => {
      const row = { isDefault: false, isActive: true, deletedAt: null, ...data, id: data.id || `DTPL__T${++seq}` };
      templates.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = templates.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of templates) {
        if (matchWhere(row, where)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
  };

  const documentVersion = {
    findFirst: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(versions.filter(r => matchWhere(r, where)), orderBy)[0] || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(versions.filter(r => matchWhere(r, where)), orderBy),
    findUnique: async ({ where }: any) => {
      const key = where.documentId_version;
      return versions.find(r => r.documentId === key.documentId && r.version === key.version) || null;
    },
    create: async ({ data }: any) => {
      const dup = versions.find(r => r.documentId === data.documentId && r.version === data.version);
      if (dup) throw new Error('Unique constraint failed: documentId_version');
      const row = { ...data, id: data.id || `DVER__T${++seq}` };
      versions.push(row);
      return row;
    },
  };

  const tradeDocument = {
    findFirst: async ({ where }: any = {}) => documents.find(r => matchWhere(r, where)) || null,
  };

  const auditLog = {
    findFirst: async () => null,
    findMany: async () => [],
    create: async ({ data }: any) => {
      audits.push(data);
      return data;
    },
  };

  const prisma: any = {
    documentTemplate,
    documentVersion,
    tradeDocument,
    auditLog,
    $transaction: async (fn: any) => fn(prisma),
    _stores: { templates, versions, documents, audits },
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
  app.use('/api/v1/document-templates', createDocumentTemplateRouter({ prisma, requireAuth: true, apiKeys }));
  app.use('/api/v1/customs', createCustomsRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const TPL_BODY = {
  type: 'CommercialInvoice',
  name: '商业发票标准模板-中英',
  content: '<h1>{{companyName}}</h1><p>INV: {{invoiceNo}}</p><p>{{customerName}} 应付 {{totalAmount}}</p>',
};

describe('P3a DocumentTemplate', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeMockPrisma();
    app = makeApp(prisma);
  });

  it('创建模板自动解析变量（去重保序）', async () => {
    const res = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(TPL_BODY);
    expect(res.status).toBe(201);
    expect(res.body.item.variables).toEqual(['companyName', 'invoiceNo', 'customerName', 'totalAmount']);
    expect(res.body.item.language).toBe('bilingual');
    expect(res.body.item.isActive).toBe(true);
  });

  it('非法 type / 缺必填字段 → 400', async () => {
    const badType = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, type: 'NotAType' });
    expect(badType.status).toBe(400);

    const noContent = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, content: '' });
    expect(noContent.status).toBe(400);
  });

  it('同 type+language 默认模板唯一：新默认清除旧默认', async () => {
    const first = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, isDefault: true });
    expect(first.status).toBe(201);
    const firstId = first.body.item.id;

    const second = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, name: '商业发票模板V2', isDefault: true });
    expect(second.status).toBe(201);

    const stores = (prisma as any)._stores;
    const oldDefault = stores.templates.find((t: any) => t.id === firstId);
    expect(oldDefault.isDefault).toBe(false);
    const newDefault = stores.templates.find((t: any) => t.id === second.body.item.id);
    expect(newDefault.isDefault).toBe(true);
  });

  it('不同 language 互不影响默认唯一性', async () => {
    await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, isDefault: true, language: 'zh' });
    const en = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, name: 'CI EN', isDefault: true, language: 'en' });
    expect(en.status).toBe(201);
    const stores = (prisma as any)._stores;
    const defaults = stores.templates.filter((t: any) => t.isDefault);
    expect(defaults).toHaveLength(2);
  });

  it('PATCH content 时重解析变量；PATCH isDefault=true 清除其他默认', async () => {
    const a = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, isDefault: true });
    const b = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...TPL_BODY, name: 'B' });

    const patch = await request(app)
      .patch(`/api/v1/document-templates/${b.body.item.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: '<p>{{invoiceNo}} / {{invoiceDate}}</p>', isDefault: true });
    expect(patch.status).toBe(200);
    expect(patch.body.item.variables).toEqual(['invoiceNo', 'invoiceDate']);

    const stores = (prisma as any)._stores;
    expect(stores.templates.find((t: any) => t.id === a.body.item.id).isDefault).toBe(false);
    expect(stores.templates.find((t: any) => t.id === b.body.item.id).isDefault).toBe(true);
  });

  it('软删后 GET 404 / 列表不可见', async () => {
    const created = await request(app)
      .post('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(TPL_BODY);
    const id = created.body.item.id;

    const del = await request(app)
      .delete(`/api/v1/document-templates/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/document-templates/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(get.status).toBe(404);

    const list = await request(app)
      .get('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.total).toBe(0);
  });

  it('list 按 type 过滤 + includeInactive 口径', async () => {
    await request(app).post('/api/v1/document-templates').set('Authorization', `Bearer ${ownerToken}`).send(TPL_BODY);
    await request(app).post('/api/v1/document-templates').set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'PackingList', name: '装箱单模板', content: '<p>{{plNo}}</p>', isActive: false });

    const ciOnly = await request(app)
      .get('/api/v1/document-templates?type=CommercialInvoice')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ciOnly.body.total).toBe(1);

    const activeOnly = await request(app)
      .get('/api/v1/document-templates')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(activeOnly.body.total).toBe(1);

    const withInactive = await request(app)
      .get('/api/v1/document-templates?includeInactive=1')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(withInactive.body.total).toBe(2);
  });

  it('写操作必须 JWT（API-Key 写被拒，读放行）', async () => {
    const writeByKey = await request(app)
      .post('/api/v1/document-templates')
      .set('x-bambook-api-key', validApiKey)
      .send(TPL_BODY);
    expect(writeByKey.status).toBe(401);

    await request(app).post('/api/v1/document-templates').set('Authorization', `Bearer ${ownerToken}`).send(TPL_BODY);
    const readByKey = await request(app)
      .get('/api/v1/document-templates')
      .set('x-bambook-api-key', validApiKey);
    expect(readByKey.status).toBe(200);
    expect(readByKey.body.total).toBe(1);
  });
});

describe('P3a DocumentVersion', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeMockPrisma();
    app = makeApp(prisma);
  });

  it('版本号从 1 起单调递增；listVersions 按 version desc', async () => {
    const v1 = await request(app)
      .post('/api/v1/customs/trade-documents/TD__1/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: { totalAmount: 100 }, changeReason: '初始定稿' });
    expect(v1.status).toBe(201);
    expect(v1.body.item.version).toBe(1);

    const v2 = await request(app)
      .post('/api/v1/customs/trade-documents/TD__1/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: { totalAmount: 120 }, changeReason: '改金额' });
    expect(v2.status).toBe(201);
    expect(v2.body.item.version).toBe(2);
    expect(v2.body.item.changedBy).toBe('u1');

    const list = await request(app)
      .get('/api/v1/customs/trade-documents/TD__1/versions')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].version).toBe(2);
    expect(list.body.items[1].version).toBe(1);
  });

  it('单据不存在或已软删 → 404', async () => {
    const missing = await request(app)
      .post('/api/v1/customs/trade-documents/TD__NOPE/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: { a: 1 } });
    expect(missing.status).toBe(404);

    const deleted = await request(app)
      .post('/api/v1/customs/trade-documents/TD__DELETED/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: { a: 1 } });
    expect(deleted.status).toBe(404);
  });

  it('content 非法（缺失/数组）→ 400', async () => {
    const noContent = await request(app)
      .post('/api/v1/customs/trade-documents/TD__1/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(noContent.status).toBe(400);

    const arrayContent = await request(app)
      .post('/api/v1/customs/trade-documents/TD__1/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: [1, 2] });
    expect(arrayContent.status).toBe(400);
  });

  it('按 documentId+version 取单版本；非法版本号 400', async () => {
    await request(app)
      .post('/api/v1/customs/trade-documents/TD__1/versions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: { totalAmount: 100 } });

    const got = await request(app)
      .get('/api/v1/customs/trade-documents/TD__1/versions/1')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(got.status).toBe(200);
    expect(got.body.item.content.totalAmount).toBe(100);

    const badVersion = await request(app)
      .get('/api/v1/customs/trade-documents/TD__1/versions/abc')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(badVersion.status).toBe(400);

    const missing = await request(app)
      .get('/api/v1/customs/trade-documents/TD__1/versions/9')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
  });
});
