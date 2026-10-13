import type { AuthUser } from '../services/authService';
import { SYSTEM_ROLE_META, type SystemRoleId } from './rolePermissionMatrix';

/** Account display only. Permissions and JWT compatibility roles remain independent. */
export function displayAuthRoles(user: Pick<AuthUser, 'roles' | 'roleIds' | 'roleLabels'>): string {
  if (user.roleIds === undefined) return user.roles.join(', ') || '-';
  const ids = Array.from(new Set((Array.isArray(user.roleIds) ? user.roleIds : [])
    .filter(id => typeof id === 'string' && id.trim())));
  if (!ids.length) return '未分配角色';
  return ids.map(id => {
    const label = (Array.isArray(user.roleLabels) ? user.roleLabels : [])
      .find(entry => entry?.id === id && typeof entry.name === 'string' && entry.name.trim());
    if (label) return id === 'role-super-admin' && label.name.trim() === '老板' ? '总经理' : label.name.trim();
    if (Object.prototype.hasOwnProperty.call(SYSTEM_ROLE_META, id)) return SYSTEM_ROLE_META[id as SystemRoleId].name;
    return `${id}（名称待核对）`;
  }).join(', ');
}
