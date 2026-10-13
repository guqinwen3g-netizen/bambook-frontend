/**
 * C7 知识库深化：知识域统一路由（SOP 模板 CRUD + 实例化；知识关联只读）。
 * 挂载点：/api/v1/knowledge（见 index.ts）。
 *
 * 服务端门禁（W-C 权限收口）：认证门之上叠加 scope 门——
 *   读端点 → requirePermission('knowledge:read')；
 *   写端点（模板创建/更新/删除/实例化）→ requirePermission('knowledge:write')
 *   （:write 后缀 scope 由 permissionGuard 强制 JWT user-session，API-Key 拒）。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import {
  listSopTemplates,
  createSopTemplate,
  updateSopTemplate,
  deleteSopTemplate,
  instantiateSopTemplate,
} from './sopTemplateService';
import {
  listDocumentRelations,
  listEntityKnowledgeRelations,
  listEntityLinks,
} from './knowledgeGraphService';

type KnowledgeRouterOptions = {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
};

const ERROR_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ARCHIVED: 409,
  AUDIT_FAILED: 500,
  CREATE_FAILED: 500,
  UPDATE_FAILED: 500,
  DELETE_FAILED: 500,
  INSTANTIATE_FAILED: 500,
};

export function createKnowledgeRouter(options: KnowledgeRouterOptions) {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: options.requireAuth, apiKeys: options.apiKeys }));

  // ─── SOP 模板 ───

  router.get('/sop-templates', requirePermission('knowledge:read'), async (req: Request, res: Response) => {
    const items = await listSopTemplates(options.prisma, {
      category: req.query.category ? String(req.query.category) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
    });
    res.json({ ok: true, items });
  });

  router.post('/sop-templates', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const outcome = await createSopTemplate({
      prisma: options.prisma,
      input: {
        title: req.body?.title != null ? String(req.body.title) : undefined,
        category: req.body?.category != null ? String(req.body.category) : undefined,
        summary: req.body?.summary != null ? String(req.body.summary) : undefined,
        content: req.body?.content != null ? String(req.body.content) : undefined,
        steps: Array.isArray(req.body?.steps) ? req.body.steps : undefined,
        status: req.body?.status != null ? String(req.body.status) : undefined,
      },
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!outcome.ok) {
      return res.status(ERROR_STATUS[outcome.error.code] || 500).json({ ok: false, error: outcome.error.code, message: outcome.error.message });
    }
    options.onDataChange?.({ entity: 'sop-template', action: 'create', ids: [outcome.result.id] });
    res.status(201).json({ ok: true, item: outcome.result });
  });

  router.patch('/sop-templates/:id', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const outcome = await updateSopTemplate({
      prisma: options.prisma,
      id: String(req.params.id || ''),
      input: {
        title: req.body?.title != null ? String(req.body.title) : undefined,
        category: req.body?.category != null ? String(req.body.category) : undefined,
        summary: req.body?.summary !== undefined ? (req.body.summary == null ? null : String(req.body.summary)) : undefined,
        content: req.body?.content != null ? String(req.body.content) : undefined,
        steps: Array.isArray(req.body?.steps) ? req.body.steps : undefined,
        status: req.body?.status != null ? String(req.body.status) : undefined,
      },
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!outcome.ok) {
      return res.status(ERROR_STATUS[outcome.error.code] || 500).json({ ok: false, error: outcome.error.code, message: outcome.error.message });
    }
    options.onDataChange?.({ entity: 'sop-template', action: 'update', ids: [outcome.result.id] });
    res.json({ ok: true, item: outcome.result });
  });

  router.delete('/sop-templates/:id', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const outcome = await deleteSopTemplate({
      prisma: options.prisma,
      id: String(req.params.id || ''),
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!outcome.ok) {
      return res.status(ERROR_STATUS[outcome.error.code] || 500).json({ ok: false, error: outcome.error.code, message: outcome.error.message });
    }
    options.onDataChange?.({ entity: 'sop-template', action: 'delete', ids: [outcome.result.id] });
    res.json({ ok: true, id: outcome.result.id });
  });

  // 实例化：模板 → 知识文档（复用 ingest 管线，sourceType='sop'）
  router.post('/sop-templates/:id/instantiate', requirePermission('knowledge:write'), async (req: Request, res: Response) => {
    const outcome = await instantiateSopTemplate({
      prisma: options.prisma,
      id: String(req.params.id || ''),
      actorId: actorIdFromRequest(req),
      ip: req.ip,
    });
    if (!outcome.ok) {
      return res.status(ERROR_STATUS[outcome.error.code] || 500).json({ ok: false, error: outcome.error.code, message: outcome.error.message });
    }
    options.onDataChange?.({ entity: 'knowledge-document', action: 'ingest', ids: [outcome.result.documentId] });
    res.status(201).json({ ok: true, ...outcome.result });
  });

  // ─── 知识关联（只读） ───

  router.get('/graph/document/:docId/relations', requirePermission('knowledge:read'), async (req: Request, res: Response) => {
    const items = await listDocumentRelations(options.prisma, String(req.params.docId || ''));
    res.json({ ok: true, items });
  });

  router.get('/graph/entity/:targetType/:targetId/relations', requirePermission('knowledge:read'), async (req: Request, res: Response) => {
    const targetType = String(req.params.targetType || '');
    const targetId = String(req.params.targetId || '');
    const [knowledge, entityLinks] = await Promise.all([
      listEntityKnowledgeRelations(options.prisma, targetType, targetId),
      listEntityLinks(options.prisma, targetType, targetId),
    ]);
    res.json({ ok: true, knowledge, entityLinks });
  });

  return router;
}
