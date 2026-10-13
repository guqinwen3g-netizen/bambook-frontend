/**
 * 阶段 P0 回补 — 业务线模块路由（PRD 6.2），挂载于 /api/v1/business-lines
 *
 * 端点：
 *   - GET    /                          — 业务线列表（?includeInactive=true，sortOrder 升序）
 *   - POST   /                          — 注册业务线 {code, name, ...}
 *   - PUT    /order/:orderId            — 订单业务线标记 {businessLine: code | null}（字面路由先于 /:id）
 *   - GET    /order/:orderId/moq-check  — 订单 MOQ 软校验
 *   - PATCH  /:id                       — 更新业务线（code 不可改）
 *   - DELETE /:id                       — 软删（仍有订单引用时拒绝）
 *
 * 守卫口径与 seasons/risk 模块一致：读走 JWT 或 API-Key，写必须 JWT（requireJwtForWrite）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import type { TokenPayload } from '../auth/service';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { safeRouteError } from '../shared/routeError';
import { createBusinessLineService, BusinessLineInput } from './businessLineService';
import { BUSINESS_LINE_READ_SCOPES, currentBusinessLineActor } from './businessLineAccess';

export interface BusinessLineRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  apiKeyActors?: ReadonlyMap<string, TokenPayload>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createBusinessLineRouter(options: BusinessLineRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const service = createBusinessLineService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys, apiKeyActors: options.apiKeyActors }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'business-lines', action, ids });

  const handleError = (res: Response, e: unknown, operationLabel: string) => {
    logger.error('[BusinessLineRoute] operation failed', { operationLabel, error: e });
    const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: `${operationLabel}失败，请稍后重试。` });
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  };

  // Refresh before action guards: newly configured scopes work; withdrawn
  // scopes/old unmarked JWTs cannot reuse a stale default. Services repeat this
  // check in their read/write transaction to protect direct callers as well.
  router.use(async (req, res, next) => {
    try {
      (req as Request & { actor?: TokenPayload }).actor = await currentBusinessLineActor(prisma, (req as any).actor);
      next();
    } catch (error) { handleError(res, error, '核验业务线权限'); }
  });

  router.get('/', requirePermission([...BUSINESS_LINE_READ_SCOPES]), async (req: Request, res: Response) => {
    try {
      const result = await service.listBusinessLines({ includeInactive: req.query.includeInactive === 'true' }, (req as any).actor);
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, '读取业务线');
    }
  });

  router.post('/', requireWrite, requirePermission('dictionary:write'), async (req: Request, res: Response) => {
    try {
      const bl = await service.createBusinessLine(req.body as BusinessLineInput, (req as any).actor);
      notify('create_business_line', [bl.id]);
      res.status(201).json(serializeValue({ ok: true, item: bl }));
    } catch (e: any) {
      handleError(res, e, '创建业务线');
    }
  });

  // 字面路由 /order/:orderId 须在参数路由 /:id 前
  router.put('/order/:orderId', requireWrite, requirePermission('orders:write'), async (req: Request, res: Response) => {
    try {
      const order = await service.setOrderBusinessLine(req.params.orderId, req.body?.businessLine, (req as any).actor);
      notify('set_order_business_line', [req.params.orderId]);
      res.json(serializeValue({ ok: true, item: order }));
    } catch (e: any) {
      handleError(res, e, '设置订单业务线');
    }
  });

  router.get('/order/:orderId/moq-check', requirePermission('orders:read'), async (req: Request, res: Response) => {
    try {
      res.json(serializeValue(await service.checkOrderMoq(req.params.orderId, (req as any).actor)));
    } catch (e: any) {
      handleError(res, e, '校验订单 MOQ');
    }
  });

  router.patch('/:id', requireWrite, requirePermission('dictionary:write'), async (req: Request, res: Response) => {
    try {
      const bl = await service.updateBusinessLine(req.params.id, req.body ?? {}, (req as any).actor);
      notify('update_business_line', [bl.id]);
      res.json(serializeValue({ ok: true, item: bl }));
    } catch (e: any) {
      handleError(res, e, '修改业务线');
    }
  });

  router.delete('/:id', requireWrite, requirePermission('dictionary:write'), async (req: Request, res: Response) => {
    try {
      const result = await service.deleteBusinessLine(req.params.id, (req as any).actor);
      notify('delete_business_line', [req.params.id]);
      res.json({ ok: true, auditId: result.auditId });
    } catch (e: any) {
      handleError(res, e, '删除业务线');
    }
  });

  return router;
}
