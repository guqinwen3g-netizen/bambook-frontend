/**
 * route.ts — REQ2-13 业务员离职一键交接路由（DR-056）
 *
 * 挂载点：/api/v2/handover
 *
 * 路由表：
 *   GET  /preview   — 预览（只读零写路径）：离职者五类资产计数 + 警示
 *   POST /          — 执行交接（单事务原子）+ 可选停用 + 交接单/双审计留痕
 *   GET  /records   — 交接单历史（倒序，管理员审计视角）
 *
 * 门禁：requirePermission('users:admin')——与用户删除/权限矩阵同级高危 scope
 *（交接含账号停用 + 全量客户资产归属改写，仅 SuperAdmin 执行）。
 * 设计真源：docs/design/04-模块设计/02-客户与开拓/业务员离职一键交接.md §5
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { createHandoverService } from './handoverService';

export interface HandoverRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createHandoverRouter(opts: HandoverRouterOptions): Router {
  const router = Router();

  // 上游 auth guard（JWT cookie/Bearer 或 API-key）
  const guard = createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  router.use(guard);

  // 写操作需要 JWT（API key 通道不足以执行交接）
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });

  const svc = createHandoverService(opts.prisma);

  function actorOf(req: Request) {
    return extractActorFromRequest(req);
  }

  const statusOf = (code: string): number =>
    ({ VALIDATION_FAILED: 400, NOT_FOUND: 404, SAME_USER: 400, INACTIVE_SUCCESSOR: 400, INTERNAL_ERROR: 500 } as Record<string, number>)[code] || 500;

  // ── GET /preview 预览 ──
  router.get('/preview', requirePermission('users:admin'), async (req, res) => {
    const result = await svc.preview({
      fromUserId: typeof req.query.fromUserId === 'string' ? req.query.fromUserId : undefined,
      toUserId: typeof req.query.toUserId === 'string' ? req.query.toUserId : undefined,
    });
    if (!result.ok) return res.status(statusOf(result.error.code)).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── POST / 执行交接 ──
  router.post('/', requireWrite, requirePermission('users:admin'), async (req, res) => {
    const actor = actorOf(req);
    const body = req.body || {};
    const result = await svc.execute(
      {
        fromUserId: typeof body.fromUserId === 'string' ? body.fromUserId : undefined,
        toUserId: typeof body.toUserId === 'string' ? body.toUserId : undefined,
        disableAccount: body.disableAccount,
        note: typeof body.note === 'string' ? body.note : undefined,
      },
      actor?.userId || 'system',
      req.ip,
    );
    if (!result.ok) return res.status(statusOf(result.error.code)).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /records 交接单历史 ──
  router.get('/records', requirePermission('users:admin'), async (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const result = await svc.listRecords(Number.isFinite(limitRaw) ? limitRaw : undefined);
    if (!result.ok) return res.status(statusOf(result.error.code)).json({ error: result.error.code, message: result.error.message });
    return res.json({ ok: true, ...result.data });
  });

  return router;
}
