import { Router, type Request, type Response, type NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { readGarmentTrims, saveGarmentTrimTask, confirmGarmentTrimTask, readGarmentTrimNotice, saveGarmentMaterialUse } from './garmentTrimService';

/** Mount alongside the existing /v1/development routers. */
export function createGarmentTrimRouter({ prisma }: { prisma: PrismaClient }) {
  const router = Router();
  const session = (req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).actor?.userId || (req as any).authSource !== 'user-session') return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请登录后办理辅料任务' } });
    next();
  };
  const context = (req: Request) => ({ prisma, actorId: (req as any).actor.userId, trustedActor: (req as any).actor, ip: req.ip });
  const handle = (run: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.json(await run(req)); }
    catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'GARMENT_TRIM_FAILED', fallbackMessage: '辅料操作未完成，请核对原请求后重试' });
      if (failure.status >= 500) logger.error('[garment-trim] operation failed', { error });
      res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  };
  router.get('/:id/garment-trims', session, requirePermission('products:read'), handle(req => readGarmentTrims(context(req), req.params.id)));
  router.post('/:id/garment-trim-tasks', session, requirePermission('products:write'), handle(req => saveGarmentTrimTask(context(req), req.params.id, req.body ?? {})));
  router.patch('/:id/garment-trim-tasks/:taskId', session, requirePermission('products:write'), handle(req => saveGarmentTrimTask(context(req), req.params.id, req.body ?? {}, req.params.taskId)));
  router.post('/:id/garment-trim-tasks/:taskId/confirm', session, requirePermission('products:write'), handle(req => confirmGarmentTrimTask(context(req), req.params.id, req.params.taskId, req.body ?? {})));
  router.get('/:id/garment-trim-tasks/:taskId/notice', session, requirePermission('products:read'), handle(req => readGarmentTrimNotice(context(req), req.params.id, req.params.taskId)));
  router.post('/:id/garment-material-uses', session, requirePermission('products:write'), handle(req => saveGarmentMaterialUse(context(req), req.params.id, req.body ?? {})));
  router.patch('/:id/garment-material-uses/:useId', session, requirePermission('products:write'), handle(req => saveGarmentMaterialUse(context(req), req.params.id, req.body ?? {}, req.params.useId)));
  return router;
}
