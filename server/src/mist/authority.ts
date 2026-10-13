import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { fail } from './errors';
export type FreshAuthority = (db: any, prior: TokenPayload, permission?: string | null) => Promise<TokenPayload>;
/** Always reload the real account and effective grants in the current transaction. */
export const freshMistAuthority: FreshAuthority = async (db, prior, permission) => {
  if (!prior?.userId || (prior as any).kind === 'customer') fail('UNAUTHORIZED', '请使用有效员工账号登录', 401);
  const user = await loadUserWithRoles(db, prior.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) fail('ACCOUNT_DISABLED', '账号已失效，请重新登录', 401);
  const current = await buildLoadedAuthTokenPayload(db, user);
  if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
  if (permission && !hasScope(current, permission as any)) fail('FORBIDDEN', '当前账号没有执行此操作的权限', 403);
  return current;
};
