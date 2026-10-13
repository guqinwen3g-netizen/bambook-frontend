import { hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';
import { exactJsonValue } from '../lib/exactJsonValue';
/**
 * releaseRoute.ts — DR-053 阶段 2：生产放行范围化 API（/api/v1/releases）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §14
 * 守卫（§14.5）：
 *  - 读 production:read；创建范围/请求 orders:write；
 *  - 签署 sample:pp_release:production_sign / business_sign（后端强制，前端不能指定他人）；
 *  - 暂停/撤销/恢复 sample:pp_release:admin。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import {
  createReleaseScope, rebindReleaseScope, createReleaseRequest, signReleaseRequest,
  rejectReleaseRequest, getReleaseRequestRejectionContext,
  evaluateProductionRelease, summarizeOrderReleases, transitionRelease,
  invalidateScopesBySample, listReleaseReconciliation, getReleaseRequestActionContext, knownReleaseFailure,
} from './releaseService';

export interface ReleaseRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createReleaseRouter(options: ReleaseRouterOptions): Router {
  const { prisma, requireAuth, onDataChange } = options;
  const apiKeys = options.apiKeys ?? new Set<string>();
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });

  const requireRead = requirePermission('production:read');
  const requireScopeWrite = [requireWrite, requirePermission('orders:write')];
  const requireProductionSign = [requireWrite, requirePermission('production:pp_release:production_sign')];
  const requireBusinessSign = [requireWrite, requirePermission('production:pp_release:business_sign')];
  const requireReleaseAdmin = [requireWrite, requirePermission('production:pp_release:admin')];

  const trustedActor = (req: Request): TokenPayload | null => (req as any).authSource === 'user-session' ? (req as any).actor ?? null : null;
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'releases', action, ids });
  const sendResult = (res: Response, r: { ok: true; data: any } | { ok: false; error: { code: string; message: string; status: number } }, status = 200) => {
    if (!r.ok) return res.status(r.error.status ?? 400).json({ ok: false, error: r.error });
    return res.status(status).json(exactJsonValue({ ok: true, ...r.data }));
  };

  // Minimal original-request context for an actual signer. This JWT-only
  // read does not require broad Order or production read privileges.
  router.get('/release-requests/:requestId/action-context', requireWrite, (req: Request, res: Response, next: any) => {
    const actor = trustedActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '请登录后查看原放行请求。', status: 401 } });
    const cap = hasScope(actor, 'production:pp_release:production_sign') ? 'production:pp_release:production_sign' : 'production:pp_release:business_sign';
    return requirePermission(cap)(req, res, next);
  }, async (req: Request, res: Response) => {
    sendResult(res, await getReleaseRequestActionContext({ prisma, requestId: req.params.requestId, trustedActor: trustedActor(req) }));
  });

  // The saved applicant rejection is readable only by its original requester,
  // with current Order read authority and the same live L2 parent scope.
  router.get('/release-requests/:requestId/rejection-context', requireWrite, requirePermission('orders:read'), async (req: Request, res: Response) => {
    sendResult(res, await getReleaseRequestRejectionContext({ prisma, requestId: req.params.requestId, trustedActor: trustedActor(req) }));
  });

  // 建范围（整行或实际批次）
  router.post('/orders/:orderId/lines/:lineId/release-scopes', ...requireScopeWrite, async (req: Request, res: Response) => {
    const r = await createReleaseScope({
      prisma, orderId: req.params.orderId, orderLineId: req.params.lineId,
      input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', trustedActor: trustedActor(req),
    });
    if (r.ok) notify('create_scope', [r.data.scope.id]);
    sendResult(res, r, 201);
  });

  // 显式续办既有实际批次范围；原批准保留，新修订须重新送审。
  router.post('/release-scopes/:scopeId/rebind', ...requireScopeWrite, async (req: Request, res: Response) => {
    const r = await rebindReleaseScope({ prisma, scopeId: req.params.scopeId, input: req.body ?? {},
      actorId: actorIdFromRequest(req) || '', trustedActor: trustedActor(req) });
    if (r.ok) notify('rebind_scope', [r.data.scope.id]);
    sendResult(res, r);
  });

  // 发起放行请求（固定审批输入）
  router.post('/release-scopes/:scopeId/requests', ...requireScopeWrite, async (req: Request, res: Response) => {
    const r = await createReleaseRequest({
      prisma, scopeId: req.params.scopeId, input: req.body ?? {}, actorId: actorIdFromRequest(req) || '', trustedActor: trustedActor(req),
    });
    if (r.ok) notify('create_request', [r.data.request.id]);
    sendResult(res, r, 201);
  });

  // 签署（role 由 body 指定；权限中间件按 role 分流——生产/业务签署独立 scope，前端不能代签）
  router.post('/release-requests/:requestId/signatures', requireWrite, async (req: Request, res: Response, next: any) => {
    if (!trustedActor(req)?.userId) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '请登录后核对并签署原放行申请。', status: 401 } });
    const role = String((req.body ?? {}).role ?? '');
    if (role === 'production') return requirePermission('production:pp_release:production_sign')(req, res, next);
    if (role === 'business') return requirePermission('production:pp_release:business_sign')(req, res, next);
    return res.status(400).json({ ok: false, error: { code: 'INVALID_ROLE', message: 'role 必须是 production|business' } });
  }, async (req: Request, res: Response) => {
    // P-7（§10.4.1）：签谁就是谁——actorName 不再取 body（可代填），一律取当前登录主体。
    const r = await signReleaseRequest({
      prisma, requestId: req.params.requestId, role: String((req.body ?? {}).role ?? ''),
      actorId: actorIdFromRequest(req) || '', trustedActor: trustedActor(req),
      actorName: (req as any).actor?.displayName || (req as any).actor?.userId || '',
      confirmedReviewedContent: (req.body ?? {}).confirmedReviewedContent,
      expectedRequestRevision: (req.body ?? {}).expectedRequestRevision,
      expectedScopeRevision: (req.body ?? {}).expectedScopeRevision,
      reviewContentFingerprint: (req.body ?? {}).reviewContentFingerprint,
    });
    if (r.ok) notify('sign_release', r.data.release ? [r.data.release.id] : [req.params.requestId]);
    sendResult(res, r);
  });

  // Request-level rejection is separate from signatures and never changes
  // ReleaseScope state or grants/revokes production authority.
  router.post('/release-requests/:requestId/reject', requireWrite, async (req: Request, res: Response, next: any) => {
    if (!trustedActor(req)?.userId) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '请登录后核对并驳回原放行申请。', status: 401 } });
    const role = String((req.body ?? {}).role ?? '');
    if (role === 'production') return requirePermission('production:pp_release:production_sign')(req, res, next);
    if (role === 'business') return requirePermission('production:pp_release:business_sign')(req, res, next);
    return res.status(400).json({ ok: false, error: { code: 'INVALID_ROLE', message: 'role 必须是 production|business' } });
  }, async (req: Request, res: Response) => {
    const r = await rejectReleaseRequest({
      prisma, requestId: req.params.requestId, role: String((req.body ?? {}).role ?? ''),
      actorId: actorIdFromRequest(req) || '', trustedActor: trustedActor(req),
      rejectionReason: (req.body ?? {}).rejectionReason, requestedChanges: (req.body ?? {}).requestedChanges,
      confirmedReviewedContent: (req.body ?? {}).confirmedReviewedContent,
      expectedRequestRevision: (req.body ?? {}).expectedRequestRevision,
      expectedScopeRevision: (req.body ?? {}).expectedScopeRevision,
      reviewContentFingerprint: (req.body ?? {}).reviewContentFingerprint,
    });
    if (r.ok) notify('reject_request', [req.params.requestId]);
    sendResult(res, r);
  });

  // 暂停 / 恢复 / 撤销（SM 级）
  router.post('/release-scopes/:scopeId/:action', ...requireReleaseAdmin, async (req: Request, res: Response) => {
    const action = req.params.action;
    if (!['pause', 'resume', 'revoke'].includes(action)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_ACTION', message: 'action 必须是 pause|resume|revoke' } });
    }
    const r = await transitionRelease({
      prisma, scopeId: req.params.scopeId, action: action as 'pause' | 'resume' | 'revoke',
      reason: (req.body ?? {}).reason, expectedScopeRevision: (req.body ?? {}).expectedScopeRevision,
      actorId: actorIdFromRequest(req) || '', trustedActor: trustedActor(req),
    });
    if (r.ok) notify(`release_${action}`, [req.params.scopeId]);
    sendResult(res, r);
  });

  // 订单放行汇总（ready/partial/blocked + 各范围）
  router.get('/orders/:orderId/releases', requireRead, async (req: Request, res: Response) => {
    try {
      const r = await summarizeOrderReleases({ prisma, orderId: req.params.orderId });
      if (!r.ok) return sendResult(res, r);
      const scopes = [...r.data.scopes].sort((a: any, b: any) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
      // §10.7 P-3：附带 pending 放行请求（面板"领导签字放行"按钮定位 requestId 用）
      const scopeIds = scopes.map((sc: any) => sc.id);
      const pendingRequests = scopeIds.length
        ? await (prisma as any).releaseRequest.findMany({ where: { scopeId: { in: scopeIds }, state: 'pending' }, select: { id: true, scopeId: true, state: true, createdBy: true } })
        : [];
      return res.json(exactJsonValue({ ok: true, ...r.data, scopes, pendingRequests }));
    } catch (error) {
      logger.error('[Release] Order release read failed', { orderId: req.params.orderId, error });
      const known = knownReleaseFailure(error); if (known) return sendResult(res, known);
      const failure = safeRouteError(new Error(), { fallbackCode: 'INTERNAL_ERROR',
        fallbackMessage: '放行数据暂时无法核验，请稍后重试；本次读取未改变原批准或申请。' });
      return res.status(failure.status).json({ ok: false, error: { code: failure.code, message: failure.message, status: failure.status } });
    }
  });

  // 范围资格预检（只读；实际生产命令提交时再次检查）
  router.get('/release-scopes/:scopeId/eligibility', requireRead, async (req: Request, res: Response) => {
    const r = await evaluateProductionRelease({ prisma, scopeId: req.params.scopeId });
    sendResult(res, r);
  });

  // 服务端点：样品返修/证据失效 → invalidate 关联 scope（供样品域命令调用）
  // [B4 零散收敛 2026-09-15] ⚠️ route 层前端与 Agent 均零消费：样品域实际走**进程内 service 直调**
  // （samples/sampleManageService.ts 直接 import invalidateScopesBySample），注释所称"供样品域命令调用"
  // 实为 service 调用而非 HTTP。⚠️ service invalidateScopesBySample **被样品域依赖，不可删**；
  // route 保留待业务方定夺是否下线（便于外部调用方走 HTTP）。
  router.post('/invalidate-by-sample', ...requireReleaseAdmin, async (req: Request, res: Response) => {
    const r = await invalidateScopesBySample({
      prisma, sampleId: String((req.body ?? {}).sampleId ?? ''),
      reason: (req.body ?? {}).reason, sourceKey: (req.body ?? {}).sourceKey, actorId: actorIdFromRequest(req) || '',
    });
    if (r.ok) notify('invalidate_by_sample', []);
    sendResult(res, r);
  });

  // DR-053 §14.6 影子对账：列出受影响在制订单（历史双签补证 + 放行差异），只读
  router.get('/reconciliation', requireRead, async (req: Request, res: Response) => {
    const r = await listReleaseReconciliation({ prisma, limit: Number((req.query ?? {}).limit) || 50, offset: Number((req.query ?? {}).offset) || 0 });
    sendResult(res, r);
  });

  return router;
}
