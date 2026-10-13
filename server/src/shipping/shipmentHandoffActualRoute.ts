import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { readShipmentHandoffActualLoading, recordShipmentHandoffActualLoading, shipmentHandoffJson } from './shipmentHandoffService';

export function createShipmentHandoffActualRouter(prisma: PrismaClient, requireWrite: RequestHandler,
  onDataChange?: (payload: { entity: string; action: string; ids: string[] }) => void) {
  const router = Router();
  const failure = (res: any, error: unknown) => {
    const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '本次实装核量尚未确认，请保留原请求键重试或重新读取。' });
    res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message,
      ...(safe.details === undefined ? {} : { details: safe.details }) } });
  };
  router.get('/handoffs/:handoffId/actual-loading', requirePermission('shipments:read'), requirePermission('orders:read'), async (req, res) => {
    try {
      const data = await readShipmentHandoffActualLoading({ prisma, handoffId: req.params.handoffId, actor: (req as any).actor ?? null });
      res.json({ ok: true, data: shipmentHandoffJson(data) });
    } catch (error) { failure(res, error); }
  });
  router.post('/handoffs/:handoffId/actual-loading', requireWrite, requirePermission('shipments:write'), requirePermission('orders:read'), async (req, res) => {
    try {
      const data = await recordShipmentHandoffActualLoading({ prisma, handoffId: req.params.handoffId, actor: (req as any).actor ?? null,
        input: req.body, ip: req.ip || null });
      onDataChange?.({ entity: 'shipping', action: 'handoff_actual_loading', ids: [data.handoff.id, data.handoff.shipmentId] });
      res.json({ ok: true, data: shipmentHandoffJson(data) });
    } catch (error) { failure(res, error); }
  });
  return router;
}
