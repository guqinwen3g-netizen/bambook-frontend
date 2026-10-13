import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requireAuth as requireUserSession } from '../auth/middleware';
import { requirePermission } from '../auth/permissionGuard';
import { createProductionBatch, listProductionBatches, splitProductionBatch, listFactoryProductionLines, registerFactoryProductionLine, bindProductionBatchLine } from './productionBatchService';
import { completeProductionBatch, readOrderLineCompletion } from './productionCompletionService';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { listProductionStockReceipts, receiveProductionBatchStock } from './productionStockReceiptService';

export interface ProductionBatchRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}
/** Orders actions plus current DB leadership/L2 are enforced in the same
 * locked business tx. Configuration bypass and body actor never grant writes. */
export function createProductionBatchRouter(options: ProductionBatchRouterOptions): Router {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: options.requireAuth, apiKeys: options.apiKeys ?? new Set() }));
  const actor = (req: Request) => (req as Request & { actor?: TokenPayload }).actor ?? null;
  const send = (res: Response, result: any) => {
    if (!result.ok) {
      const safe = safeRouteError(Object.assign(new Error(result.error.message), {
        code: result.error.code, statusCode: result.error.status,
        ...(result.error.details === undefined ? {} : { details: result.error.details }),
      }), { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '生产批次操作结果暂不可确认，请保留原请求并刷新核对。' });
      return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message, status: safe.status,
        ...(safe.details === undefined ? {} : { details: safe.details }) } });
    }
    return res.json({ ok: true, ...result.data });
  };
  const notify = (action: string, ids: string[]) => {
    try { options.onDataChange?.({ entity: 'production-batches', action, ids }); }
    catch (error) { logger.warn('[ProductionBatch] 已提交范围的通知发送失败', { error }); }
  };
  router.get('/orders/:orderId/lines/:lineId', async (req: Request, res: Response) => {
    const result = await listProductionBatches({ prisma: options.prisma, orderId: req.params.orderId, lineId: req.params.lineId, actor: actor(req) });
    return send(res, result);
  });
  router.get('/orders/:orderId/lines/:lineId/completion', async (req: Request, res: Response) => {
    const result = await readOrderLineCompletion({ prisma: options.prisma, orderId: req.params.orderId, lineId: req.params.lineId, actor: actor(req) });
    return send(res, result);
  });
  router.get('/orders/:orderId/lines/:lineId/factory-production-lines', async (req: Request, res: Response) => {
    return send(res, await listFactoryProductionLines({ prisma: options.prisma, orderId: req.params.orderId, lineId: req.params.lineId, actor: actor(req), factoryRelationId: req.query.factoryRelationId }));
  });
  router.post('/orders/:orderId/lines/:lineId/factory-production-lines', requireUserSession, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const result = await registerFactoryProductionLine({ prisma: options.prisma, orderId: req.params.orderId, lineId: req.params.lineId, actor: actor(req), input: req.body });
    if (!result.ok) return send(res, result);
    if (!result.data.replayed) notify('register-factory-line', [result.data.line.id]);
    return res.status(result.data.replayed ? 200 : 201).json({ ok: true, ...result.data });
  });
  router.post('/:batchId/production-line', requireUserSession, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const result = await bindProductionBatchLine({ prisma: options.prisma, batchId: req.params.batchId, actor: actor(req), input: req.body });
    if (!result.ok) return send(res, result);
    if (!result.data.replayed) notify('bind-production-line', [result.data.batch.id]);
    return res.json({ ok: true, ...result.data });
  });
  router.post('/orders/:orderId/lines/:lineId', requireUserSession, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const result = await createProductionBatch({ prisma: options.prisma, orderId: req.params.orderId, lineId: req.params.lineId, actor: actor(req), input: req.body });
    if (result.ok) {
      if (!result.data.replayed) notify('create', [result.data.batch.id]);
      return res.status(result.data.replayed ? 200 : 201).json({ ok: true, ...result.data });
    }
    return send(res, result);
  });
  router.post('/:batchId/split', requireUserSession, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const result = await splitProductionBatch({ prisma: options.prisma, batchId: req.params.batchId, actor: actor(req), input: req.body });
    if (result.ok) {
      if (!result.data.replayed) notify('split', [result.data.parent.id, ...result.data.children.map((child: any) => child.id)]);
      return res.status(result.data.replayed ? 200 : 201).json({ ok: true, ...result.data });
    }
    return send(res, result);
  });
  router.post('/:batchId/complete-production', requireUserSession, requirePermission('orders:write'), async (req: Request, res: Response) => {
    const result = await completeProductionBatch({ prisma: options.prisma, batchId: req.params.batchId, actor: actor(req), input: req.body, ip: req.ip });
    if (!result.ok) return send(res, result);
    if (!result.data.replayed) notify('complete-production', [req.params.batchId]);
    return res.status(result.data.replayed ? 200 : 201).json({ ok: true, ...result.data });
  });
  router.get('/:batchId/stock-receipts', async (req: Request, res: Response) => {
    return send(res, await listProductionStockReceipts({ prisma: options.prisma, batchId: req.params.batchId, actor: actor(req) }));
  });
  router.post('/:batchId/stock-receipts', requireUserSession, requirePermission('orders:read'), requirePermission('inventory:write'), async (req: Request, res: Response) => {
    const result = await receiveProductionBatchStock({ prisma: options.prisma, batchId: req.params.batchId, actor: actor(req), input: req.body });
    if (!result.ok) return send(res, result);
    if (!result.data.replayed) {
      notify('receive', [result.data.receipt.productionBatchId]);
      try { options.onDataChange?.({ entity: 'inventory', action: 'receive', ids: [result.data.receipt.inventoryItemId] }); }
      catch (error) { logger.warn('[ProductionBatch] 已提交实物入库的通知发送失败', { error }); }
    }
    return res.status(result.data.replayed ? 200 : 201).json({ ok: true, ...result.data });
  });
  return router;
}
