import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';

/** Call only with freshly loaded account grants. Professional authority comes
 * from explicit scopes, including an actual wildcard, never a role label.
 * A signed API credential still limits those current account grants. */
export function hasActualQcScope(actor: Pick<TokenPayload, 'permissions' | 'permissionCeiling'> | null | undefined,
  scope: PermissionScope): boolean {
  if (!actor || !Array.isArray(actor.permissions)) return false;
  if (actor.permissionCeiling !== undefined && (!Array.isArray(actor.permissionCeiling)
    || !actor.permissionCeiling.includes('*') && !actor.permissionCeiling.includes(scope))) return false;
  return actor.permissions.includes('*') || actor.permissions.includes(scope);
}

export function qcOrderInspectionScope(order: { businessLine?: unknown; type?: unknown } | null | undefined):
  'qc:fabric_chain:write' | 'qc:garment_chain:write' | null {
  if (!order) return null;
  const line = String(order.businessLine ?? '').trim().toLowerCase(), type = String(order.type ?? '').trim().toLowerCase();
  if (line === 'garment' || line === 'capsule') return 'qc:garment_chain:write';
  if (line === 'fabric') return 'qc:fabric_chain:write';
  if (type === 'garment' || type === 'apparel') return 'qc:garment_chain:write';
  return type === 'fabric' ? 'qc:fabric_chain:write' : null;
}
