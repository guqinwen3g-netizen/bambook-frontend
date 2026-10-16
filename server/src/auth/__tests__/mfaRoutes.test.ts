import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../tokenHelpers', async (orig) => ({
  ...(await orig<typeof import('../tokenHelpers')>()),
  buildLoadedAuthTokenPayload: async (_p: unknown, user: any) => ({ userId: user.id, displayName: 'U', roles: ['viewer'], roleIds: [], permissions: [], departmentIds: [], authorizationLoaded: true }),
}));

import { createAuthRouter } from '../route';
import { createAuthService } from '../service';
import { totpAt } from '../totp';

const auth = createAuthService();
let user: any; let audits: any[];
function app() {
  const find = async ({ where }: any) => (where.id === user.id || where.OR ? structuredClone(user) : null);
  const prisma = {
    userAccount: {
      findUnique: find, findFirst: find,
      update: async ({ where, data }: any) => { if (where.id !== user.id) throw new Error('unexpected'); Object.assign(user, structuredClone(data)); return structuredClone(user); },
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
  };
  const a = express(); a.use(cookieParser()); a.use(express.json());
  a.use('/auth', createAuthRouter({ prisma: prisma as any, loginRateLimit: false, requireEmailVerification: false }));
  return a;
}
const bearer = () => `Bearer ${auth.signToken({ userId: user.id, displayName: 'U', roles: ['viewer'], roleIds: [], permissions: [], departmentIds: [] } as any)}`;
const codeNow = (secret: string) => totpAt(secret, Math.floor(Date.now() / 30000));
beforeEach(async () => { user = { id: 'u1', email: 'u1@x.cn', displayName: 'U', status: 'active', passwordHash: await auth.hashPassword('Pass-word-1'), metadata: { note: 'keep' }, roles: [] }; audits = []; });

async function enable(a = app()) {
  const setup = await request(a).post('/auth/mfa/setup').set('Authorization', bearer()).send({ password: 'Pass-word-1' });
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUri).toContain('otpauth://totp/');
  const en = await request(a).post('/auth/mfa/enable').set('Authorization', bearer()).send({ code: codeNow(setup.body.secret) });
  expect(en.status).toBe(200);
  return { secret: setup.body.secret as string, recoveryCodes: en.body.recoveryCodes as string[] };
}

it('开启：须验证密码；确认动态码后生效，返回 10 个恢复码，密钥不明文落库', async () => {
  const a = app();
  expect((await request(a).post('/auth/mfa/setup').set('Authorization', bearer()).send({ password: 'wrong' })).status).toBe(401);
  const { secret, recoveryCodes } = await enable(a);
  expect(recoveryCodes).toHaveLength(10);
  expect(JSON.stringify(user.metadata)).not.toContain(secret);
  expect(user.metadata.note).toBe('keep');
  const view = await request(a).get('/auth/mfa').set('Authorization', bearer());
  expect(view.body.mfa).toMatchObject({ enabled: true, recoveryRemaining: 10 });
});

it('开启后登录：密码正确只返回第二步凭据，不发会话；凭据不能当会话令牌', async () => {
  const a = app(); const { secret } = await enable(a);
  user.metadata.mfa.lastCounter = -1; // 开启时已消耗本时间窗动态码；模拟下一时间窗
  const res = await request(a).post('/auth/login').send({ identifier: 'u1@x.cn', password: 'Pass-word-1' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ mfaRequired: true });
  expect(res.body.token).toBeUndefined();
  expect(res.headers['set-cookie']).toBeUndefined();
  expect((await request(a).get('/auth/mfa').set('Authorization', `Bearer ${res.body.mfaToken}`)).status).toBe(401);
  const bad = await request(a).post('/auth/login/mfa').send({ mfaToken: res.body.mfaToken, code: '000000' === codeNow(secret) ? '111111' : '000000' });
  expect(bad.status).toBe(401);
  const ok = await request(a).post('/auth/login/mfa').send({ mfaToken: res.body.mfaToken, code: codeNow(secret) });
  expect(ok.status).toBe(200); expect(ok.body.token).toBeTruthy();
  // 同一动态码不可重放
  expect((await request(a).post('/auth/login/mfa').send({ mfaToken: res.body.mfaToken, code: codeNow(secret) })).status).toBe(401);
  expect((await request(a).post('/auth/login/mfa').send({ mfaToken: 'garbage', code: codeNow(secret) })).body.error).toBe('MFA_EXPIRED');
});

it('恢复码只能用一次，并留审计', async () => {
  const a = app(); const { recoveryCodes } = await enable(a);
  const step = (await request(a).post('/auth/login').send({ identifier: 'u1@x.cn', password: 'Pass-word-1' })).body.mfaToken;
  const first = await request(a).post('/auth/login/mfa').send({ mfaToken: step, code: recoveryCodes[0].toUpperCase() });
  expect(first.status).toBe(200); expect(first.body.recoveryRemaining).toBe(9);
  expect(audits.some(x => x.action === 'login_mfa_recovery')).toBe(true);
  expect((await request(a).post('/auth/login/mfa').send({ mfaToken: step, code: recoveryCodes[0] })).status).toBe(401);
});

it('关闭：须同时验证密码和动态码', async () => {
  const a = app(); const { secret } = await enable(a);
  user.metadata.mfa.lastCounter = -1;
  expect((await request(a).post('/auth/mfa/disable').set('Authorization', bearer()).send({ password: 'wrong', code: codeNow(secret) })).status).toBe(401);
  expect((await request(a).post('/auth/mfa/disable').set('Authorization', bearer()).send({ password: 'Pass-word-1', code: '12' })).status).toBe(400);
  const ok = await request(a).post('/auth/mfa/disable').set('Authorization', bearer()).send({ password: 'Pass-word-1', code: codeNow(secret) });
  expect(ok.status).toBe(200);
  expect(user.metadata.mfa?.enabled ?? false).toBe(false);
  const login = await request(a).post('/auth/login').send({ identifier: 'u1@x.cn', password: 'Pass-word-1' });
  expect(login.body.token).toBeTruthy();
});
