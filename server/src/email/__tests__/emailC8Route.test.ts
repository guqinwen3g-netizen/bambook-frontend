import express from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const salesToken = jwt.sign({ userId: 'u2', roles: ['sales'] }, SECRET);
const validApiKey = 'test-key';
const apiKeys = new Set([validApiKey]);

import { createEmailRouter } from '../route';
import { createEmailTemplateRouter } from '../templateRoute';

function makeMockPrisma() {
  const emails: any[] = [];
  const followUps: any[] = [];
  const templates: any[] = [];
  const auditLogs: any[] = [];
  let fuSeq = 0;
  const prisma: any = {
    email: {
      findUnique: async ({ where }: any) => emails.find(r => r.id === where.id) || null,
      findMany: async ({ where, take }: any = {}) => {
        let out = emails.filter(r => r.deletedAt === null);
        if (where?.labels?.isEmpty) out = out.filter(r => !r.labels || r.labels.length === 0);
        if (where?.mailbox) out = out.filter(r => r.mailbox === where.mailbox);
        return out.slice(0, take ?? 50);
      },
      update: async ({ where, data }: any) => {
        const row = emails.find(r => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    followUpRecord: {
      findFirst: async ({ where }: any) =>
        followUps.find(r => r.deletedAt === null && (!where?.notes?.contains || String(r.notes || '').includes(where.notes.contains))) || null,
      create: async ({ data }: any) => {
        const row = { deletedAt: null, ...data, id: data.id || `FU_T${++fuSeq}` };
        followUps.push(row);
        return row;
      },
    },
    emailTemplate: {
      findFirst: async ({ where }: any) =>
        templates.find(r =>
          (where.id === undefined || r.id === where.id) &&
          (where.deletedAt === null ? r.deletedAt === null : true),
        ) || null,
      update: async ({ where, data }: any) => {
        const row = templates.find(r => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: any) => { auditLogs.push(data); return { id: data.id }; },
    },
    _emails: emails,
    _followUps: followUps,
    _templates: templates,
    _auditLogs: auditLogs,
  };
  return prisma;
}

function makeApp(prisma: any, llm?: any) {
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
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys }));
  app.use('/api/v1/email-templates', createEmailTemplateRouter({ prisma, requireAuth: true, apiKeys, llm }));
  return app;
}

const auth = () => ({ Cookie: `bambook_token=${ownerToken}` });

describe('C8 · POST /api/v1/email/:id/classify 智能分类', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._emails.push(
      { id: 'EML__C', uid: 1, mailbox: 'INBOX', direction: 'inbound', fromAddress: 'buyer@acme.com', subject: 'Complaint: defects', snippet: null, labels: [], relationId: 'REL_1', orderId: null, aiExtractedJson: null, deletedAt: null },
      { id: 'EML__N', uid: 2, mailbox: 'INBOX', direction: 'inbound', fromAddress: 'a@b.com', subject: 'Hello', snippet: null, labels: [], relationId: null, orderId: null, aiExtractedJson: null, deletedAt: null },
    );
  });

  it('投诉邮件 → complaint+urgent+customer 标签，自动建跟进；二次调用跟进幂等', async () => {
    const app = makeApp(prisma);
    const r1 = await request(app).post('/api/v1/email/EML__C/classify').set(auth()).send({ withAi: false });
    expect(r1.status).toBe(200);
    expect(r1.body.labels).toEqual(expect.arrayContaining(['complaint', 'urgent', 'customer']));
    expect(r1.body.followUp.created).toBe(true);
    expect(prisma._followUps).toHaveLength(1);

    const r2 = await request(app).post('/api/v1/email/EML__C/classify').set(auth()).send({ withAi: false });
    expect(r2.status).toBe(200);
    expect(r2.body.changed).toBe(false);
    expect(r2.body.followUp.created).toBe(false);
    expect(prisma._followUps).toHaveLength(1);
  });

  it('autoFollowUp=false → 不打跟进；无投诉标签 → 不建跟进', async () => {
    const app = makeApp(prisma);
    const r = await request(app).post('/api/v1/email/EML__C/classify').set(auth()).send({ withAi: false, autoFollowUp: false });
    expect(r.status).toBe(200);
    expect(r.body.followUp.created).toBe(false);
    expect(prisma._followUps).toHaveLength(0);

    const r2 = await request(app).post('/api/v1/email/EML__N/classify').set(auth()).send({ withAi: false });
    expect(r2.body.followUp.created).toBe(false);
  });

  it('邮件不存在 → 404；API-Key 无 JWT → 401', async () => {
    const app = makeApp(prisma);
    const nf = await request(app).post('/api/v1/email/EML__X/classify').set(auth()).send({ withAi: false });
    expect(nf.status).toBe(404);
    const noJwt = await request(app).post('/api/v1/email/EML__C/classify').set('x-bambook-api-key', validApiKey).send({});
    expect(noJwt.status).toBe(401);
  });
});

