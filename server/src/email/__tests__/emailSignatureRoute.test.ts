import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createEmailSignatureRouter } from '../signatureRoute';

/**
 * P3b 邮件签名测试。Mock Prisma 内存存储 EmailSignature，
 * 语义对齐真实 client 的本测试用到的子集（含 $transaction / updateMany）。
 */
function makeMockPrisma() {
  let seq = 0;
  const signatures: any[] = [];
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

  const emailSignature = {
    findFirst: async ({ where }: any = {}) => signatures.find(r => matchWhere(r, where)) || null,
    findMany: async ({ where, orderBy }: any = {}) =>
      applyOrderBy(signatures.filter(r => matchWhere(r, where)), orderBy),
    create: async ({ data }: any) => {
      const row = { isDefault: false, isActive: true, deletedAt: null, ...data, id: data.id || `ESIG__T${++seq}` };
      signatures.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = signatures.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of signatures) {
        if (matchWhere(row, where)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
  };

  const auditLog = {
    create: async ({ data }: any) => {
      audits.push(data);
      return data;
    },
  };

  const prisma: any = {
    emailSignature,
    auditLog,
    $transaction: async (fn: any) => fn(prisma),
    _stores: { signatures, audits },
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
  app.use('/api/v1/email-signatures', createEmailSignatureRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const SIG_BODY = {
  name: '默认英文签名',
  language: 'en',
  content: '<p>Best regards,<br/>{{senderName}}<br/>Bambook Trading Co., Ltd.<br/>Tel: {{companyPhone}}</p>',
};

describe('P3b EmailSignature', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let app: express.Express;

  beforeEach(() => {
    prisma = makeMockPrisma();
    app = makeApp(prisma);
  });

  it('创建签名自动解析变量', async () => {
    const res = await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(SIG_BODY);
    expect(res.status).toBe(201);
    expect(res.body.item.variables).toEqual(['senderName', 'companyPhone']);
    expect(res.body.item.isActive).toBe(true);
  });

  it('缺必填字段/非法语言 → 400', async () => {
    const noContent = await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...SIG_BODY, content: '' });
    expect(noContent.status).toBe(400);

    const badLang = await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...SIG_BODY, language: 'fr' });
    expect(badLang.status).toBe(400);
  });

  it('同 language 默认签名唯一：新默认清除旧默认；不同 language 互不影响', async () => {
    const first = await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...SIG_BODY, isDefault: true });
    const second = await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ...SIG_BODY, name: '备用英文签名', isDefault: true });
    expect(second.status).toBe(201);

    const stores = (prisma as any)._stores;
    expect(stores.signatures.find((s: any) => s.id === first.body.item.id).isDefault).toBe(false);
    expect(stores.signatures.find((s: any) => s.id === second.body.item.id).isDefault).toBe(true);

    // 中文签名设默认不影响英文默认
    await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '默认中文签名', language: 'zh', content: '<p>此致<br/>{{senderName}}</p>', isDefault: true });
    const defaults = stores.signatures.filter((s: any) => s.isDefault);
    expect(defaults).toHaveLength(2);
  });

  it('PATCH content 重解析变量；软删后 GET 404 / 列表不可见', async () => {
    const created = await request(app)
      .post('/api/v1/email-signatures')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(SIG_BODY);
    const id = created.body.item.id;

    const patched = await request(app)
      .patch(`/api/v1/email-signatures/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: '<p>Regards, {{senderName}} — {{senderEmail}}</p>' });
    expect(patched.status).toBe(200);
    expect(patched.body.item.variables).toEqual(['senderName', 'senderEmail']);

    await request(app).delete(`/api/v1/email-signatures/${id}`).set('Authorization', `Bearer ${ownerToken}`);
    const got = await request(app).get(`/api/v1/email-signatures/${id}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(got.status).toBe(404);
    const list = await request(app).get('/api/v1/email-signatures').set('Authorization', `Bearer ${ownerToken}`);
    expect(list.body.total).toBe(0);
  });

  it('写操作必须 JWT（API-Key 写被拒，读放行）', async () => {
    const writeByKey = await request(app)
      .post('/api/v1/email-signatures')
      .set('x-bambook-api-key', validApiKey)
      .send(SIG_BODY);
    expect(writeByKey.status).toBe(401);

    await request(app).post('/api/v1/email-signatures').set('Authorization', `Bearer ${ownerToken}`).send(SIG_BODY);
    const readByKey = await request(app)
      .get('/api/v1/email-signatures')
      .set('x-bambook-api-key', validApiKey);
    expect(readByKey.status).toBe(200);
    expect(readByKey.body.total).toBe(1);
  });
});
