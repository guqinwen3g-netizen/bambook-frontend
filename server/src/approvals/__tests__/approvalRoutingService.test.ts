import { describe, expect, it } from 'vitest';
import {
  createApprovalRoutingService,
  NO_REVIEWER_RESOLVED,
} from '../approvalRoutingService';

/**
 * DR-007 组织归属解析单测（全 mock prisma）：
 *   DR7-A1 正常 DEPT_HEAD
 *   DR7-A5/BASE-39 自申请阻断 → 上级部门主管 → ADMIN 兜底（FALLBACK_SELF_APPLY_SUPERVISOR）
 *   DR7-A4 head 空缺 → 本部门 SALES_MANAGER → ADMIN 兜底（FALLBACK_DEPT_HEAD_VACANT）
 *   无部门 → FALLBACK_ADMIN
 *   全落空 → 抛 NO_REVIEWER_RESOLVED（fail-closed，绝不允许 reviewerId=null）
 *   候选跳过申请人本人；唯一例外=全系统仅剩申请人可用
 *   BASE-39-A2 departmentSnapshotId = 创建时 requester.primaryDeptId（快照语义）
 */

type User = { id: string; status: string; deletedAt: null | number; primaryDeptId: string | null };
type Dept = { id: string; status: string; headId: string | null; parentId: string | null };
type Role = { id: string; name: string };
type UserRole = { userId: string; roleId: string; departmentId: string | null; createdAt: Date };

