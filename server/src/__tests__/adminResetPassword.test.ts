/**
 * 管理员重置密码回归套件（运维冲刺 · 弱口令治理）
 *
 * 覆盖：
 *   1. 未提供 newPassword → 服务端生成随机一次性密码（≠ bambook2026），仅响应中返回一次，
 *      且 metadata 标记 forceChangePassword
 *   2. 显式提供 newPassword → 沿用旧行为（不返回明文）
 *   3. 显式提供弱密码（<6 位）→ 400 WEAK_PASSWORD
 *   4. 目标用户不存在 → 404 NOT_FOUND
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/route';

function buildPrismaMock(target: { metadata: any } | null) {
  return {
    userAccount: {
      findUnique: vi.fn(async () => target),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any;
}

function buildApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter({ prisma, requireAuth: false }));
  return app;
}

describe('POST /admin/users/:id/reset-password', () => {
  it('未提供 newPassword：生成随机一次性密码并标记 forceChangePassword', async () => {
    const prisma = buildPrismaMock({ metadata: { existingFlag: true } });
    const app = buildApp(prisma);
    const res = await request(app).post('/admin/users/usr_1/reset-password').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.forceChangePassword).toBe(true);
    expect(typeof res.body.temporaryPassword).toBe('string');
    expect(res.body.temporaryPassword).toHaveLength(16);
    expect(res.body.temporaryPassword).not.toBe('bambook2026');

    // 落库：passwordHash 已更新，metadata 合并保留原字段并加 forceChangePassword
    expect(prisma.userAccount.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.userAccount.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'usr_1' });
    expect(typeof updateArgs.data.passwordHash).toBe('string');
    expect(updateArgs.data.metadata.existingFlag).toBe(true);
    expect(updateArgs.data.metadata.forceChangePassword).toBe(true);
    expect(typeof updateArgs.data.metadata.passwordResetAt).toBe('string');

    // 两次调用生成不同随机密码
    const res2 = await request(app).post('/admin/users/usr_1/reset-password').send({});
    expect(res2.body.temporaryPassword).not.toBe(res.body.temporaryPassword);
  });

  it('显式提供 newPassword：沿用旧行为，响应不含明文密码', async () => {
    const prisma = buildPrismaMock({ metadata: null });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/admin/users/usr_1/reset-password')
      .send({ newPassword: 'AdminChosen#2026' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.temporaryPassword).toBeUndefined();
  });

  it('显式提供弱密码（<6 位）：400 WEAK_PASSWORD', async () => {
    const prisma = buildPrismaMock({ metadata: null });
    const app = buildApp(prisma);
    const res = await request(app).post('/admin/users/usr_1/reset-password').send({ newPassword: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('WEAK_PASSWORD');
    expect(prisma.userAccount.update).not.toHaveBeenCalled();
  });

  it('目标用户不存在：404 NOT_FOUND', async () => {
    const prisma = buildPrismaMock(null);
    const app = buildApp(prisma);
    const res = await request(app).post('/admin/users/usr_ghost/reset-password').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(prisma.userAccount.update).not.toHaveBeenCalled();
  });
});
