import type { PrismaClient } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import { extractActorFromRequest } from '../auth/middleware';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { freshOrderLineScope } from './orderLineWriteAccess';

/** After the actual module JWT/employee-key guard, revalidate current read
 * grants and L2. No leadership restriction is added to reads; owner identity
 * cannot restore an absent current read scope. A key is a bound credential,
 * never an anonymous all-data identity. No body identity or read-cache grant.
 */
export function createCurrentOrderLineReadAccess(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const trustedRequest = req as Request & { actor?: TokenPayload; authSource?: string };
    const prior = extractActorFromRequest(req)
      ?? (trustedRequest.authSource === 'api-key' ? trustedRequest.actor : null);
    try {
      if (!prior?.userId) throw businessError('UNAUTHORIZED', '订单行查询需要有效的用户会话或已绑定员工的 API Key。');
      const user = await loadUserWithRoles(prisma, prior.userId);
      if (!user || user.status !== 'active' || user.deletedAt != null) {
        throw businessError('ACCOUNT_DISABLED', '账号已失效，请重新登录。');
      }
      const current = await buildLoadedAuthTokenPayload(prisma, user);
      if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
      // Shared decision still checks the signed cap and the loaded marker.
      // Remove only the technical role shortcut; actual DB scopes are required.
      if (!hasScope({ ...current, roles: [] }, 'orders:read')) {
        throw businessError('FORBIDDEN', '当前账号没有订单行读取权限。');
      }
      const scope = await freshOrderLineScope(prisma, current);
      trustedRequest.actor = current;
      res.locals.orderLineReadScope = scope;
      return next();
    } catch (error) {
      const result = safeRouteError(error, { fallbackCode: 'AUTHORIZATION_UNAVAILABLE', fallbackMessage: '暂时无法核验订单可查询范围，请稍后重试。' });
      return res.status(result.status).json({ ok: false, error: { code: result.code, message: result.message } });
    }
  };
}
