import express from 'express';
import request from 'supertest';
import { describe, expect, it, afterEach } from 'vitest';
import { createAuthRouter } from '../route';
import type { EmailService } from '../email';

/**
 * §10.3-10 邮件通道守卫：凭证类邮件（注册验证码 / 重置密码）不得静默降级。
 * 此前 console 通道下错误被吞掉、照样返回 200「已发送」，用户永远收不到码 —— 属静默失败。
 * 现在：无真实通道且未显式开开发降级 → 503 EMAIL_NOT_CONFIGURED。
 */

const prismaStub: any = {
  userAccount: { findFirst: async () => null },
};

function makeEmail(opts: { isReal: boolean; fail?: boolean }): EmailService & { sent: any[] } {
  const sent: any[] = [];
  return {
    isReal: opts.isReal,
    sent,
    describe: () => (opts.isReal ? 'stub-real' : 'stub-console'),
    async send(msg: any) {
      sent.push(msg);
      if (opts.fail) throw new Error('smtp down');
    },
  } as any;
}

function buildApp(email: EmailService) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter({ prisma: prismaStub, email }));
  return app;
}

const ORIG = process.env.AUTH_ALLOW_DEV_EMAIL_FALLBACK;

function setFallback(v: string | undefined) {
  if (v === undefined) delete process.env.AUTH_ALLOW_DEV_EMAIL_FALLBACK;
  else process.env.AUTH_ALLOW_DEV_EMAIL_FALLBACK = v;
}

afterEach(() => setFallback(ORIG));

describe('send-code 邮件通道守卫', () => {
  it('无真实通道且未开降级 → 503，且不返回「已发送」', async () => {
    setFallback(undefined);
    const email = makeEmail({ isReal: false });
    const res = await request(buildApp(email))
      .post('/auth/send-code')
      .send({ email: 'someone@example.com', purpose: 'reset_password' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('EMAIL_NOT_CONFIGURED');
    expect(res.body.ok).toBe(false);
    expect(email.sent).toHaveLength(0);
  });

  it('无真实通道但显式开降级 → 放行并回显 devCode（仅供本地联调）', async () => {
    setFallback('1');
    const email = makeEmail({ isReal: false });
    const res = await request(buildApp(email))
      .post('/auth/send-code')
      .send({ email: 'someone@example.com', purpose: 'reset_password' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.devCode).toBe('string');
    expect(res.body.devCode).toHaveLength(6);
    expect(email.sent).toHaveLength(1);
  });

  it('真实通道发送成功 → 200 且不回显验证码', async () => {
    setFallback(undefined);
    const email = makeEmail({ isReal: true });
    const res = await request(buildApp(email))
      .post('/auth/send-code')
      .send({ email: 'someone@example.com', purpose: 'reset_password' });

    expect(res.status).toBe(200);
    expect(res.body.devCode).toBeUndefined();
    expect(email.sent).toHaveLength(1);
  });

  it('真实通道发送失败 → 502 明确报错', async () => {
    setFallback(undefined);
    const email = makeEmail({ isReal: true, fail: true });
    const res = await request(buildApp(email))
      .post('/auth/send-code')
      .send({ email: 'someone@example.com', purpose: 'reset_password' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('EMAIL_FAILED');
  });

  it('真实通道发送失败 + 已开降级 → 仅告警放行', async () => {
    setFallback('1');
    const email = makeEmail({ isReal: true, fail: true });
    const res = await request(buildApp(email))
      .post('/auth/send-code')
      .send({ email: 'someone@example.com', purpose: 'reset_password' });

    expect(res.status).toBe(200);
  });

  it('邮箱格式非法 → 400（回归）', async () => {
    setFallback('1');
    const email = makeEmail({ isReal: true });
    const res = await request(buildApp(email)).post('/auth/send-code').send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_EMAIL');
  });
});
