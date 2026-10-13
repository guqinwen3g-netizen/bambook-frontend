import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { hasScope } from '../auth/permissionService';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { businessError, isBusinessError } from '../shared/errorCodes';

export const PDML_RAW_READ_SCOPES = ['products:read', 'sensitive:cost'] as const;
export const PDML_SYNC_SCOPES = ['data:import'] as const;
export const PDML_MAP_SCOPES = ['data:import', 'products:write', 'sensitive:cost'] as const;

/** Global catalog/cache, not an Order child. Do not invent an Order FK/L2.
 * All capabilities are conjunctive and checked against the current subject;
 * the verified credential ceiling survives reload. No body actor is accepted. */
export async function currentPdmlActor(db: PrismaClient, prior: TokenPayload | null | undefined,
  scopes: readonly PermissionScope[] = []): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', 'PDML 操作需要有效账号。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(db, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
    actor = await buildLoadedAuthTokenPayload(db, user);
    if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验 PDML 权限，请稍后重试。');
  }
  if (scopes.some(scope => !hasScope(actor, scope))) throw businessError('FORBIDDEN', '当前账号没有该 PDML 操作权限。');
  return actor;
}

/** Configuration is an identity pointer only, never an automatic grant or an
 * arbitrary Agent key. Absence means the scheduler has no principal. */
export async function loadPdmlSchedulerActor(db: PrismaClient, userId: string | undefined): Promise<TokenPayload | null> {
  const id = String(userId || '').trim();
  if (!id) return null;
  const actor = await currentPdmlActor(db, { userId: id, roles: [], permissions: [], departmentIds: [],
    permissionCeiling: ['data:import'] }, PDML_SYNC_SCOPES);
  return actor;
}
