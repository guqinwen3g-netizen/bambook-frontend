import type { PrismaClient } from '@prisma/client';
import type { Request, Response, NextFunction } from 'express';
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { requirePermission } from '../auth/permissionGuard';
import { requireJwtForWrite } from '../auth/moduleGuard';
import { resolveVisibleOrderIds, isOrderLinkedVisible } from '../auth/orderVisibility';
import { safeRouteError } from '../shared/routeError';

/** Retire the whole-order ten-stage writer at the actual HTTP boundary. It
 * cannot sign QC, waive PP, resume NOK or mark a shipment from a stage label. */
export function legacyProductionWriteBoundary(options: { prisma: PrismaClient; requireAuth: boolean; apiKeys: Set<string> }) {
  const jwt = requireJwtForWrite(options), current = createCurrentWriteActor(options.prisma), scope = requirePermission('production:write');
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^\/([^/]+)\/(?:advance\/[^/]+|block\/[^/]+|sign\/[^/]+|checklist|inspection)\/?$/.exec(req.path);
    if (!match || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    return jwt(req, res, () => current(req, res, () => scope(req, res, async () => {
      try {
        const visible = await resolveVisibleOrderIds(options.prisma, (req as Request & { actor?: any }).actor, { fresh: true, strict: true });
        if (!isOrderLinkedVisible(visible, decodeURIComponent(match[1]))) return res.status(404).json({ error: 'NOT_FOUND', message: '订单不存在或不在当前业务范围。' });
        return res.status(409).json({ ok: false, error: { code: 'EXACT_PRODUCTION_COMMAND_REQUIRED',
          message: '请打开此订单的准确产品条目和工厂分支，登记本次真实样品、检验或放行。历史整单阶段保留只读。' } });
      } catch (error) {
        const safe = safeRouteError(error, { fallbackCode: 'AUTHORIZATION_UNAVAILABLE' });
        return res.status(safe.status).json({ error: safe.code, message: safe.message });
      }
    })));
  };
}
