import { departmentAuthorization } from './departmentAuthorization';
import { PrismaClient } from '@prisma/client';
import { AgentRole } from '../agent/types';
import { ROLE_ID_TO_LEGACY_AGENT_ROLE, legacyAgentRoleForId, loadEffectivePermissionScopes } from './permissionService';
import type { TokenPayload } from './service';

/**
 * 登录 token 构造的单一事实来源（single source of truth）。
 * 登录路由与开发调试面板（一键切换账号）都必须走这里，
 * 确保两者签发的 token payload 完全一致，权限守卫不会因来源不同而放行/拒绝差异。
 */

export function userRolesToLegacyAgentRoles(
  userRoles: Array<{ roleId: string; role?: { name?: string | null; isSystem?: boolean | null } }>,
): { legacy: AgentRole[]; newRoleIds: string[] } {
  const legacy = new Set<AgentRole>();
  const newRoleIds: string[] = [];
  for (const ur of userRoles) {
    if (!ur.roleId) continue;
    newRoleIds.push(ur.roleId);
    const mapped = legacyAgentRoleForId(ur.roleId);
    if (mapped) {
      // 'owner' 同时包含 owner + admin（owner 级权限应该同时拥有 admin 范围的检查）
      legacy.add(mapped);
      if (mapped === 'owner' && ROLE_ID_TO_LEGACY_AGENT_ROLE[ur.roleId]) legacy.add('admin');
      if (mapped === 'finance') legacy.add('finance');
    }
  }
  return { legacy: Array.from(legacy), newRoleIds };
}

export function collectPermissionScopes(roles: Array<{ role?: { permissions?: Array<{ permission?: { scope?: string | null } }> } }>): string[] {
  const scopes = new Set<string>();
  for (const userRole of roles) {
    for (const rolePermission of userRole.role?.permissions || []) {
      const scope = rolePermission.permission?.scope;
      if (scope) scopes.add(scope);
    }
  }
  return Array.from(scopes).sort();
}

export function serializeAuthUser(user: any, roles: AgentRole[], permissions: string[], departmentIds: string[], extra?: { newRoleIds?: string[]; authorizationLoaded?: true; permissionCeiling?: string[] }) {
  // Display metadata comes only from this user's current loaded role tree.
  const roleLabels = Array.from(new Set(extra?.newRoleIds || [])).flatMap(id => {
    const assigned = (user.roles || []).find((entry: any) => entry.roleId === id);
    const name = assigned?.role?.name;
    return typeof name === 'string' && name.trim() ? [{ id, name }] : [];
  });
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: (user as any).avatarUrl || null,
    roles,
    roleIds: extra?.newRoleIds || [],
    roleLabels,
    ...(extra?.permissionCeiling !== undefined ? { permissionCeiling: [...extra.permissionCeiling] } : {}),
    ...(extra?.authorizationLoaded === true ? { authorizationLoaded: true } : {}),
    departmentIds: departmentIds.length ? departmentIds : [user.primaryDeptId || 'company'],
    department: user.primaryDepartment?.name || null,
    ...departmentAuthorization(user, extra?.newRoleIds || [], permissions),
  };
}

/** 按 id 加载带角色/权限树的用户（与登录路由 include 完全一致）。 */
export async function loadUserWithRoles(prisma: PrismaClient, userId: string) {
  return prisma.userAccount.findFirst({
    where: { id: userId, deletedAt: null },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      primaryDepartment: true,
    },
  });
}

/** Compatibility projection only; it cannot certify a current DB grant load. */
export function buildAuthTokenPayload(user: any): TokenPayload {
  const { legacy: roles, newRoleIds } = userRolesToLegacyAgentRoles(
    (user.roles || []).map((ur: any) => ({ roleId: ur.roleId, role: ur.role })),
  );
  const permissions = collectPermissionScopes(user.roles || []);
  const departmentIds = (user.roles || []).map((ur: any) => ur.departmentId).filter(Boolean) as string[];
  return {
    userId: user.id,
    displayName: user.displayName,
    roles,
    roleIds: newRoleIds,
    permissions,
    departmentIds: departmentIds.length ? departmentIds : [user.primaryDeptId || 'company'],
  };
}

/**
 * Runtime login/me/refresh/dev-login builder. The user MUST come from a current
 * DB query with roles -> role -> permissions -> permission included. Only after
 * the additional personal-grant query succeeds do we stamp a loaded snapshot.
 */
export async function buildLoadedAuthTokenPayload(prisma: PrismaClient, user: any): Promise<TokenPayload> {
  if (user.status !== 'active' || user.deletedAt != null) throw new Error('AUTHORIZATION_ACCOUNT_INACTIVE');
  if (!Array.isArray(user.roles) || user.roles.some((ur: any) => !Array.isArray(ur.role?.permissions))) {
    throw new Error('AUTHORIZATION_ROLE_TREE_NOT_LOADED');
  }
  const payload = buildAuthTokenPayload(user);
  const permissions = await loadEffectivePermissionScopes(prisma, user.id, payload.permissions);
  return { ...payload, ...departmentAuthorization(user, payload.roleIds || [], permissions), authorizationLoaded: true };
}
