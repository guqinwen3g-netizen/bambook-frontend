import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../auth/service';
import { createAdminRouter } from './route';

function adminToken() {
  return createAuthService().signToken({
    userId: 'owner-1',
    displayName: 'Owner',
    roles: ['owner'],
    permissions: ['users:read', 'users:write', 'users:admin', 'users:delete', 'roles:read', 'roles:write'],
    departmentIds: [],
  });
}

/** 非 owner 的 admin 身份（SuperAdmin 防线回归：admin 不得自我提权） */
function plainAdminToken() {
  return createAuthService().signToken({
    userId: 'admin-1',
    displayName: 'Admin',
    roles: ['admin'],
    permissions: ['users:read', 'users:write', 'users:admin', 'roles:read', 'roles:write'],
    departmentIds: [],
  });
}

function makeApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter({ prisma }));
  return app;
}

describe('admin user status management', () => {
  it('keeps disabled users visible in admin user lists', async () => {
    const disabledUser = {
      id: 'user-disabled',
      displayName: 'Disabled User',
      email: 'disabled@example.com',
      status: 'disabled',
      roles: [],
      primaryDeptId: null,
      primaryDepartment: null,
      metadata: { deletedAt: '2026-01-01T00:00:00.000Z' },
      lastLoginAt: null,
      lastLoginIp: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      deletedAt: BigInt(123),
    };
    const erasedUser = {
      ...disabledUser,
      id: 'user-erased',
      metadata: { erased: true },
    };
    const prisma = {
      userAccount: {
        findMany: vi.fn().mockResolvedValue([disabledUser, erasedUser]),
      },
      department: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'dept-sales', name: '业务部', parentId: 'dept-company' },
          { id: 'dept-finance', name: '财务部', parentId: 'dept-company' },
        ]),
      },
    };

    const res = await request(makeApp(prisma))
      .get('/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(prisma.userAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ deletedAt: null }, { status: 'disabled' }] },
    }));
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({ id: 'user-disabled', status: 'disabled' });
    // 部门选项随用户列表下发，前端表单下拉数据源（parentId 供树序+层级缩进渲染）
    expect(res.body.departments).toEqual([
      { id: 'dept-sales', name: '业务部', parentId: 'dept-company' },
      { id: 'dept-finance', name: '财务部', parentId: 'dept-company' },
    ]);
  });

  it('rejects user writes referencing a non-existent department', async () => {
    const prisma = {
      userAccount: {
        update: vi.fn().mockResolvedValue({}),
      },
      department: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ departmentId: 'dept-nope' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'INVALID_DEPARTMENT' });
    expect(prisma.userAccount.update).not.toHaveBeenCalled();
  });

  it('reactivates a disabled existing account instead of failing duplicate creation', async () => {
    const existing = {
      id: 'user-111',
      displayName: 'Old 111',
      email: '111@example.com',
      status: 'disabled',
      primaryDeptId: null,
      metadata: { deletedAt: '2026-01-01T00:00:00.000Z' },
      deletedAt: BigInt(123),
    };
    const prisma = {
      userAccount: {
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, displayName: '111', status: 'active', deletedAt: null }),
      },
      userRole: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
      role: {
        findFirst: vi.fn().mockResolvedValue({ id: 'role-viewer', name: 'viewer' }),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };
    // Account update and role replacement commit in one transaction.
    (prisma as any).$transaction = vi.fn(async (callback: any) => callback(prisma));

    const res = await request(makeApp(prisma))
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ displayName: '111', email: '111@example.com', password: 'secret111', roles: 'viewer' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, userId: 'user-111', reactivated: true });
    expect(prisma.userAccount.update).toHaveBeenCalledWith({
      where: { id: 'user-111' },
      data: expect.objectContaining({
        displayName: '111',
        email: '111@example.com',
        status: 'active',
        primaryDeptId: null,
        deletedAt: null,
      }),
    });
    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-111' } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'reactivate_user', targetId: 'user-111' }),
    });
  });

  it('does not tombstone users when status is changed to disabled', async () => {
    const prisma = {
      userAccount: {
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'disabled' });

    expect(res.status).toBe(200);
    expect(prisma.userAccount.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { status: 'disabled' },
    });
  });

  it('disables accounts without deleting roles, password, or email occupancy', async () => {
    const target = {
      id: 'user-1',
      displayName: 'User One',
      email: 'one@example.com',
      status: 'active',
      metadata: {},
    };
    const prisma = {
      userAccount: {
        findUnique: vi.fn().mockResolvedValue(target),
        update: vi.fn().mockResolvedValue({ ...target, status: 'disabled' }),
      },
      userRole: {
        deleteMany: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const res = await request(makeApp(prisma))
      .post('/admin/users/user-1/disable-account')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userAccount.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        status: 'disabled',
        metadata: expect.objectContaining({
          disabledBy: 'owner-1',
          disabledAt: expect.any(String),
        }),
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'disable_account', targetId: 'user-1' }),
    });
  });

  it('erases personal data and releases the original email slot', async () => {
    const target = {
      id: 'user-erase',
      displayName: 'Erase Me',
      email: 'erase@example.com',
      status: 'active',
      metadata: {},
      lastLoginAt: new Date('2026-01-01T00:00:00Z'),
      lastLoginIp: '127.0.0.1',
    };
    const prisma = {
      userAccount: {
        findUnique: vi.fn().mockResolvedValue(target),
        update: vi.fn().mockResolvedValue({}),
      },
      agentToolRun: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      agentMemory: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      agentMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      agentSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      userRole: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const res = await request(makeApp(prisma))
      .post('/admin/users/user-erase/erase-personal-data')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(prisma.userAccount.update).toHaveBeenCalledWith({
      where: { id: 'user-erase' },
      data: expect.objectContaining({
        displayName: '已抹除用户 -erase',
        email: null,
        passwordHash: '',
        status: 'disabled',
        primaryDeptId: null,
        lastLoginAt: null,
        lastLoginIp: null,
        metadata: expect.objectContaining({
          erased: true,
          deletionMode: 'erase-personal-data',
        }),
      }),
    });
  });
});

