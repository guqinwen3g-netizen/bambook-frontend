import { describe, expect, it, vi } from 'vitest';
import { createPermissionService } from '../permissionService';
import { resolveWriteKind } from '../../_shared/rolePermissionMatrix';

/**
 * DR-042 v2.2 视野口径回归（设计真源：小组与业务数据共享.md §5.1，T-33/T-40）：
 *   - v2.2 三层视野：sales 在 relations/crm = { kind: 'all', write: 'self' }
 *     读图书馆（normal 档案全公司可查）、写本人维（跟进人）
 *   - 其余业务数据模块（orders/finance/marketing/traceability）的 department
 *     行级规则统一按本人维（self）解析——组为主，部门退出数据权限计算（v2.1 结论保留）
 *   - 人事编制域（hr）的 department 规则保留原部门维解析（主管看本部门员工档案）
 *   - 真 all 规则零影响（财务/QC/后勤/超管可见性不变）
 */

const SALES_ACTOR = {
  userId: 'user_sales',
  roles: ['sales'],
  departmentIds: ['dept_sales'],
} as any;

const MANAGER_ACTOR = {
  userId: 'user_mgr',
  roles: ['manager'],
  departmentIds: ['dept_sales'],
} as any;

/** teamMember 桩：membership 决定「谁和谁同组」——team 档解析的唯一数据源 */
function makePrisma({
  usersInDept = ['user_sales', 'user_colleague'],
  memberships = [
    { userId: 'user_sales', teamId: 'team_a' },
    { userId: 'user_colleague', teamId: 'team_a' },
    { userId: 'user_mgr', teamId: 'team_a' },
    { userId: 'user_other', teamId: 'team_b' },
  ],
} = {}) {
  return {
    userAccount: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        const roleIds: Record<string, string> = {
          user_sales: 'role-sales', user_mgr: 'role-sales-manager', user_root: 'role-super-admin',
        };
        const roleId = roleIds[where?.id];
        if (!roleId) return null;
        return { id: where.id, status: 'active', deletedAt: null,
          primaryDeptId: where.id === 'user_root' ? null : 'dept_sales',
          roles: [{ departmentId: null, role: { id: roleId, permissions: [] } }] };
      }),
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        (where?.primaryDeptId?.in ?? []).flatMap((deptId: string) =>
          usersInDept.map((id) => ({ id: `${id}@${deptId}` }))),
      ),
    },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    department: {
      findMany: vi.fn().mockResolvedValue([{ id: 'dept_sales' }, { id: 'dept_sub' }]),
    },
    teamMember: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        const rows = memberships.filter((m) => {
          if (where?.userId && m.userId !== where.userId) return false;
          if (where?.teamId?.in && !where.teamId.in.includes(m.teamId)) return false;
          return true;
        });
        return where?.userId ? rows.map((r) => ({ teamId: r.teamId })) : rows.map((r) => ({ userId: r.userId }));
      }),
    },
  } as any;
}

describe('v2.2 视野口径：sales 档案图书馆化（all + write:self）', () => {
  it('T-33/T-40：sales 在 relations 模块 → kind all + write self（读图书馆、写本人维）', async () => {
    const svc = createPermissionService({ prisma: makePrisma() });
    const resolver = await svc.getDataScopeResolver(SALES_ACTOR, 'relations');
    expect(resolver.rule.kind).toBe('all');
    expect(resolveWriteKind(resolver.rule)).toBe('self');
  });

  it('crm 模块同 relations（L2 消费端不再读该 scope，此为口径一致性声明）', async () => {
    const svc = createPermissionService({ prisma: makePrisma() });
    const resolver = await svc.getDataScopeResolver(SALES_ACTOR, 'crm');
    expect(resolver.rule.kind).toBe('all');
    expect(resolveWriteKind(resolver.rule)).toBe('self');
  });

  it('§10.4.1：orders / finance / marketing / traceability 等业务模块按**小组**解析（原 department→self 口径作废）', async () => {
    const svc = createPermissionService({ prisma: makePrisma() });
    for (const moduleName of ['orders', 'finance', 'marketing', 'traceability']) {
      const resolver = await svc.getDataScopeResolver(SALES_ACTOR, moduleName);
      expect(resolver.rule.kind, `${moduleName} 应为 team`).toBe('team');
      // 同组可见 + 本人兜底；跨组（team_b 的 user_other）不可见
      expect(resolver.allowedUserIds).toContain('user_sales');
      expect(resolver.allowedUserIds).toContain('user_colleague');
      expect(resolver.allowedUserIds).not.toContain('user_other');
      expect(resolver.allowedTeamIds).toEqual(['team_a']);
    }
  });

  it('§10.4.1：manager（= 领导）在业务模块看本组——管理视野由小组承载', async () => {
    const svc = createPermissionService({ prisma: makePrisma() });
    const resolver = await svc.getDataScopeResolver(MANAGER_ACTOR, 'relations');
    expect(resolver.rule.kind).toBe('team');
    expect(resolver.allowedUserIds).toContain('user_mgr');
    expect(resolver.allowedUserIds).toContain('user_sales'); // 组内成员
    expect(resolver.allowedUserIds).not.toContain('user_other');
  });

  it('§10.4.1：不在任何小组 → 退化为仅本人（不空集、不放全量）', async () => {
    const svc = createPermissionService({ prisma: makePrisma({ memberships: [] }) });
    const resolver = await svc.getDataScopeResolver(SALES_ACTOR, 'orders');
    expect(resolver.rule.kind).toBe('team');
    expect(resolver.allowedTeamIds).toEqual([]);
    expect(resolver.allowedUserIds).toEqual(['user_sales']);
  });

  it('hr 模块豁免：department 规则保留部门维解析（主管看本部门员工）', async () => {
    const svc = createPermissionService({ prisma: makePrisma() });
    const resolver = await svc.getDataScopeResolver(MANAGER_ACTOR, 'hr');
    expect(resolver.rule.kind).toBe('department');
    // 部门成员集仍在（含子部门展开 + own 兜底）
    expect((resolver.allowedUserIds ?? []).length).toBeGreaterThan(0);
  });

  it('T-11/T-32/T-35：真 all 角色零影响（超管全量，writeKind 亦为 all → confidential 可见）', async () => {
    const svc = createPermissionService({ prisma: makePrisma() });
    const resolver = await svc.getDataScopeResolver(
      { userId: 'user_root', roles: ['owner'], departmentIds: [] } as any,
      'relations',
    );
    expect(resolver.rule.kind).toBe('all');
    expect(resolveWriteKind(resolver.rule)).toBe('all');
  });
});