function makePrisma(data: {
  users?: User[];
  departments?: Dept[];
  roles?: Role[];
  userRoles?: UserRole[];
}) {
  const users = data.users ?? [];
  const departments = data.departments ?? [];
  const roles = data.roles ?? [];
  const userRoles = data.userRoles ?? [];

  const activeUser = (id: string) =>
    users.find((u) => u.id === id && u.status === 'active' && u.deletedAt === null) ?? null;

  const matchUserRole = (row: UserRole, where: any): boolean => {
    if (where.departmentId !== undefined && row.departmentId !== where.departmentId) return false;
    if (where.roleId?.in ? !where.roleId.in.includes(row.roleId) : where.roleId !== undefined && row.roleId !== where.roleId) return false;
    if (typeof where.userId === 'string' && row.userId !== where.userId) return false;
    if (where.userId?.not !== undefined && row.userId === where.userId.not) return false;
    if (where.user) {
      const u = users.find((x) => x.id === row.userId);
      if (!u || u.status !== where.user.status || u.deletedAt !== where.user.deletedAt) return false;
    }
    if (where.OR) {
      const ok = where.OR.some((cond: any) => {
        if (cond.roleId?.in) return cond.roleId.in.includes(row.roleId);
        if (cond.role?.name?.contains) {
          const role = roles.find((r) => r.id === row.roleId);
          const needle = String(cond.role.name.contains).toLowerCase();
          return (role?.name ?? '').toLowerCase().includes(needle);
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  };

  const prisma: any = {
    userAccount: {
      findFirst: async ({ where }: any) => {
        if (where.id && where.status === 'active' && where.deletedAt === null) {
          const found = activeUser(where.id);
          return where.primaryDeptId !== undefined && found?.primaryDeptId !== where.primaryDeptId ? null : found;
        }
        return null;
      },
    },
    department: {
      findUnique: async ({ where }: any) => departments.find((d) => d.id === where.id) ?? null,
    },
    userRole: {
      findMany: async ({ where, take }: any) => {
        const rows = userRoles
          .filter((r) => matchUserRole(r, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return rows.slice(0, take ?? rows.length).map((r) => ({ userId: r.userId }));
      },
    },
  };
  return prisma;
}

const u = (id: string, primaryDeptId: string | null = null, status = 'active'): User => ({
  id, status, deletedAt: null, primaryDeptId,
});
const d = (id: string, headId: string | null = null, parentId: string | null = null, status = 'active'): Dept => ({
  id, status, headId, parentId,
});
const ur = (userId: string, roleId: string, departmentId: string | null = null, createdAt = new Date('2026-01-01')): UserRole => ({
  userId, roleId, departmentId, createdAt,
});

const ADMIN_ROLES: Role[] = [
  { id: 'role-admin', name: '系统管理员' },
  { id: 'role-super-admin', name: '超级管理员' },
];

describe('approvalRoutingService: 索赔任意金额总领导路线', () => {
  it('普通部门 head/销售主管不能替代唯一真实 ADMIN 总领导', async () => {
    const prisma = makePrisma({ users: [u('u_sun', 'dept_a'), u('manager', 'dept_a'), u('leader')],
      departments: [d('dept_a', 'manager')], userRoles: [ur('manager', 'role-sales-manager', 'dept_a'), ur('leader', 'role-admin')] });
    expect(await createApprovalRoutingService({ prisma }).resolveClaimLeader('u_sun')).toEqual({ reviewerId: 'leader', route: 'CLAIM_GENERAL_LEADER', departmentSnapshotId: 'dept_a' });
  });

  it('多个 ADMIN 只接受所属部门明确且有效的 ADMIN head', async () => {
    const prisma = makePrisma({ users: [u('u_sun', 'dept_a'), u('leader', 'dept_a'), u('other')],
      departments: [d('dept_a', 'leader')], userRoles: [ur('leader', 'role-admin'), ur('other', 'role-admin')] });
    expect((await createApprovalRoutingService({ prisma }).resolveClaimLeader('u_sun')).reviewerId).toBe('leader');
  });

  it('多个 ADMIN 无明确有效部门 head → 配置冲突，不能任取最早用户', async () => {
    const prisma = makePrisma({ users: [u('u_sun'), u('leader'), u('other')],
      userRoles: [ur('leader', 'role-admin'), ur('other', 'role-admin')] });
    await expect(createApprovalRoutingService({ prisma }).resolveClaimLeader('u_sun')).rejects.toMatchObject({ code: NO_REVIEWER_RESOLVED });
  });

  it('Boss 与角色名称不能自动冒充普通索赔总领导路线', async () => {
    const prisma = makePrisma({ users: [u('u_sun'), u('boss'), u('custom')], roles: [{ id: 'CUSTOM', name: 'Admin Owner' }],
      userRoles: [ur('boss', 'role-super-admin'), ur('custom', 'CUSTOM')] });
    await expect(createApprovalRoutingService({ prisma }).resolveClaimLeader('u_sun')).rejects.toMatchObject({ code: NO_REVIEWER_RESOLVED });
  });

  it('传入 tx 时只从 tx 当前组织配置解析', async () => {
    const root = makePrisma({ users: [u('u_sun'), u('old')], userRoles: [ur('old', 'role-admin')] });
    const tx = makePrisma({ users: [u('u_sun'), u('current')], userRoles: [ur('current', 'role-admin')] });
    expect((await createApprovalRoutingService({ prisma: root }).resolveClaimLeader('u_sun', tx)).reviewerId).toBe('current');
  });
});

describe('approvalRoutingService: DR7-A1 正常部门主管路径', () => {
  it('部门 head active 且非申请人 → reviewerId=headId, route=DEPT_HEAD, snapshot=部门', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment'), u('u_li', 'dept_garment')],
      departments: [d('dept_garment', 'u_li')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res).toEqual({
      reviewerId: 'u_li',
      route: 'DEPT_HEAD',
      departmentSnapshotId: 'dept_garment',
    });
  });
});

describe('approvalRoutingService: 自申请阻断（DR7-A5）', () => {
  it('申请人=本部门 head → 上级部门 head，route=FALLBACK_SELF_APPLY_SUPERVISOR', async () => {
    const prisma = makePrisma({
      users: [u('u_li', 'dept_garment'), u('u_wang', 'dept_parent')],
      departments: [
        d('dept_garment', 'u_li', 'dept_parent'),
        d('dept_parent', 'u_wang'),
      ],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_li');
    expect(res).toEqual({
      reviewerId: 'u_wang',
      route: 'FALLBACK_SELF_APPLY_SUPERVISOR',
      departmentSnapshotId: 'dept_garment',
    });
  });

  it('上级 head 也是申请人 → 继续向上找到再上一级 head', async () => {
    const prisma = makePrisma({
      users: [u('u_li', 'dept_a'), u('u_boss', 'dept_root')],
      departments: [
        d('dept_a', 'u_li', 'dept_mid'),
        d('dept_mid', 'u_li', 'dept_root'), // 中级部门 head 也是申请人 → 跳过
        d('dept_root', 'u_boss'),
      ],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_li');
    expect(res.reviewerId).toBe('u_boss');
    expect(res.route).toBe('FALLBACK_SELF_APPLY_SUPERVISOR');
  });

  it('无上级可解 → ADMIN 兜底，route 仍为 FALLBACK_SELF_APPLY_SUPERVISOR', async () => {
    const prisma = makePrisma({
      users: [u('u_li', 'dept_garment'), u('u_z')],
      departments: [d('dept_garment', 'u_li')], // 无 parent
      roles: ADMIN_ROLES,
      userRoles: [ur('u_z', 'role-admin')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_li');
    expect(res).toEqual({
      reviewerId: 'u_z',
      route: 'FALLBACK_SELF_APPLY_SUPERVISOR',
      departmentSnapshotId: 'dept_garment',
    });
  });
});

describe('approvalRoutingService: head 空缺兜底（DR7-A4）', () => {
  it('headId=null → 本部门 SALES_MANAGER，route=FALLBACK_DEPT_HEAD_VACANT', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment'), u('u_sm', 'dept_garment')],
      departments: [d('dept_garment', null)],
      userRoles: [ur('u_sm', 'role-sales-manager', 'dept_garment')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res).toEqual({
      reviewerId: 'u_sm',
      route: 'FALLBACK_DEPT_HEAD_VACANT',
      departmentSnapshotId: 'dept_garment',
    });
  });

  it('head 用户已停用 → 视同空缺走 SALES_MANAGER 兜底', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment'), u('u_li', 'dept_garment', 'disabled'), u('u_sm', 'dept_garment')],
      departments: [d('dept_garment', 'u_li')],
      userRoles: [ur('u_sm', 'role-sales-manager', 'dept_garment')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res.reviewerId).toBe('u_sm');
    expect(res.route).toBe('FALLBACK_DEPT_HEAD_VACANT');
  });

  it('head 空缺 + 本部门无 SM → ADMIN 兜底，route 仍为 FALLBACK_DEPT_HEAD_VACANT', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment'), u('u_z')],
      departments: [d('dept_garment', null)],
      roles: ADMIN_ROLES,
      userRoles: [ur('u_z', 'role-admin')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res).toEqual({
      reviewerId: 'u_z',
      route: 'FALLBACK_DEPT_HEAD_VACANT',
      departmentSnapshotId: 'dept_garment',
    });
  });
});

describe('approvalRoutingService: 无部门 → FALLBACK_ADMIN', () => {
  it('primaryDeptId=null → ADMIN 兜底，snapshot=DEPT_NONE', async () => {
    const prisma = makePrisma({
      users: [u('u_sun'), u('u_z')],
      roles: ADMIN_ROLES,
      userRoles: [ur('u_z', 'role-admin')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res).toEqual({
      reviewerId: 'u_z',
      route: 'FALLBACK_ADMIN',
      departmentSnapshotId: 'DEPT_NONE',
    });
  });

  it('Role.name 含 admin 的自定义角色不能冒充兜底领导', async () => {
    const prisma = makePrisma({
      users: [u('u_sun'), u('u_custom')],
      roles: [{ id: 'role_custom', name: 'Ops-Admin' }],
      userRoles: [ur('u_custom', 'role_custom')],
    });
    const svc = createApprovalRoutingService({ prisma });
    await expect(svc.resolveReviewerByDepartment('u_sun')).rejects.toMatchObject({ code: NO_REVIEWER_RESOLVED });
  });
});

describe('approvalRoutingService: fail-closed 与候选排除', () => {
  it('全落空（无任何候选）→ 抛 NO_REVIEWER_RESOLVED，绝不返回 null reviewerId', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment')],
      departments: [d('dept_garment', null)],
    });
    const svc = createApprovalRoutingService({ prisma });
    await expect(svc.resolveReviewerByDepartment('u_sun')).rejects.toMatchObject({
      code: NO_REVIEWER_RESOLVED,
    });
  });

  it('申请人不存在/已停用 → 抛 NO_REVIEWER_RESOLVED', async () => {
    const prisma = makePrisma({ users: [] });
    const svc = createApprovalRoutingService({ prisma });
    await expect(svc.resolveReviewerByDepartment('u_ghost')).rejects.toMatchObject({
      code: NO_REVIEWER_RESOLVED,
    });
  });

  it('ADMIN 候选跳过申请人本人（另有 admin 时选他人）', async () => {
    const prisma = makePrisma({
      users: [u('u_sun'), u('u_z')],
      roles: ADMIN_ROLES,
      userRoles: [
        ur('u_sun', 'role-admin', null, new Date('2026-01-01')), // 申请人更早成为 admin
        ur('u_z', 'role-admin', null, new Date('2026-02-01')),
      ],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res.reviewerId).toBe('u_z');
  });

  it('唯一例外：全系统仅剩申请人本人是管理员 → 返回其本人（decide 403 自审守卫兜底）', async () => {
    const prisma = makePrisma({
      users: [u('u_sun')],
      roles: ADMIN_ROLES,
      userRoles: [ur('u_sun', 'role-super-admin')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res.reviewerId).toBe('u_sun');
    expect(res.route).toBe('FALLBACK_ADMIN');
  });

  it('本部门 SALES_MANAGER 候选同样跳过申请人本人', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment'), u('u_z')],
      departments: [d('dept_garment', null)],
      roles: ADMIN_ROLES,
      userRoles: [
        ur('u_sun', 'role-sales-manager', 'dept_garment'), // 申请人是本部门唯一 SM → 跳过
        ur('u_z', 'role-admin'),
      ],
    });
    const svc = createApprovalRoutingService({ prisma });
    const res = await svc.resolveReviewerByDepartment('u_sun');
    expect(res.reviewerId).toBe('u_z');
    expect(res.route).toBe('FALLBACK_DEPT_HEAD_VACANT');
  });
});

describe('approvalRoutingService: BASE-39-A2 部门快照语义', () => {
  it('departmentSnapshotId 恒等于解析时 requester.primaryDeptId（创建后不受后续调动影响）', async () => {
    const prisma = makePrisma({
      users: [u('u_sun', 'dept_garment'), u('u_li', 'dept_garment')],
      departments: [d('dept_garment', 'u_li')],
    });
    const svc = createApprovalRoutingService({ prisma });
    const before = await svc.resolveReviewerByDepartment('u_sun');
    expect(before.departmentSnapshotId).toBe('dept_garment');
    // 模拟申请人调动到面料部后，快照值来源仍是「当前」primaryDeptId；
    // 已落库的审批单快照在创建时固化（createOnce），由 approvalCreateService 写入保证
  });
});
