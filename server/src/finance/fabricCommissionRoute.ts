import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { safeRouteError } from '../shared/routeError';
import { documentSourceJson } from '../shipping/shipmentDocumentSource';
import { getFabricCommissionSettlement, settleFabricCommission, getFabricCommissionDocument, getFabricCommissionBusinessDocument, listPendingFabricCommissionReceivables, registerFabricCommissionReceivable } from './fabricCommissionService';
import { renderFabricCommissionDocument } from './fabricCommissionDocument';

const handler = (run: (req: Request) => Promise<unknown>, status = 200) => async (req: Request, res: Response) => {
  try { const value = await run(req); res.status(value && typeof value === 'object' && 'replayed' in value && value.replayed ? 200 : status)
    .json(documentSourceJson({ ok: true, ...value as object })); }
  catch (error) { const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '佣金结果暂不可确认，请保留原请求核对实际来源。' });
    res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } }); }
};
/** Mount below authenticated /orders. No router-wide middleware can intercept
 * unrelated order paths; services always recheck actual actor and scope. */
export function createFabricCommissionBusinessRouter({ prisma }: { prisma: PrismaClient }) {
  const router = Router();
  router.get('/:orderId/fabric-commission', handler(req => getFabricCommissionSettlement(prisma, extractActorFromRequest(req), req.params.orderId)));
  router.post('/:orderId/fabric-commission/settle', handler(req => settleFabricCommission(prisma, extractActorFromRequest(req), req.params.orderId, req.body), 201));
  router.get('/:orderId/fabric-commission/documents/:documentId/html', async (req, res) => {
    try { res.type('html').send(renderFabricCommissionDocument(await getFabricCommissionBusinessDocument(prisma, extractActorFromRequest(req), req.params.orderId, req.params.documentId))); }
    catch (error) { const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '佣金原票暂不可读取。' }); res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } }); }
  });
  return router;
}
/** Mount below authenticated /finance/fabric-commission-cis. */
export function createFabricCommissionFinanceRouter({ prisma }: { prisma: PrismaClient }) {
  const router = Router();
  router.get('/', handler(req => listPendingFabricCommissionReceivables(prisma, extractActorFromRequest(req))));
  router.get('/:documentId', handler(req => getFabricCommissionDocument(prisma, extractActorFromRequest(req), req.params.documentId)));
  router.post('/:documentId/register', handler(req => registerFabricCommissionReceivable(prisma, extractActorFromRequest(req), req.params.documentId, req.body), 201));
  return router;
}
