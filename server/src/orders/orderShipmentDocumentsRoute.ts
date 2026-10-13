import type { Request, Response, Router, RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { listOrderShipmentDocuments, recordOrderShipmentDocumentSent } from './orderShipmentDocumentsService';

/** Business-side return path for logistics-issued shipment documents. This
 * records the exact offline customer-send event; it never sends email. */
export function mountOrderShipmentDocumentsRoutes(router: Router, params: {
  prisma: PrismaClient;
  requireWrite: RequestHandler;
}): void {
  router.get('/:id/shipment-documents', requirePermission('orders:read'), requirePermission('shipments:read'),
    requirePermission('customs:read'), async (req: Request, res: Response) => {
      try {
        const result = await listOrderShipmentDocuments(params.prisma, req.params.id, (req as any).actor ?? null);
        return res.json({ ok: true, ...result });
      } catch (error) {
        const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '订单出运单据查询失败，请稍后重试。' });
        return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
      }
    });

  router.post('/:id/shipment-documents/sent', params.requireWrite, requirePermission('orders:write'),
    requirePermission('shipments:read'), requirePermission('customs:read'), async (req: Request, res: Response) => {
      try {
        const result = await recordOrderShipmentDocumentSent(params.prisma, req.params.id, (req as any).actor ?? null, req.body);
        return res.status(result.replayed ? 200 : 201).json({ ok: true, ...result });
      } catch (error) {
        const safe = safeRouteError(error, { fallbackCode: 'UPDATE_FAILED', fallbackMessage: '客户发送记录暂不可确认，请刷新后核对。' });
        return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
      }
    });
}
