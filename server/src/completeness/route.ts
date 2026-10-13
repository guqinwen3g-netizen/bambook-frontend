/**
 * completenessRoute.ts — 资料完备度规则引擎 v1 API（route.ts）
 * 挂载点：/api/completeness（server/src/index.ts，对齐既有 module auth guard 模式）
 *
 * 端点（全部只读、纯实时查询、零写库）：
 *   GET /summary  — 七规则全量聚合 { totalGaps, bySeverity, groups[] }
 *   GET /entity   — 单实体缺口明细 ?type=order|development-case|product|relation&id=xxx
 *                   （score 0-100 仅 product/relation 返回）
 *   GET /batch    — 列表页徽标 ?type=product|relation（updatedAt 倒序，≤200）
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard } from '../auth/moduleGuard';
import {
  getCompletenessSummary,
  getCompletenessBatch,
  getEntityCompleteness,
  CompletenessEntityType,
} from './service';

const ENTITY_TYPES = new Set<string>(['order', 'development-case', 'product', 'relation']);
const BATCH_TYPES = new Set<string>(['product', 'relation']);

export interface CompletenessRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createCompletenessRouter(options: CompletenessRouterOptions): Router {
  const { prisma, requireAuth, apiKeys } = options;
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));

  const fail = (res: Response, status: number, code: string, message: string) => {
    res.status(status).json({ ok: false, error: { code, message } });
  };

  // GET /api/completeness/summary
  router.get('/summary', async (_req: Request, res: Response) => {
    try {
      const data = await getCompletenessSummary(prisma);
      res.json({ ok: true, data });
    } catch (err: any) {
      fail(res, 500, 'COMPLETENESS_FAILED', String(err?.message ?? err));
    }
  });

  // GET /api/completeness/entity?type=&id=
  router.get('/entity', async (req: Request, res: Response) => {
    try {
      const type = String(req.query.type || '');
      const id = String(req.query.id || '').trim();
      if (!ENTITY_TYPES.has(type)) {
        return fail(res, 400, 'INVALID_TYPE', 'type 必须是: order | development-case | product | relation');
      }
      if (!id) {
        return fail(res, 400, 'MISSING_ID', 'id 必填');
      }
      const data = await getEntityCompleteness(prisma, type as CompletenessEntityType, id);
      if (!data) {
        return fail(res, 404, 'ENTITY_NOT_FOUND', `${type} ${id} 不存在`);
      }
      return res.json({ ok: true, data });
    } catch (err: any) {
      return fail(res, 500, 'COMPLETENESS_FAILED', String(err?.message ?? err));
    }
  });

  // GET /api/completeness/batch?type=
  router.get('/batch', async (req: Request, res: Response) => {
    try {
      const type = String(req.query.type || '');
      if (!BATCH_TYPES.has(type)) {
        return fail(res, 400, 'INVALID_TYPE', 'type 必须是: product | relation');
      }
      const data = await getCompletenessBatch(prisma, type as 'product' | 'relation');
      return res.json({ ok: true, data });
    } catch (err: any) {
      return fail(res, 500, 'COMPLETENESS_FAILED', String(err?.message ?? err));
    }
  });

  return router;
}
