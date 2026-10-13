/**
 * productionRouteV2.ts — 生产管线 V2 路由（权限守卫）
 *
 * 挂载点：/api/v2/production
 * 业务逻辑复用现有 stageService，叠加 requirePermission 守卫
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { resolveVisibleOrderIds, isOrderLinkedVisible } from '../auth/orderVisibility';
import { getProductionBoard, getProductionPipeline } from './stageService';
import { legacyProductionWriteBoundary } from './legacyProductionWriteBoundary';
import { readProductionProgressBoard } from './productionProgressService';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

export interface ProductionV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createProductionV2Router(opts: ProductionV2RouterOptions): Router {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));
  router.use(legacyProductionWriteBoundary(opts));

  function serialize(row: any): any {
    if (!row) return null;
    const out: any = Array.isArray(row) ? [...row] : { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    }
    return out;
  }

  router.get('/progress', requirePermission('production:read'), async (req, res) => {
    try {
      res.json({ ok: true, ...await readProductionProgressBoard(opts.prisma, (req as any).actor) });
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'PRODUCTION_PROGRESS_UNAVAILABLE' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // ── 看板 ──
  router.get('/board', requirePermission('production:read'), async (req, res) => {
    try {
      const visible = await resolveVisibleOrderIds(opts.prisma, (req as any).actor, { fresh: true, strict: true });
      const data = await getProductionBoard(opts.prisma, visible);
      res.json({ ok: true, board: serialize(data) });
    } catch (e: any) {

      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });

      res.status(r.status).json({ error: r.code, message: r.message });

    }
  });

  // ── 订单管线详情 ──
  router.get('/:orderId', requirePermission('production:read'), async (req, res) => {
    try {
      const visible = await resolveVisibleOrderIds(opts.prisma, (req as any).actor, { fresh: true, strict: true });
      if (!isOrderLinkedVisible(visible, req.params.orderId)) return res.status(404).json({ error: 'NOT_FOUND', message: '订单生产管线不存在' });
      const data = await getProductionPipeline(opts.prisma, req.params.orderId);
      if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: '订单生产管线不存在' });
      res.json({ ok: true, pipeline: serialize(data) });
    } catch (e: any) {

      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });

      res.status(r.status).json({ error: r.code, message: r.message });

    }
  });

  return router;
}