describe('admin route error guard（P1 DoS 面：假 ID P2025 → 404，异常 → 500 不进程崩溃）', () => {
  it('PATCH /users/:id 假 ID（Prisma P2025）→ 404 NOT_FOUND，请求有响应不崩溃', async () => {
    const prisma = {
      userAccount: {
        update: vi.fn().mockRejectedValue(Object.assign(new Error('Record to update not found.'), { code: 'P2025' })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-nope')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ displayName: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  it('PATCH /users/:id 非 P2025 异常 → 500 INTERNAL_ERROR（不当 unhandledRejection 打崩进程）', async () => {
    const prisma = {
      userAccount: {
        update: vi.fn().mockRejectedValue(new Error('DB_CONN_LOST')),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ displayName: 'X' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'INTERNAL_ERROR' });
  });

  it('PATCH /users/:id/roles 用户不存在 → 404 NOT_FOUND，不清空角色（此前静默 200）', async () => {
    const prisma = {
      userAccount: { findUnique: vi.fn().mockResolvedValue(null) },
      userRole: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-nope/roles')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ roles: ['role-sales'] });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('PATCH /users/:id/roles 用户存在 + roles:[] → 200 清空语义保留（deleteMany 后不再建）', async () => {
    // 事务化后 deleteMany/create 在 tx 上执行——mock 直接把同一组 fn 引用透传给 tx
    const userRole = {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      create: vi.fn(),
    };
    const prisma = {
      userAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active' }) },
      userRole,
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (fn: any) => fn({ userRole })),
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1/roles')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ roles: [] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(userRole.create).not.toHaveBeenCalled();
  });

  it('PATCH /users/:id/roles 非法角色 → 400 且不写库（事务原子：不再留「已清空未重建」半失败态）', async () => {
    const userRole = {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      create: vi.fn(),
    };
    const prisma = {
      userAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active' }) },
      role: {
        // id 优先解析：未知 id 走 findFirst name 兜底也无命中
        findFirst: vi.fn().mockResolvedValue(null),
      },
      userRole,
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (fn: any) => fn({ userRole })),
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1/roles')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ roles: ['role-nope'] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'INVALID_ROLE' });
    // 校验前置：写入根本没发生（此前实现会先 deleteMany 再 400 留半失败态）
    expect(userRole.deleteMany).not.toHaveBeenCalled();
    expect(userRole.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('POST /users 与注册审批：非 owner 管理员不能授予 SuperAdmin，且不写账号', async () => {
    const superRole = { id: 'role-super-admin', name: '超级管理员', isSystem: true };
    const prisma: any = {
      department: { findUnique: vi.fn().mockResolvedValue({ id: 'dept-1', parentId: 'company', status: 'active' }), findFirst: vi.fn().mockResolvedValue({ id: 'dept-1', parentId: 'company', status: 'active' }) },
      userAccount: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue({ id: 'pending-1', status: 'pending', primaryDeptId: 'dept-1', metadata: {} }), create: vi.fn(), update: vi.fn() },
      role: { findUnique: vi.fn().mockResolvedValue(superRole), findFirst: vi.fn().mockResolvedValue(superRole) },
      userRole: { deleteMany: vi.fn(), create: vi.fn() },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (fn: any) => fn(prisma)),
    };
    const created = await request(makeApp(prisma)).post('/admin/users').set('Authorization', `Bearer ${plainAdminToken()}`)
      .send({ displayName: '新人', email: 'new@example.com', password: 'secret-123', roles: ['role-super-admin'], departmentId: 'dept-1' });
    expect(created.status).toBe(403);
    const approved = await request(makeApp(prisma)).post('/admin/users/pending-1/approve').set('Authorization', `Bearer ${plainAdminToken()}`)
      .send({ roles: ['role-super-admin'], departmentId: 'dept-1' });
    expect(approved.status).toBe(403);
    expect(prisma.userAccount.create).not.toHaveBeenCalled();
    expect(prisma.userAccount.update).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  it('PATCH /users/:id/roles admin（非 owner）授予 SuperAdmin 角色 → 403（自我提权防线）', async () => {
    const userRole = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn(),
    };
    const prisma = {
      userAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active' }) },
      role: {
        findFirst: vi.fn().mockResolvedValue({ id: 'role-super-admin', name: '超级管理员', isSystem: true }),
      },
      userRole,
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (fn: any) => fn({ userRole })),
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1/roles')
      .set('Authorization', `Bearer ${plainAdminToken()}`)
      .send({ roles: ['role-super-admin'] });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    expect(userRole.deleteMany).not.toHaveBeenCalled();
    expect(userRole.create).not.toHaveBeenCalled();
  });

  it('PATCH /users/:id/roles owner 授予 SuperAdmin 角色 → 200（防线只挡非 owner）', async () => {
    const userRole = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
    };
    const prisma = {
      userAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', status: 'active' }) },
      role: {
        findFirst: vi.fn().mockResolvedValue({ id: 'role-super-admin', name: '超级管理员', isSystem: true }),
      },
      userRole,
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (fn: any) => fn({ userRole })),
    };

    const res = await request(makeApp(prisma))
      .patch('/admin/users/user-1/roles')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ roles: ['role-super-admin'] });

    expect(res.status).toBe(200);
    expect(userRole.create).toHaveBeenCalledTimes(1);
  });
});

describe('admin SuperAdmin 角色权限编辑防线', () => {
  function makeRolePrisma(role: any) {
    return {
      role: {
        findUnique: vi.fn().mockResolvedValue(role),
      },
      permission: {
        findUnique: vi.fn().mockResolvedValue({ id: 'perm_orders_read', scope: 'orders:read' }),
      },
      rolePermission: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  it('PATCH /roles/:id/permissions admin（非 owner）改 SuperAdmin 角色 → 403 不落权限变更', async () => {
    const prisma = makeRolePrisma({ id: 'role-super-admin', name: '超级管理员', isSystem: true });

    const res = await request(makeApp(prisma))
      .patch('/admin/roles/role-super-admin/permissions')
      .set('Authorization', `Bearer ${plainAdminToken()}`)
      .send({ addPermissions: ['orders:read'] });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    expect(prisma.rolePermission.upsert).not.toHaveBeenCalled();
    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('PATCH /roles/:id/permissions owner 改 SuperAdmin 角色 → 200 放行（防线只挡非 owner）', async () => {
    const prisma = makeRolePrisma({ id: 'role-super-admin', name: '超级管理员', isSystem: true });

    const res = await request(makeApp(prisma))
      .patch('/admin/roles/role-super-admin/permissions')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ addPermissions: ['orders:read'] });

    expect(res.status).toBe(200);
    expect(prisma.rolePermission.upsert).toHaveBeenCalledTimes(1);
  });

  it('PATCH /roles/:id/permissions admin 改普通角色 → 200 不受防线影响', async () => {
    const prisma = makeRolePrisma({ id: 'role-sales', name: '业务员', isSystem: true });

    const res = await request(makeApp(prisma))
      .patch('/admin/roles/role-sales/permissions')
      .set('Authorization', `Bearer ${plainAdminToken()}`)
      .send({ addPermissions: ['orders:read'] });

    expect(res.status).toBe(200);
    expect(prisma.rolePermission.upsert).toHaveBeenCalledTimes(1);
  });
});

/** Administrative transport uses the same business ownership and atomic audit rules. */
describe('legacy admin approval decision boundaries', () => {
  function approvalFixture(overrides: Record<string, any> = {}, auditFail = false) {
    let row: any = { id: 'admin-approval', requesterId: 'requester', reviewerId: 'admin-1',
      status: 'pending', actionType: 'test:approval-kernel-contract', targetType: 'KernelContract', targetId: 'q1',
      payload: { businessScope: ['line1'] }, decidedAt: null, decisionNote: null, ...overrides };
    const read = async () => ({ ...row });
    const auditCreate = vi.fn(async () => {
      if (auditFail) throw Object.assign(new Error('SQL fault sentinel'), { code: 'P2003' });
      return {};
    });
    const prisma: any = {
      approvalRequest: {
        findUnique: vi.fn(read), findUniqueOrThrow: vi.fn(read),
        updateMany: vi.fn(async ({ data }: any) => { row = { ...row, ...data }; return { count: 1 }; }),
      },
      userRole: { findMany: vi.fn().mockResolvedValue([{ roleId: 'role-admin' }]) },
      // Decision commits the requester's result receipt in the same transaction.
      notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: auditCreate }, $queryRaw: vi.fn().mockResolvedValue([{ id: row.id }]),
      $transaction: vi.fn(async (callback: any) => {
        const before = row;
        try { return await callback(prisma); } catch (error) { row = before; throw error; }
      }),
    };
    return { prisma, auditCreate, getRow: () => row };
  }

  it.each([
    [{ reviewerId: 'another-reviewer' }, 403, 'APPROVAL_NOT_ASSIGNED'],
    [{ requesterId: 'admin-1' }, 403, 'SELF_APPROVAL_FORBIDDEN'],
    [{ status: 'approved', decisionNote: 'original decision' }, 409, 'APPROVAL_ALREADY_RESOLVED'],
    [{ status: 'rejected', decisionNote: 'original rejection' }, 409, 'APPROVAL_ALREADY_RESOLVED'],
  ] as const)('refuses unsafe legacy PATCH (%j)', async (overrides, status, code) => {
    const f = approvalFixture(overrides);
    const before = { ...f.getRow() };
    const response = await request(makeApp(f.prisma)).patch('/admin/approvals/admin-approval')
      .set('Authorization', `Bearer ${plainAdminToken()}`).send({ status: 'approved', decisionNote: 'attempted rewrite' });
    expect(response.status).toBe(status); expect(response.body).toMatchObject({ ok: false, error: code });
    expect(f.getRow()).toEqual(before); expect(f.auditCreate).not.toHaveBeenCalled();
  });

  it('valid assigned admin writes its real actor; a supplied reviewerId cannot forge the audit', async () => {
    const f = approvalFixture();
    const response = await request(makeApp(f.prisma)).patch('/admin/approvals/admin-approval')
      .set('Authorization', `Bearer ${plainAdminToken()}`).send({ status: 'approved', reviewerId: 'forged-user' });
    expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true });
    expect(f.getRow()).toMatchObject({ status: 'approved', reviewerId: 'admin-1' });
    expect(f.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      actorId: 'admin-1', action: 'approve', targetType: 'ApprovalRequest', targetId: 'admin-approval',
      detail: expect.objectContaining({ approvalDecisionFact: expect.objectContaining({ decisionActorId: 'admin-1' }) }),
    }) }));
  });

  it('mandatory audit error rolls back PATCH state rather than leaving an approved row behind a 500', async () => {
    const f = approvalFixture({}, true); const before = { ...f.getRow() };
    const response = await request(makeApp(f.prisma)).patch('/admin/approvals/admin-approval')
      .set('Authorization', `Bearer ${plainAdminToken()}`).send({ status: 'approved', decisionNote: 'attempted decision' });
    expect(response.status).toBe(500); expect(response.body.error).toBe('INTERNAL_ERROR');
    expect(response.body.message).not.toContain('SQL'); expect(f.getRow()).toEqual(before);
  });
});
