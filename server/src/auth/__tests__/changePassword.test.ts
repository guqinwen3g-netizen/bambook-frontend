import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, expect, it } from 'vitest';
import { createAuthRouter } from '../route';
import { createAuthService } from '../service';

const auth = createAuthService();
let user: any; let updates: any[];
function app() {
  const prisma = { userAccount: {
    findUnique: async ({ where }: any) => (where.id === user.id ? structuredClone(user) : null),
    update: async ({ where, data }: any) => { if (where.id !== user.id) throw new Error('unexpected user'); updates.push(structuredClone(data)); Object.assign(user, data); return structuredClone(user); },
  }, auditLog: { create: async ({ data }: any) => data } };
  const a = express(); a.use(cookieParser()); a.use(express.json());
  a.use('/auth', createAuthRouter({ prisma: prisma as any, loginRateLimit: false, requireEmailVerification: false }));
  return a;
}
const token = () => auth.signToken({ userId: user.id, displayName: 'U', roles: ['viewer'], roleIds: [], permissions: [], departmentIds: [] } as any);
beforeEach(async () => { user = { id: 'u1', status: 'active', passwordHash: await auth.hashPassword('Temp-pass-1'), metadata: { forceChangePassword: true, passwordResetAt: '2026-10-15T00:00:00Z', note: 'keep' } }; updates = []; });

it('本人改密后清除管理员重置留下的 forceChangePassword，其余 metadata 保留', async () => {
  const res = await request(app()).post('/auth/change-password').set('Authorization', `Bearer ${token()}`).send({ currentPassword: 'Temp-pass-1', newPassword: 'New-pass-22' });
  expect(res.status).toBe(200);
  expect(updates).toHaveLength(1);
  expect(updates[0].metadata).toMatchObject({ forceChangePassword: false, passwordResetAt: '2026-10-15T00:00:00Z', note: 'keep' });
  expect(await auth.verifyPassword('New-pass-22', user.passwordHash)).toBe(true);
});
it('当前密码错误时不改任何字段；无重置标记时只更新密码', async () => {
  const wrong = await request(app()).post('/auth/change-password').set('Authorization', `Bearer ${token()}`).send({ currentPassword: 'nope', newPassword: 'New-pass-22' });
  expect(wrong.status).toBe(401); expect(updates).toEqual([]);
  user.metadata = null;
  const ok = await request(app()).post('/auth/change-password').set('Authorization', `Bearer ${token()}`).send({ currentPassword: 'Temp-pass-1', newPassword: 'New-pass-22' });
  expect(ok.status).toBe(200); expect(Object.keys(updates[0])).toEqual(['passwordHash']);
});
it('退出所有设备：写入 sessionsRevokedAt、保留其余 metadata 并清除 cookie', async () => {
  const res = await request(app()).post('/auth/logout-all').set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(200);
  expect(updates).toHaveLength(1);
  expect(updates[0].metadata).toMatchObject({ forceChangePassword: true, note: 'keep' });
  expect(Date.parse(updates[0].metadata.sessionsRevokedAt)).toBeGreaterThan(0);
  expect(String(res.headers['set-cookie'] ?? '')).toContain('Expires=Thu, 01 Jan 1970');
  expect((await request(app()).post('/auth/logout-all')).status).toBe(401);
});
