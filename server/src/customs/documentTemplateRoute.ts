/**
 * 阶段 P3a — 单据模板路由（PRD 11.3 DocumentTemplate），挂载于 /api/v1/document-templates
 *
 * 端点：
 *   - GET    /          — 模板列表（?type=&language=&includeInactive=）
 *   - POST   /          — 新建模板（variables 自动从 content 解析）
 *   - GET    /:id       — 模板详情
 *   - PATCH  /:id       — 更新模板（改 content 时重解析变量；isDefault 事务内唯一）
 *   - DELETE /:id       — 软删除
 *
 * 守卫口径与 customs 模块一致：读走 JWT 或 API-Key，写必须 JWT（requireJwtForWrite）。
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import {
  createDocumentTemplateService,
  DocumentTemplateInput,
  DocumentTemplatePatch,
} from './documentTemplateService';

export interface DocumentTemplateRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createDocumentTemplateRouter(options: DocumentTemplateRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const templates = createDocumentTemplateService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'documentTemplate', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[DocumentTemplateRoute] ${code}`, { error: msg });
    const isNotFound = msg.includes('不存在');
    const isClient = msg.includes('必填') || msg.includes('非法') || msg.includes('不可为空');
    res.status(isNotFound ? 404 : isClient ? 400 : 500).json({ error: { code, message: msg } });
  };

  router.get('/', async (req: Request, res: Response) => {
    try {
      const result = await templates.listTemplates({
        type: req.query.type as string | undefined,
        language: req.query.language as string | undefined,
        includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
      });
      res.json(serializeValue(result));
    } catch (e: any) {
      handleError(res, e, 'DT_LIST_FAILED');
    }
  });

  router.post('/', requireWrite, async (req: Request, res: Response) => {
    try {
      const row = await templates.createTemplate(req.body as DocumentTemplateInput, actorIdFromRequest(req));
      notify('create_document_template', [row.id]);
      res.status(201).json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'DT_CREATE_FAILED');
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const row = await templates.getTemplate(req.params.id);
      res.json(serializeValue({ item: row }));
    } catch (e: any) {
      handleError(res, e, 'DT_GET_FAILED');
    }
  });

  router.patch('/:id', requireWrite, async (req: Request, res: Response) => {
    try {
      const row = await templates.updateTemplate(req.params.id, (req.body ?? {}) as DocumentTemplatePatch, actorIdFromRequest(req));
      notify('update_document_template', [row.id]);
      res.json(serializeValue({ ok: true, item: row }));
    } catch (e: any) {
      handleError(res, e, 'DT_UPDATE_FAILED');
    }
  });

  router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
    try {
      await templates.deleteTemplate(req.params.id, actorIdFromRequest(req));
      notify('delete_document_template', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'DT_DELETE_FAILED');
    }
  });

  return router;
}
