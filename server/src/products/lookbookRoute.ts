/**
 * 阶段 P2 — 电子画册路由（PRD 6.2 P2 LookbookCatalog），挂载于 /api/v1/lookbooks
 *
 * 端点：
 *   - GET    /                  — 列表（?status=&limit=&offset=）
 *   - POST   /                  — 创建（Draft，空条目）
 *   - GET    /:id               — 详情（含条目快照，Web 预览数据源）
 *   - PATCH  /:id               — 更新标题/描述
 *   - PUT    /:id/items         — 整体替换条目（服务端从 ProductAsset 重取快照）
 *   - POST   /:id/publish       — 发布（须 ≥1 条目；幂等）
 *   - POST   /:id/unpublish     — 回退草稿
 *   - POST   /:id/archive       — 归档（幂等）
 *   - DELETE /:id               — 软删
 *
 * 服务端门禁（W-C 权限收口）：认证门之上叠加 scope 门——
 *   读端点 → requirePermission('products:read')（画册是产品档案衍生视图，复用产品域 scope）；
 *   写端点 → requireJwtForWrite + requirePermission('products:write')（JWT-only，API-Key 拒）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createLookbookService, LookbookInput, LookbookItemInput } from './lookbookService';

export interface LookbookRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createLookbookRouter(options: LookbookRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const lookbooks = createLookbookService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'lookbook', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[LookbookRoute] ${code}`, { error: msg });
    const isClient =
      msg.includes('必填') || msg.includes('非法') || msg.includes('不可') ||
      msg.includes('重复') || msg.includes('不可超过') || msg.includes('无条目');
    const isNotFound = msg.includes('不存在');
    res.status(isNotFound ? 404 : isClient ? 400 : 500).json({ error: { code, message: msg } });
  };

  router.get('/', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const result = await lookbooks.listLookbooks({
        status: req.query.status as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'LB_LIST_FAILED');
    }
  });

  router.post('/', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const row = await lookbooks.createLookbook(req.body as LookbookInput, actorIdFromRequest(req));
      notify('create_lookbook', [row.id]);
      res.status(201).json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_CREATE_FAILED');
    }
  });

  router.get('/:id', requirePermission('products:read'), async (req: Request, res: Response) => {
    try {
      const row = await lookbooks.getLookbook(req.params.id);
      res.json(serializeValue({ item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_GET_FAILED');
    }
  });

  router.patch('/:id', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const row = await lookbooks.updateLookbook(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      notify('update_lookbook', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_UPDATE_FAILED');
    }
  });

  router.put('/:id/items', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const items = (req.body?.items ?? req.body) as LookbookItemInput[];
      const row = await lookbooks.setLookbookItems(req.params.id, items, actorIdFromRequest(req));
      notify('set_lookbook_items', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_ITEMS_FAILED');
    }
  });

  router.post('/:id/publish', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const row = await lookbooks.publishLookbook(req.params.id, actorIdFromRequest(req));
      notify('publish_lookbook', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_PUBLISH_FAILED');
    }
  });

  router.post('/:id/unpublish', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const row = await lookbooks.unpublishLookbook(req.params.id, actorIdFromRequest(req));
      notify('unpublish_lookbook', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_UNPUBLISH_FAILED');
    }
  });

  router.post('/:id/archive', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      const row = await lookbooks.archiveLookbook(req.params.id, actorIdFromRequest(req));
      notify('archive_lookbook', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'LB_ARCHIVE_FAILED');
    }
  });

  router.delete('/:id', requireWrite, requirePermission('products:write'), async (req: Request, res: Response) => {
    try {
      await lookbooks.deleteLookbook(req.params.id, actorIdFromRequest(req));
      notify('delete_lookbook', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'LB_DELETE_FAILED');
    }
  });

  return router;
}
