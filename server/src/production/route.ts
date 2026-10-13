/**
 * Production Pipeline REST API — /api/v1/production
 *
 * GET    /board                      → 在手订单 × 10 阶段泳道看板聚合（PRD 19.8）
 * GET    /:orderId                    → get full pipeline (stages + checklist + inspection)
 * GET    /progress                   → exact current line/factory completion and QC
 * Legacy whole-order writes return a scoped 409; history remains readable.
 */

import { Router, Request, Response } from 'express';
// ★ D2：多工厂/多工位分批交货的排产覆盖度核对（只读）
import { getOrderProductionCoverage } from './processCoverageService';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { getProductionBoard, getProductionPipeline } from './stageService';
import { legacyProductionWriteBoundary } from './legacyProductionWriteBoundary';
import { readProductionProgressBoard, readProductionProgressAlerts } from './productionProgressService';

import { resolveVisibleOrderIds, isOrderLinkedVisible } from '../auth/orderVisibility';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';
export interface ProductionRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids: string[] }) => void;
}

export function createProductionRouter(opts: ProductionRouterOptions): Router {
  const router = Router();

  // W-C 批三-E 族B 收口：API-Key-only 私有守卫 + legacy requireProductionRole 双退役，
  // 统一 createModuleAuthGuard（JWT 或 API-Key）。读面挂 production:read scope 门；
  // 写面 requireJwtForWrite（JWT-only）＋ production:write scope 门
  // （持有 = SALES/SALES_MANAGER/QC＋SuperAdmin 特判，_shared/rolePermissionMatrix 真源——
  //  修复生产态 fail-closed 死锁：旧守卫 API-Key 无 roles 恒 403，矩阵授权角色无法写）。
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));
  const requireProductionRead = requirePermission('production:read');

  router.use(legacyProductionWriteBoundary(opts));

  router.get('/progress', requireProductionRead, async (req, res) => {
    try {
      const progress = await readProductionProgressBoard(opts.prisma, (req as any).actor);
      res.json({ ok: true, ...progress });
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'PRODUCTION_PROGRESS_UNAVAILABLE' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  router.get('/stats/dashboard', requireProductionRead, async (req, res) => {
    try {
      const progress = await readProductionProgressBoard(opts.prisma, (req as any).actor);
      res.json({ ok: true, stats: progress.stats });
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'DASHBOARD_FAILED' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  router.get('/alerts/scan', requireProductionRead, async (req, res) => {
    try {
      res.json({ ok: true, ...await readProductionProgressAlerts(opts.prisma, (req as any).actor) });
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'ALERT_SCAN_FAILED' });
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  });

  // GET /board — 生产跟单泳道看板聚合（PRD 19.8；必须在 /:orderId 之前注册）
  router.get('/board', requireProductionRead, async (req: Request, res: Response) => {
    try {
      const visible = await resolveVisibleOrderIds(opts.prisma, (req as any).actor, { fresh: true, strict: true });
      const board = await getProductionBoard(opts.prisma, visible);
      res.json({ ok: true, ...board });
    } catch (e: any) {
      const r = safeRouteError(e, { fallbackCode: 'BOARD_FAILED' });
      res.status(r.status).json({ ok: false, error: { code: r.code, message: r.message } });
    }
  });

  // GET /:orderId — full pipeline
  /**
   * ★ D2（2026-09-18）GET /:orderId/capacity-coverage — 排产覆盖度核对（只读）
   *
   * 为什么需要：一张订单可挂多条 `ProductionPlan`（多工位/多批次）与多张 `OutsourcingOrder`
   * （多外协厂），但系统**从不做合计核对** ⇒ 1000 件的订单可以排成 3000 件、也可以只排 200 件，
   * 两种都只有到交期才知道。
   *
   * ★ 判据：按**工序类型**合计（**不是**整单合计）—— 每道工序都排「全量」是正常的
   *   （裁剪 1000 → 缝制 1000 → 包装 1000），整单相加会把正常多工序排产全判成超产。
   *
   * 只报不挡：排产计划是可改的工作稿，硬挡会卡死正常调整（同「溢短装是条款不是门禁」取向）。
   * `?tolerancePercent=3` 可放宽（如成衣 +3% 备品）。
   */
  router.get('/:orderId/capacity-coverage', requireProductionRead, async (req: Request, res: Response) => {
    try {
      const visible = await resolveVisibleOrderIds(opts.prisma, (req as any).actor, { fresh: true, strict: true });
      if (!isOrderLinkedVisible(visible, req.params.orderId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '订单不存在' } });
      const result = await getOrderProductionCoverage(opts.prisma, req.params.orderId, {
        tolerancePercent: req.query.tolerancePercent != null ? Number(req.query.tolerancePercent) : 0,
      });
      if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '订单不存在' } });
      res.json(result);
    } catch (err: any) {
      const error = safeRouteError(err, { fallbackCode: 'COVERAGE_FAILED' });
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
  });

  router.get('/:orderId', requireProductionRead, async (req: Request, res: Response) => {
    try {
      // §10.4.2：生产管线随订单可见（防猜 orderId 直读越权单）
      const visOrder = await resolveVisibleOrderIds(opts.prisma, (req as any).actor, { fresh: true, strict: true });
      if (!isOrderLinkedVisible(visOrder, req.params.orderId)) {
        return res.status(404).json({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: '订单不存在' } });
      }
      const pipeline = await getProductionPipeline(opts.prisma, req.params.orderId);
      res.json({ ok: true, ...pipeline });
    } catch (e: any) {
      const r = safeRouteError(e, { fallbackCode: 'PIPELINE_FETCH_FAILED' });
      res.status(r.status).json({ ok: false, error: { code: r.code, message: r.message } });
    }
  });

  return router;
}
