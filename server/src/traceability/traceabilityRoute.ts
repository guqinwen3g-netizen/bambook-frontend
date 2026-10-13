/**
 * traceabilityRoute.ts — 一键溯源路由
 *
 * 挂载点：/api/v2/trace
 *
 * 路由：
 *   GET /:scenario/:rootId — 执行溯源查询
 *     scenario: customerPanorama | orderFulfillment | quoteToShip |
 *               supplierPanorama | productCostChain | taxRefundChain |
 *               purchaseToStock（W-C A1 采购库存链）
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { getTraceabilityService, type TraceScenario } from './traceabilityService';

export interface TraceabilityRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

const SCENARIOS: TraceScenario[] = [
  'customerPanorama', 'orderFulfillment', 'quoteToShip',
  'supplierPanorama', 'productCostChain', 'taxRefundChain',
  'purchaseToStock',
];

const SCENARIO_PERMISSION_MAP: Record<TraceScenario, string> = {
  customerPanorama: 'relations:read',
  orderFulfillment: 'orders:read',
  quoteToShip:      'finance:read',
  supplierPanorama: 'relations:read',
  productCostChain: 'finance:read',
  taxRefundChain:   'finance:read',
  purchaseToStock:  'procurement:read',
};

export function createTraceabilityRouter(opts: TraceabilityRouterOptions): Router {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));
  const svc = getTraceabilityService(opts.prisma);

  router.get('/:scenario/:rootId', async (req, res) => {
    const scenario = req.params.scenario as TraceScenario;
    if (!SCENARIOS.includes(scenario)) {
      return res.status(400).json({ error: 'VALIDATION_FAILED', message: `scenario 必须是: ${SCENARIOS.join(', ')}` });
    }
    // 动态权限校验
    const requiredPerm = SCENARIO_PERMISSION_MAP[scenario];
    const permMiddleware = requirePermission(requiredPerm as any);
    permMiddleware(req, res, async () => {
      try {
        const actor = extractActorFromRequest(req);
        const result = await svc.trace(actor, scenario, req.params.rootId);
        res.json({ ok: true, ...result });
      } catch (e: any) {
        const code = e?.message === 'NOT_FOUND' ? 404 : 500;
        res.status(code).json({ error: e?.message, message: e?.message });
      }
    });
  });

  return router;
}
