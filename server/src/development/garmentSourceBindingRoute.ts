import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../auth/permissionGuard';
import { linkGarmentSampleAsset, listGarmentSourceLinks } from './garmentSourceBindingService';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';

export function createGarmentSourceBindingRouter({ prisma, onDataChange }: { prisma: any; onDataChange?: (event: any) => void }) {
  const router = Router();
  const session = (req: Request, res: Response, next: () => void) => {
    if ((req as any).authSource !== 'user-session' || !(req as any).actor?.userId) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '请使用当前登录身份核对成衣来源' } }); return;
    }
    next();
  };
  const run = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    void fn(req, res).catch(error => {
      logger.error('[GarmentSource] 来源关联未完成', { error });
      const r = safeRouteError(error,
        { fallbackCode: 'CONVERT_ASSET_FAILED', fallbackMessage: '成衣来源关联未完成，请核对原请求后重试' });
      res.status(r.status).json({ ok: false, error: { code: r.code, message: r.message } });
    });
  };
  const scope = requirePermission('products:write');
  router.get('/:id/garment-source-links', session, scope, run(async (req, res) => {
    const data = await listGarmentSourceLinks(prisma, req.params.id, (req as any).actor);
    res.json({ ok: true, ...data });
  }));
  router.post('/:id/garment-source-links', session, scope, run(async (req, res) => {
    const data = await linkGarmentSampleAsset(prisma, req.params.id, (req as any).actor, req.body, req.ip);
    onDataChange?.({ entity: 'samples', action: 'source-link', ids: [data.sourceBinding.sampleId] });
    res.json({ ok: true, ...data });
  }));
  return router;
}
