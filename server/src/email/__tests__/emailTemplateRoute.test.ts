import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const viewerToken = jwt.sign({ userId: 'u3', roles: ['viewer'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createEmailTemplateRouter, extractTemplateVariables, STANDARD_EMAIL_TEMPLATES } from '../templateRoute';
import { createEmailRouter } from '../route';

function makeMockPrisma() {
  const store: any[] = [];
  let seq = 0;
  const emailTemplate = {
    findMany: async ({ where }: any = {}) =>
      store.filter(r => r.deletedAt === null && (!where?.type || r.type === where.type) && (where?.isActive === undefined || r.isActive === where.isActive)),
    findFirst: async ({ where }: any) =>
      store.find(r =>
        (where.id === undefined || r.id === where.id) &&
        (where.type === undefined || r.type === where.type) &&
        (where.name === undefined || r.name === where.name) &&
        (where.deletedAt === null ? r.deletedAt === null : true),
      ) || null,
    create: async ({ data }: any) => {
      const row = { deletedAt: null, isActive: true, ...data, id: data.id || `EMTPL__T${++seq}` };
      store.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = store.find(r => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    _store: store,
  };
  const email = {
    findMany: async ({ where }: any = {}) => {
      // 仅服务 /intents 测试：由测试用例注入 _rows
      const rows: any[] = (email as any)._rows || [];
      return rows.filter(r =>
        r.mailbox === where.mailbox &&
        where.uid.in.includes(r.uid) &&
        r.deletedAt === null,
      );
    },
    _rows: [] as any[],
  };
  return { emailTemplate, email };
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
  app.use('/api/v1/email-templates', createEmailTemplateRouter({ prisma, requireAuth: true, apiKeys }));
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

describe('extractTemplateVariables', () => {
  it('解析 {{var}} 占位符并去重保序', () => {
    expect(extractTemplateVariables('Hi {{customerName}}, re {{orderNo}}', 'ref {{customerName}} & {{ amount }}')).toEqual([
      'customerName', 'orderNo', 'amount',
    ]);
  });

  it('无占位符 → 空数组', () => {
    expect(extractTemplateVariables('plain text', '')).toEqual([]);
  });
});

describe('F5 · EmailTemplate CRUD', () => {
  let prisma: any;
  beforeEach(() => { prisma = makeMockPrisma(); });

  it('POST / 创建模板并自动解析变量', async () => {
    const res = await request(makeApp(prisma)).post('/api/v1/email-templates').set(auth()).send({
      type: 'quote', name: '测试报价', subject: 'Quote {{quotationNo}}', body: 'Dear {{customerName}}, see {{quotationNo}}.',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.item.variables).toEqual(['quotationNo', 'customerName']);
  });

  it('POST / 缺字段 → 400 INVALID_INPUT', async () => {
    const res = await request(makeApp(prisma)).post('/api/v1/email-templates').set(auth()).send({ type: 'quote', name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('POST / 非法 type → 400 INVALID_TYPE', async () => {
    const res = await request(makeApp(prisma)).post('/api/v1/email-templates').set(auth()).send({ type: 'hack', name: 'n', subject: 's', body: 'b' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TYPE');
  });

  it('写操作仅 API-Key → 401（JWT 强制）', async () => {
    const res = await request(makeApp(prisma)).post('/api/v1/email-templates').set('x-bambook-api-key', validApiKey).send({ type: 'quote', name: 'n', subject: 's', body: 'b' });
    expect(res.status).toBe(401);
  });

  it('GET / 列表过滤已删除与 inactive', async () => {
    const app = makeApp(prisma);
    await request(app).post('/api/v1/email-templates').set(auth()).send({ type: 'quote', name: 'A', subject: 's', body: 'b' });
    await request(app).post('/api/v1/email-templates').set(auth()).send({ type: 'greeting', name: 'B', subject: 's', body: 'b' });
    const list = await request(app).get('/api/v1/email-templates').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const byType = await request(app).get('/api/v1/email-templates?type=quote').set(auth());
    expect(byType.body.total).toBe(1);
    expect(byType.body.items[0].name).toBe('A');
  });

  it('PATCH /:id 改文本时重解析变量；DELETE 软删后列表不可见', async () => {
    const app = makeApp(prisma);
    const created = await request(app).post('/api/v1/email-templates').set(auth()).send({ type: 'quote', name: 'A', subject: 's {{a}}', body: 'b' });
    const id = created.body.item.id;
    const patched = await request(app).patch(`/api/v1/email-templates/${id}`).set(auth()).send({ body: 'new {{customerName}} body' });
    expect(patched.status).toBe(200);
    expect(patched.body.item.variables).toEqual(['a', 'customerName']);
    const del = await request(app).delete(`/api/v1/email-templates/${id}`).set(auth());
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/v1/email-templates').set(auth());
    expect(list.body.total).toBe(0);
  });

  it('POST /seed 幂等：首次全量创建，二次全部跳过', async () => {
    const app = makeApp(prisma);
    const first = await request(app).post('/api/v1/email-templates/seed').set(auth()).send({});
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(STANDARD_EMAIL_TEMPLATES.length);
    expect(first.body.skipped).toBe(0);
    const second = await request(app).post('/api/v1/email-templates/seed').set(auth()).send({});
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toBe(STANDARD_EMAIL_TEMPLATES.length);
  });
});

describe('F5 · GET /api/v1/email/intents 意图聚合', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma.email._rows = [
      { id: 'EML__A', uid: 11, mailbox: 'INBOX', deletedAt: null, labels: ['inquiry'], relationId: 'REL_1', orderId: null, aiExtractedJson: { intent: 'inquiry', customerSignal: 'positive', summary: '询价 3 款' } },
      { id: 'EML__B', uid: 12, mailbox: 'INBOX', deletedAt: null, labels: [], relationId: null, orderId: null, aiExtractedJson: { intent: 'complaint' } },
      // C8 合约演进：已同步但未抽取的邮件也出现（intent=null），携带 DB id/labels/链接供前端操作
      { id: 'EML__C', uid: 13, mailbox: 'INBOX', deletedAt: null, labels: [], relationId: null, orderId: null, aiExtractedJson: null },
      { id: 'EML__D', uid: 14, mailbox: 'Sent Messages', deletedAt: null, labels: [], relationId: null, orderId: null, aiExtractedJson: { intent: 'order' } }, // 不同 mailbox 不匹配
    ];
  });

  it('按 mailbox+uids 返回已同步覆盖层：已抽取带意图，未抽取 intent=null', async () => {
    const res = await request(makeApp(prisma)).get('/api/v1/email/intents?mailbox=INBOX&uids=11,12,13,14').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    const byUid = Object.fromEntries(res.body.items.map((i: any) => [i.uid, i]));
    expect(byUid[11].intent).toBe('inquiry');
    expect(byUid[11].customerSignal).toBe('positive');
    expect(byUid[11].id).toBe('EML__A');
    expect(byUid[11].labels).toEqual(['inquiry']);
    expect(byUid[11].relationId).toBe('REL_1');
    expect(byUid[12].intent).toBe('complaint');
    expect(byUid[13].intent).toBeNull();
    expect(byUid[13].id).toBe('EML__C');
    expect(byUid[14]).toBeUndefined();
  });

  it('缺 mailbox/uids → 400；空 uids → 空列表', async () => {
    const bad = await request(makeApp(prisma)).get('/api/v1/email/intents?mailbox=INBOX').set(auth());
    expect(bad.status).toBe(400);
    const empty = await request(makeApp(prisma)).get('/api/v1/email/intents?mailbox=INBOX&uids=abc').set(auth());
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);
  });

  it('/intents 不被 /:id 通配遮蔽', async () => {
    const res = await request(makeApp(prisma)).get('/api/v1/email/intents?mailbox=INBOX&uids=11').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('安全修复 · DB 读端点 emails:read 门（GET / 列表 / /intents / /:id 详情）', () => {
  // 此前三端点只挂 moduleAuthGuard（登录即可读），QC/无 scope 角色可 API 直读全部业务邮件；
  // 修复后与附件下载同口径：未持 emails:read 的身份一律 403。
  it('viewer（无 emails:read）→ 三端点 403 INSUFFICIENT_SCOPE', async () => {
    const prisma = makeMockPrisma();
    prisma.email.findFirst = vi.fn().mockResolvedValue(null); // GET /:id 兜底（viewer 在数据层之前已被拒）
    const app = makeApp(prisma);
    const viewer = { Cookie: `bambook_token=${viewerToken}` };

    const list = await request(app).get('/api/v1/email').set(viewer);
    expect(list.status).toBe(403);
    expect(list.body.message).toContain('INSUFFICIENT_SCOPE');

    const intents = await request(app).get('/api/v1/email/intents?mailbox=INBOX&uids=11').set(viewer);
    expect(intents.status).toBe(403);

    const detail = await request(app).get('/api/v1/email/EML__A').set(viewer);
    expect(detail.status).toBe(403);
    // 未触达数据层（门在前）
    expect(prisma.email.findFirst).not.toHaveBeenCalled();
  });

  it('owner（emails:read 全通）→ 列表 200 / intents 200 / 详情非 403（404=记录不存在）', async () => {
    const prisma = makeMockPrisma();
    prisma.email.findFirst = vi.fn().mockResolvedValue(null);
    prisma.email.count = vi.fn().mockResolvedValue(0); // GET / 列表计数
    const app = makeApp(prisma);

    const list = await request(app).get('/api/v1/email').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);

    const intents = await request(app).get('/api/v1/email/intents?mailbox=INBOX&uids=11').set(auth());
    expect(intents.status).toBe(200);

    const detail = await request(app).get('/api/v1/email/EML__A').set(auth());
    expect(detail.status).toBe(404); // 门已过（非 403），mock 无此记录
    expect(prisma.email.findFirst).toHaveBeenCalled();
  });
});
