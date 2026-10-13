import { Router, type Response } from 'express';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { exactJsonValue } from '../lib/exactJsonValue';
import { safeRouteError } from '../shared/routeError';
import { businessError } from '../shared/errorCodes';
import { createOrderBusinessWorkspaceService } from './orderBusinessWorkspaceService';

/** Mount at /api/v1/orders before the legacy :id route. */
export function createOrderBusinessWorkspaceRouter(options: { prisma: any; apiKeys?: Set<string> }) {
  const router = Router(), auth = { requireAuth: true, apiKeys: options.apiKeys ?? new Set<string>() }, service = createOrderBusinessWorkspaceService(options);
  async function send(res: Response, work: () => Promise<unknown>) {
    try { res.json(exactJsonValue({ ok: true, data: await work() })); }
    catch (error) { const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '当前订单工作区暂时无法核验，请保留原请求后重新核对。' }); res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } }); }
  }
  router.get('/:orderId/business-workspace', createModuleAuthGuard(auth), (req, res) => send(res, () => {
    if (Object.keys(req.query).some(key => !['orderLineId', 'productionBatchId', 'productionBatchRevision'].includes(key))
      || Object.values(req.query).some(value => typeof value !== 'string') || req.query.productionBatchRevision !== undefined && !/^[1-9]\d*$/.test(String(req.query.productionBatchRevision)))
      throw businessError('INVALID_INPUT', '请提供准确订单行、工厂分支和修订号。');
    return service.read(req.params.orderId, extractActorFromRequest(req), { orderLineId: req.query.orderLineId as string | undefined,
      productionBatchId: req.query.productionBatchId as string | undefined,
      ...(req.query.productionBatchRevision === undefined ? {} : { productionBatchRevision: Number(req.query.productionBatchRevision) }) });
  }));
  router.post('/:orderId/business-workspace/continue', createModuleAuthGuard(auth), requireJwtForWrite(auth), (req, res) =>
    send(res, () => service.continue(req.params.orderId, extractActorFromRequest(req), req.body, req.ip)));
  return router;
}
