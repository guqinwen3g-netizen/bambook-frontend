import { describe, expect, it, vi } from 'vitest';
import { createPermissionService } from '../permissionService';

/**
 * UserPermissionOverrides 扩展授权通道测试（Phase 1 DR-007 scope 扩展）：
 *   - active + 未过期（expiresAt=null 或将来）→ scope 并入聚合结果
 *   - 已过期 → 不并入
 *   - isActive=false（已撤销）→ 不并入
 *   - 软删（deletedAt 非空）→ 不并入
 */

type OverrideRow = {
  userId: string;
  scope: string;
  isActive: boolean;
  deletedAt: Date | null;
  expiresAt: Date | null;
};

function makePrisma(overrides: OverrideRow[]) {
  const user = {
    id: 'u_test',
    primaryDeptId: null,
    status: 'active',
    roles: [
      {
        departmentId: null,
        role: {
          id: 'role-sales',
          permissions: [{ permission: { scope: 'orders:read' } }],
        },
      },
    ],
  };

  const prisma: any = {
    userAccount: {
      findUnique: vi.fn().mockResolvedValue(user),
    },
    department: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    userPermissionOverrides: {
      // 按服务端 where 条件过滤，保证测试语义与 DB 行为一致
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        const now = new Date();
        return overrides
          .filter((o) => o.userId === where.userId && o.isActive === true && o.deletedAt === null)
          .filter((o) => o.expiresAt === null || o.expiresAt > now)
          .map((o) => ({ scope: o.scope }));
      }),
    },
  };
  return prisma;
}

describe('permissionService: UserPermissionOverrides 扩展授权并入', () => {
  it('active + expiresAt=null → scope 并入 scopes', async () => {
    const prisma = makePrisma([
      { userId: 'u_test', scope: 'hr:salary:read', isActive: true, deletedAt: null, expiresAt: null },
    ]);
    const svc = createPermissionService({ prisma });
    const ctx = await svc.getUserPermissionContext('u_test');
    expect(ctx).not.toBeNull();
    expect(ctx!.scopes).toContain('orders:read'); // 角色聚合的仍在
    expect(ctx!.scopes).toContain('hr:salary:read'); // override 并入
  });

  it('active + 未来过期时间 → scope 并入', async () => {
    const prisma = makePrisma([
      {
        userId: 'u_test',
        scope: 'sensitive:salary',
        isActive: true,
        deletedAt: null,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    ]);
    const svc = createPermissionService({ prisma });
    const ctx = await svc.getUserPermissionContext('u_test');
    expect(ctx!.scopes).toContain('sensitive:salary');
  });

  it('已过期 → 不并入', async () => {
    const prisma = makePrisma([
      {
        userId: 'u_test',
        scope: 'hr:salary:read',
        isActive: true,
        deletedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);
    const svc = createPermissionService({ prisma });
    const ctx = await svc.getUserPermissionContext('u_test');
    expect(ctx!.scopes).not.toContain('hr:salary:read');
  });

  it('isActive=false（已撤销）→ 不并入', async () => {
    const prisma = makePrisma([
      { userId: 'u_test', scope: 'hr:salary:read', isActive: false, deletedAt: null, expiresAt: null },
    ]);
    const svc = createPermissionService({ prisma });
    const ctx = await svc.getUserPermissionContext('u_test');
    expect(ctx!.scopes).not.toContain('hr:salary:read');
  });

  it('软删（deletedAt 非空）→ 不并入', async () => {
    const prisma = makePrisma([
      { userId: 'u_test', scope: 'hr:salary:read', isActive: true, deletedAt: new Date(), expiresAt: null },
    ]);
    const svc = createPermissionService({ prisma });
    const ctx = await svc.getUserPermissionContext('u_test');
    expect(ctx!.scopes).not.toContain('hr:salary:read');
  });

  it('findMany 查询条件包含 isActive/deletedAt/expiresAt 三重守卫', async () => {
    const prisma = makePrisma([]);
    const svc = createPermissionService({ prisma });
    await svc.getUserPermissionContext('u_test');
    const where = prisma.userPermissionOverrides.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('u_test');
    expect(where.isActive).toBe(true);
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });
});
