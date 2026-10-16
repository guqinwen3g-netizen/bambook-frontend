import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../auth/service';
import { createAdminRouter } from './route';

const token = (userId: string, roles: string[]) => createAuthService().signToken({ userId, displayName: userId, roles, permissions: ['users:read', 'users:write'], departmentIds: [] } as any);
function makeApp(targetRoles: Array<{ id: string; name: string }>) {
  const prisma: any = {
    userRole: { findMany: vi.fn(async () => targetRoles.map(role => ({ role }))) },
    userAccount: { findUnique: vi.fn(async () => ({ id: 'boss', metadata: { note: 'keep' } })), update: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const app = express(); app.use(express.json()); app.use('/admin', createAdminRouter({ prisma }));
  return { app, prisma };
}

describe('老板账号防线：管理员不得接管老板账号', () => {
  it.each(['reset-password', 'reset-mfa', 'disable-account'])('admin 对老板账号 %s → 403，且不写库', async (action) => {
    const { app, prisma } = makeApp([{ id: 'role-super-admin', name: '老板' }]);
    const res = await request(app).post(`/admin/users/boss/${action}`).set('Authorization', `Bearer ${token('admin-1', ['admin'])}`).send({});
    expect(res.status).toBe(403);
    expect(prisma.userAccount.update).not.toHaveBeenCalled();
  });
  it('admin 不得修改老板账号的邮箱或状态', async () => {
    const { app, prisma } = makeApp([{ id: 'role-x', name: '老板' }]);
    const res = await request(app).patch('/admin/users/boss').set('Authorization', `Bearer ${token('admin-1', ['admin'])}`).send({ email: 'evil@x.test' });
    expect(res.status).toBe(403); expect(prisma.userAccount.update).not.toHaveBeenCalled();
  });
  it('老板本人可重置两步验证并记审计；admin 可重置普通账号的两步验证', async () => {
    const boss = makeApp([{ id: 'role-super-admin', name: '老板' }]);
    expect((await request(boss.app).post('/admin/users/boss/reset-mfa').set('Authorization', `Bearer ${token('owner-1', ['owner'])}`).send({})).status).toBe(200);
    expect(boss.prisma.userAccount.update.mock.calls[0][0].data.metadata).toMatchObject({ note: 'keep', mfa: { enabled: false } });
    expect(boss.prisma.auditLog.create.mock.calls[0][0].data.action).toBe('reset_mfa');
    const staff = makeApp([{ id: 'role-sales', name: '业务员' }]);
    expect((await request(staff.app).post('/admin/users/u2/reset-mfa').set('Authorization', `Bearer ${token('admin-1', ['admin'])}`).send({})).status).toBe(200);
  });
});
