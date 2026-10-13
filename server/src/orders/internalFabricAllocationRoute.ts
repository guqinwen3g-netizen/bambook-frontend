import { Router, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { safeRouteError } from '../shared/routeError';
import { serializeValue } from '../lib/serializeValue';
import { createInternalFabricAllocationService } from './internalFabricAllocationService';

/** Mount at /api/v1. Namespaced paths precede legacy Order catch-alls. */
export function createInternalFabricAllocationRouter(options: { prisma: PrismaClient; apiKeys?: Set<string>; requireAuth?: boolean }) {
  const router = Router(), auth = { requireAuth: true, apiKeys: options.apiKeys ?? new Set<string>() };
  const guard = createModuleAuthGuard(auth), write = requireJwtForWrite(auth), service = createInternalFabricAllocationService(options);
  async function send(res: Response, work: () => Promise<unknown>) {
    try { res.json({ ok: true, data: serializeValue(await work()) }); }
    catch (error) { const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }); res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } }); }
  }
  router.get('/orders/internal-demand/personnel', guard, (req, res) => send(res, () => service.personnel((req as any).actor)));
  router.get('/orders/:orderId/lines/:lineId/fabric-allocation-context', guard, (req, res) => send(res, () => service.context((req as any).actor, req.params.orderId, req.params.lineId)));
  router.post('/orders/:orderId/lines/:lineId/fabric-allocations', guard, write, (req, res) => send(res, () => service.allocate((req as any).actor, req.params.orderId, req.params.lineId, req.body)));
  router.post('/fabric-allocations/:id/cancel', guard, write, (req, res) => send(res, () => service.cancel((req as any).actor, req.params.id, req.body)));
  return router;
}
