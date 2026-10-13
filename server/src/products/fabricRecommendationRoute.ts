/**
 * 阶段 P2 — 面料推荐路由（PRD 6.2 P2 FabricRecommendation），挂载于 /api/v1/fabric-recommendations
 *
 * 端点：
 *   - POST   /recommend  — 执行推荐（确定性打分，结果落库）
 *   - GET    /           — 历史列表（?limit=&offset=）
 *   - GET    /:id        — 详情（criteria + results 快照）
 *   - DELETE /:id        — 软删
 *
 * 服务端门禁（W-C 权限收口）：认证门之上叠加 scope 门——
 *   读端点 → requirePermission('products:read')（推荐结果是产品档案衍生数据，复用产品域 scope）；
 *   写端点（recommend 落库 / 软删）→ requireJwtForWrite + requirePermission('products:write')（JWT-only，API-Key 拒）。
 * 商业价格来源/单位/历史核验 DTO 由同一 service 处理；读权限或 owner
 * 身份均不能把旧匿名采购价快照当成可信客户售价展示。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createFabricRecommendationService, RecommendCriteria } from './fabricRecommendationService';

export interface FabricRecommendationRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createFabricRecommendationRouter(options: FabricRecommendationRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const service = createFabricRecommendationService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'fabricRecommendation', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[FabricRecommendationRoute] ${code}`, { error: msg });
    const isClient = msg.includes('必填') || msg.includes('非法') || msg.includes('至少') || msg.includes('不可大于');
    const isNotFound = msg.includes('不存在');
    res.status(isNotFound ? 404 : isClient ? 400 : 500).json({ error: { code, message: msg } });
  };

  router.post('/recommend', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const row = await service.recommend(req.body as RecommendCriteria, actorIdFromRequest(req));
      notify('create_fabric_recommendation', [row.id]);
      res.status(201).json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'FR_RECOMMEND_FAILED');
    }
  });

  router.get('/', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const result = await service.listRecommendations({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'FR_LIST_FAILED');
    }
  });

  router.get('/:id', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const row = await service.getRecommendation(req.params.id);
      res.json(serializeValue({ item: row }));
    } catch (e: any) {
      handleError(res, e, 'FR_GET_FAILED');
    }
  });

  router.delete('/:id', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      await service.deleteRecommendation(req.params.id, actorIdFromRequest(req));
      notify('delete_fabric_recommendation', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'FR_DELETE_FAILED');
    }
  });

  return router;
}
