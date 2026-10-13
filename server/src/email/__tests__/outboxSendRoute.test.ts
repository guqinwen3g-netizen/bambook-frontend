import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEmailRouter } from '../route';
import jwt from 'jsonwebtoken';
import { durableFixture } from './outboxDurableFixture';
import nodemailer from 'nodemailer';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, SECRET);
const apiKeys = new Set(['test-key']);

// mock nodemailer（route 真实调用 SMTP，测试需拦截）
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: '<route-test-msg@bambook.local>', accepted: ['c@d.com'], rejected: [], pending: [] }),
    })),
  },
}));

function makeApp(opts: {
  emailRow?: any;
  updateFail?: boolean;
  auditFail?: boolean;
  readFail?: boolean;
} = {}) {
  const emailRow = opts.emailRow === undefined ? {
    id: 'EML__1', direction: 'outbound', mailbox: 'Outbox',
    fromAddress: 'a@bambook.local', fromName: 'Bambook',
    toAddresses: JSON.stringify(['c@d.com']), ccAddresses: null,
    subject: 'Test', bodyText: 'Body', bodyHtml: null, messageId: null, sentAt: null,
  } : opts.emailRow;

  const prisma = durableFixture(emailRow, {actorId:'u1',updateFail:opts.updateFail,auditFail:opts.auditFail,readFail:opts.readFail?'POOL_TERMINATED_read':undefined}).prisma;

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (req.headers.cookie) {
      const cookies: Record<string,string> = {};
      req.headers.cookie.split(';').forEach((c: string) => {
        const [k, v] = c.trim().split('=');
        cookies[k] = v;
      });
      req.cookies = cookies;
    }
    next();
  });
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys }));
  return { app, prisma };
}

const VALID_BODY = { email: 'test@bambook.com', password: 'pass123' };

describe('task ERP-P1 outbox-send route: POST /api/v1/email/outbox/:id/send', () => {
  it('closes the legacy independent SMTP bypass without touching transport or native data', async () => {
    const { app, prisma } = makeApp(); const before = vi.mocked(nodemailer.createTransport).mock.calls.length;
    const res = await request(app).post('/api/v1/email/send').set('Cookie', `bambook_token=${ownerToken}`)
      .send({ email: 'synthetic@bambook.local', password: 'synthetic-only', to: 'c@d.com', subject: 'Synthetic', body: 'Synthetic' });
    expect(res.status).toBe(410); expect(res.body).toMatchObject({ok:false,error:{code:'NATIVE_OUTBOX_REQUIRED'}});
    expect(vi.mocked(nodemailer.createTransport).mock.calls.length).toBe(before);
    expect(prisma.$transaction).not.toHaveBeenCalled(); expect(prisma.email.update).not.toHaveBeenCalled();
  });
  it('成功 → 200 + ok:true + messageId', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/email/outbox/EML__1/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.messageId).toBeTruthy();
  });

  it('EMAIL_NOT_FOUND → 404', async () => {
    const { app } = makeApp({ emailRow: null });
    const res = await request(app).post('/api/v1/email/outbox/NOPE/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EMAIL_NOT_FOUND');
  });

  it('★ B67：读这封邮件失败 → 500 EMAIL_READ_FAILED（不再谎报「邮件不存在」），且不带原文', async () => {
    const { app } = makeApp({ readFail: true });
    const res = await request(app).post('/api/v1/email/outbox/EML__1/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status, '仍是 404 = 数据层故障又被说成「这封邮件不存在」').toBe(500);
    expect(res.body.error.code).toBe('EMAIL_READ_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('POOL_TERMINATED_read');
    expect(res.body.error.message).toContain('没有发送');   // fail closed 这件事要说清
  });

  it('EMAIL_NOT_OUTBOUND（inbound）→ 400', async () => {
    const { app } = makeApp({ emailRow: { id: 'E1', direction: 'inbound', mailbox: 'Outbox', toAddresses: '[]', messageId: null, sentAt: null } });
    const res = await request(app).post('/api/v1/email/outbox/E1/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_NOT_OUTBOUND');
  });

  it('EMAIL_NOT_OUTBOX（mailbox=Sent）→ 400', async () => {
    const { app } = makeApp({ emailRow: { id: 'E1', direction: 'outbound', mailbox: 'Sent', toAddresses: '[]', messageId: null, sentAt: null } });
    const res = await request(app).post('/api/v1/email/outbox/E1/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_NOT_OUTBOX');
  });

  it('MISSING_CREDENTIALS（无 password）→ 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/email/outbox/EML__1/send').set('Cookie', `bambook_token=${ownerToken}`).send({ email: 'test@bambook.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_CREDENTIALS');
  });

  it('DB_UPDATE_FAILED（SMTP 成功但 DB update 失败）→ 500 不静默成功', async () => {
    const { app } = makeApp({ updateFail: true });
    const res = await request(app).post('/api/v1/email/outbox/EML__1/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_UPDATE_FAILED');
    // ★ B42 A1 复核处置：本端点走的是 service 早退分支（sendOutboxEmail 从不抛错）
    //   ⇒ 路由的 catch 在这条路径上是死代码，外发文案由 service 决定。原文（DB_LOCK）只能进日志。
    expect(res.body.error.message).toContain('回执已保留');            // 提示已发但 DB 没记录
    expect(res.body.error.message).toContain('<route-test-msg@bambook.local>'); // 回执号必须留着对账
    expect(JSON.stringify(res.body)).not.toContain('DB_LOCK');
  });

  it('audit reject → DB_UPDATE_FAILED（audit 失败也不静默成功，且不带审计原文）', async () => {
    const { app } = makeApp({ auditFail: true });
    const res = await request(app).post('/api/v1/email/outbox/EML__1/send').set('Cookie', `bambook_token=${ownerToken}`).send(VALID_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_UPDATE_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('AUDIT_REJECT');
  });
});
