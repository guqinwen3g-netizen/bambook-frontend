/**
 * Phase C1 — 经营驾驶舱 API — /api/v1/dashboard
 *
 * 只读聚合端点，无 mutation；鉴权与其他 ERP 模块一致（JWT 或 API key）。
 * W-C 权限收口：/cockpit 内容即经营驾驶舱（含财务敏感 KPI），
 * 叠加 requirePermission('cockpit:read') scope 门（与 VIEW_TO_MAIN_SCOPES[View.Cockpit] 对齐），
 * 且出口按 sensitive:cost / sensitive:profit 遮罩（sales 等无敏感 scope 角色
 * 的 cost/margin/marginRate/collectionRate 置 null，见 sensitiveMask.ts）。
 */
import { Router, Request, Response } from 'express';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { PrismaClient } from '@prisma/client';
import { getBusinessCockpit } from './dashboardService';
import { maskBusinessCockpit } from './sensitiveMask';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { getPersonalWorkbench } from './workbenchService';
import { safeRouteError } from '../shared/routeError';

export interface DashboardRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createDashboardRouter(options: DashboardRouterOptions): Router {
  const { prisma, requireAuth, apiKeys } = options;
  const router = Router();

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));

  // Personal home accepts a real user session, including accounts without cockpit financial scopes.
  router.get('/workbench', async (req: Request, res: Response) => {
    if ((req as any).authSource !== 'user-session' || !(req as any).actor?.userId) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请登录后查看个人工作台。' } });
    }
    try {
      const result = await getPersonalWorkbench(prisma, (req as any).actor, { group: req.query.group, cursor: req.query.cursor, limit: req.query.limit });
      res.json(result);
    } catch (error) {
      const failure = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '个人工作台暂时无法读取，请重试。' });
      res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  // GET /api/v1/dashboard/cockpit?from=YYYY-MM-DD&to=YYYY-MM-DD&marginRowLimit=N
  router.get('/cockpit', requirePermission('cockpit:read'), async (req: Request, res: Response) => {
    try {
      const from = req.query.from ? String(req.query.from) : undefined;
      const to = req.query.to ? String(req.query.to) : undefined;
      if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
        return res.status(400).json({ error: { code: 'INVALID_DATE', message: 'from/to 必须为 YYYY-MM-DD' } });
      }
      const marginRowLimit = req.query.marginRowLimit ? Number(req.query.marginRowLimit) : undefined;
      if (marginRowLimit != null && (!Number.isFinite(marginRowLimit) || marginRowLimit < 1)) {
        return res.status(400).json({ error: { code: 'INVALID_LIMIT', message: 'marginRowLimit 必须为正整数' } });
      }
      // §10.4.2 三档数据范围：驾驶舱取数按 actor 可见订单集收敛（owner/全档 → null 不受限）
      const scopeWhere = await buildOrderListScopeWhere(prisma, (req as any).actor ?? null);
      const cockpit = await getBusinessCockpit(prisma, { from, to, marginRowLimit, actor: (req as any).actor ?? undefined, orderScopeWhere: scopeWhere });
      res.json(maskBusinessCockpit(cockpit, req));
    } catch (err: any) {
      res.status(500).json({ error: { code: 'COCKPIT_FAILED', message: '驾驶舱数据加载失败，请稍后重试' } });
    }
  });

  return router;
}
