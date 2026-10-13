import type { PrismaClient } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import { extractActorFromRequest } from './middleware';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from './tokenHelpers';
import type { TokenPayload } from './service';
import { logger } from '../lib/logger';
import { httpStatusOfCode } from '../shared/errorCodes';

/** Strict write identity. Unlike development read compatibility, a write always
 * verifies a user JWT and current active account/grants. Existing scope/role
 * middleware then judges this server-loaded actor, preserving the credential cap.
 * No body identity, API-key fallback, role defaults, or grant cache participates. */
export function createCurrentWriteActor(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const prior = extractActorFromRequest(req);
    if (!prior?.userId) return res.status(401).json({ error: 'UNAUTHORIZED', message: '写操作需要有效的用户登录会话。' });
    try {
      const user = await loadUserWithRoles(prisma, prior.userId);
      if (!user || user.status !== 'active' || user.deletedAt != null) return res.status(401).json({ error: 'ACCOUNT_DISABLED', message: '账号已失效，请重新登录。' });
      const current = await buildLoadedAuthTokenPayload(prisma, user);
      if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
      (req as Request & { actor?: TokenPayload }).actor = current;
      (req as Request & { authSource?: string }).authSource = 'user-session';
      return next();
    } catch (error) {
      logger.warn('[write-authorization] current authorization load failed', { userId: prior.userId, error: (error as Error).message });
      return res.status(httpStatusOfCode('AUTHORIZATION_UNAVAILABLE')).json({ error: 'AUTHORIZATION_UNAVAILABLE', message: '暂时无法核验写入权限，请稍后重试。' });
    }
  };
}