describe('C8 · POST /api/v1/email/classify-backfill 批量分类', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._emails.push(
      { id: 'EML__A', mailbox: 'INBOX', direction: 'inbound', fromAddress: 'x@y.com', subject: 'Complaint!', snippet: null, labels: [], relationId: 'REL_1', aiExtractedJson: null, deletedAt: null },
      { id: 'EML__B', mailbox: 'INBOX', direction: 'inbound', fromAddress: 'x@y.com', subject: 'Invoice 09', snippet: null, labels: [], relationId: null, aiExtractedJson: null, deletedAt: null },
    );
  });

  it('owner 批量分类 + 自动跟进计数；sales 角色 → 403', async () => {
    const app = makeApp(prisma);
    const r = await request(app).post('/api/v1/email/classify-backfill').set(auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.scanned).toBe(2);
    expect(r.body.classified).toBe(2);
    expect(r.body.followUpsCreated).toBe(1);

    const forbidden = await request(app).post('/api/v1/email/classify-backfill').set({ Cookie: `bambook_token=${salesToken}` }).send({});
    expect(forbidden.status).toBe(403);
  });
});

describe('C8 · POST /api/v1/email/:id/create-followup 一键跟进', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._emails.push(
      { id: 'EML__F', subject: 'Re: order 4582', relationId: 'REL_1', orderId: 'ORD_1', aiExtractedJson: { summary: '确认交期', deadlines: [{ purpose: '交期', date: '2026-08-30' }], actionItems: ['回复交期'] }, deletedAt: null },
      { id: 'EML__G', subject: 'stranger', relationId: null, orderId: null, aiExtractedJson: null, deletedAt: null },
    );
  });

  it('已关联客户 → 201 创建；重复调用 → 200 复用；未关联 → 409', async () => {
    const app = makeApp(prisma);
    const created = await request(app).post('/api/v1/email/EML__F/create-followup').set(auth()).send({});
    expect(created.status).toBe(201);
    expect(created.body.followUpId).toBeTruthy();
    expect(created.body.nextFollowUpAt).toBe('2026-08-30');

    const reused = await request(app).post('/api/v1/email/EML__F/create-followup').set(auth()).send({});
    expect(reused.status).toBe(200);
    expect(reused.body.reused).toBe(true);
    expect(prisma._followUps).toHaveLength(1);

    const noRel = await request(app).post('/api/v1/email/EML__G/create-followup').set(auth()).send({});
    expect(noRel.status).toBe(409);
    expect(noRel.body.error.code).toBe('NO_RELATION');
  });
});

describe('C8 · 模板智能化：/use 使用统计 + /ai-generate AI 生成', () => {
  let prisma: any;
  beforeEach(() => {
    prisma = makeMockPrisma();
    prisma._templates.push({ id: 'EMTPL__1', type: 'quote', name: '标准报价函', subject: 's', body: 'b', usageCount: 0, lastUsedAt: null, deletedAt: null, isActive: true });
  });

  it('/use 累计计数 + lastUsedAt；不存在 → 404；API-Key 可用（低风险计数）', async () => {
    const app = makeApp(prisma);
    const r1 = await request(app).post('/api/v1/email-templates/EMTPL__1/use').set('x-bambook-api-key', validApiKey).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.usageCount).toBe(1);
    expect(r1.body.lastUsedAt).toBeTypeOf('number');
    const r2 = await request(app).post('/api/v1/email-templates/EMTPL__1/use').set(auth()).send({});
    expect(r2.body.usageCount).toBe(2);
    const nf = await request(app).post('/api/v1/email-templates/EMTPL__X/use').set(auth()).send({});
    expect(nf.status).toBe(404);
  });

  it('/ai-generate 返回草稿（含解析变量），不落库', async () => {
    const llm = async () => JSON.stringify({
      name: '大货延期致歉函',
      subject: 'Delay Notice — Order {{orderNo}}',
      body: 'Dear {{customerName}},\n\nWe regret to inform you that order {{orderNo}} will be delayed to {{newDeliveryDate}}.\n\nBest regards,\n{{senderName}}',
    });
    const app = makeApp(prisma, llm);
    const r = await request(app).post('/api/v1/email-templates/ai-generate').set(auth()).send({ scenario: '大货延期通知客户', type: 'delivery_notice' });
    expect(r.status).toBe(200);
    expect(r.body.draft.name).toBe('大货延期致歉函');
    expect(r.body.draft.variables).toEqual(expect.arrayContaining(['orderNo', 'customerName', 'newDeliveryDate', 'senderName']));
    expect(prisma._templates).toHaveLength(1); // 未落库
  });

  it('/ai-generate 参数校验：缺 scenario → 400；非法 type → 400；AI 返回非 JSON → 502；无 JWT → 401', async () => {
    const okLlm = async () => '{}';
    const app = makeApp(prisma, okLlm);
    const noScenario = await request(app).post('/api/v1/email-templates/ai-generate').set(auth()).send({});
    expect(noScenario.status).toBe(400);
    const badType = await request(app).post('/api/v1/email-templates/ai-generate').set(auth()).send({ scenario: 'x', type: 'nope' });
    expect(badType.status).toBe(400);
    const invalid = await request(app).post('/api/v1/email-templates/ai-generate').set(auth()).send({ scenario: 'x' });
    expect(invalid.status).toBe(502);

    const badLlmApp = makeApp(prisma, async () => 'not json at all');
    const badJson = await request(badLlmApp).post('/api/v1/email-templates/ai-generate').set(auth()).send({ scenario: 'x' });
    expect(badJson.status).toBe(502);

    const noJwt = await request(app).post('/api/v1/email-templates/ai-generate').set('x-bambook-api-key', validApiKey).send({ scenario: 'x' });
    expect(noJwt.status).toBe(401);
  });
});
