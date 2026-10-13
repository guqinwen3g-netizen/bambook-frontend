import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from './service';
import { createAuthRouter } from './route';

function authToken() {
  return createAuthService().signToken({
    userId: 'u1',
    displayName: 'User One',
    roles: ['viewer'],
    permissions: ['orders:read'],
    departmentIds: ['company'],
  });
}

function makeApp(prisma: any) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use('/auth', createAuthRouter({ prisma, requireEmailVerification: false }));
  return app;
}

describe('auth profile avatar', () => {
  it('updates and returns the current user circular avatar data url', async () => {
    const prisma = {
      userAccount: {
        update: vi.fn().mockResolvedValue({
          id: 'u1',
          displayName: 'User One',
          status: 'active',
          email: 'user@example.com',
          avatarUrl: 'data:image/webp;base64,next',
          primaryDeptId: null,
          primaryDepartment: { name: 'Company' },
          roles: [{
            roleId: 'viewer', // Genuine historical role identity; Role.name alone grants no authority.
            departmentId: 'company',
            role: {
              name: 'viewer',
              isSystem: false,
              permissions: [{ permission: { scope: 'orders:read' } }],
            },
          }],
        }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
      userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const res = await request(makeApp(prisma))
      .patch('/auth/me')
      .set('Authorization', `Bearer ${authToken()}`)
      .send({ avatarUrl: 'data:image/webp;base64,next' });

    expect(res.status).toBe(200);
    expect(prisma.userAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u1' },
      data: { avatarUrl: 'data:image/webp;base64,next' },
    }));
    expect(res.body.user).toMatchObject({
      id: 'u1',
      avatarUrl: 'data:image/webp;base64,next',
      department: 'Company',
      roles: ['viewer'],
      permissions: ['orders:read'],
    });
  });

  it('rejects oversized or non-image avatar payloads', async () => {
    const prisma = {
      userAccount: { update: vi.fn() },
      auditLog: { create: vi.fn() },
    };

    const res = await request(makeApp(prisma))
      .patch('/auth/me')
      .set('Authorization', `Bearer ${authToken()}`)
      .send({ avatarUrl: 'data:text/plain;base64,nope' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_AVATAR');
    expect(prisma.userAccount.update).not.toHaveBeenCalled();
  });
});
