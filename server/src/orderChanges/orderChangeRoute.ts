/**
 * orderChangeRoute.ts — DR-010 订单变更/取消/暂停 API
 *
 * 挂载：createOrderChangeRouter({ prisma, requireAuth })
 * 路径：/api/v1/order-changes（由主代理在 index.ts 收口）
 *
 * 端点：
 *   POST /              — 创建变更申请（scope order:change_request:create）
 *   GET  /              — 列表（按 orderId / status / requesterId 过滤）
 *   GET  /:id           — 详情
 *   POST /:id/apply     — 审批通过后生效（scope order:change_request:apply）
 *   POST /:id/withdraw  — 申请人撤回（仅 Pending）
 *
 * 鉴权：JWT fail-closed（无 token 401，无 scope 403）
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import {signedQuantityPlanActor} from './quantityPlanCredential';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import {
  createOrderChangeRequestService,
  ORDER_CHANGE_TYPES,
  type OrderChangeType,
} from './orderChangeRequestService';
import { logger } from '../lib/logger';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';
import { createOrderQuantityPlanPreviewService } from './orderQuantityPlanPreviewService';
import { currentCustomerConfirmationActor } from '../customerConfirmations/customerConfirmationService';
import { createOrderChangeCustomerConfirmationAdapter } from './orderChangeCustomerConfirmationAdapter';
import { assertOrderChangeReadResponse } from './orderChangeReadAccess';

export interface OrderChangeRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
}

export function createOrderChangeRouter(options: OrderChangeRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth } = options;

  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });
  const changeService = createOrderChangeRequestService({ prisma, approvalCreateService });
  const customerConfirmationAdapter = createOrderChangeCustomerConfirmationAdapter({ prisma, service: changeService });
  const quantityPlanPreviewService = createOrderQuantityPlanPreviewService(prisma);

  // ── 鉴权：JWT fail-closed ──
  const authenticate = (req: Request, res: Response): { userId: string; roles: string[] } | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
      return null;
    }
    (req as any).actor = actor; // 供 hasScopeOnRequest 使用（permissionGuard 从 req.actor 取权限）
    return { userId: actor.userId, roles: actor.roles ?? [] };
  };

  const requireScope = (req: Request, res: Response, scope: string): boolean => {
    if (!requireAuth) return true;
    if (!hasScopeOnRequest(req, scope as any)) {
      res.status(403).json({ error: 'FORBIDDEN', message: `INSUFFICIENT_SCOPE: ${scope}` });
      return false;
    }
    return true;
  };

  // ══════════════════════════════════════════════════════════════════
  // POST / — 创建变更申请
  // ══════════════════════════════════════════════════════════════════
  router.post('/', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'order:change_request:create')) return;

    try {
      const body = req.body || {};
      const changeTypeRaw = String(body.changeType ?? '').trim() as OrderChangeType;
      if (!ORDER_CHANGE_TYPES.includes(changeTypeRaw)) {
        return res.status(400).json({ error: 'INVALID_CHANGE_TYPE', message: `非法变更类型: ${changeTypeRaw}` });
      }

      const result = await changeService.createChangeRequest({
        orderId: String(body.orderId ?? '').trim(),
        changeType: changeTypeRaw,
        beforeSnapshot: body.beforeSnapshot ?? {},
        afterDelta: body.afterDelta ?? {},
        changeReason: String(body.changeReason ?? '').trim(),
        impactSummary: String(body.impactSummary ?? '').trim(),
        requesterId: auth.userId,
        trustedActor:changeTypeRaw==='quantity'?signedQuantityPlanActor(req):extractActorFromRequest(req)??undefined,
        pauseReason: body.pauseReason ? String(body.pauseReason).trim() : undefined,
        pauseOwnerId: body.pauseOwnerId ? String(body.pauseOwnerId).trim() : undefined,
        expectedResumeDate: body.expectedResumeDate ? String(body.expectedResumeDate).trim() : undefined,
        attachments: body.attachments,
      });

      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.status(201).json(result.data);
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST / failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '创建变更申请失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // Read-only full-line quantity and MOQ preview. It must never create a snapshot,
  // approval, audit, or business row; the later change-request command revalidates.
  router.post('/quantity-preview', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'order:change_request:create')) return;
    try {
      const actor = signedQuantityPlanActor(req);
      const result = await quantityPlanPreviewService.preview(actor, req.body?.lineQuantityPlan);
      return res.json({ ok: true, result });
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST /quantity-preview failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '数量与 MOQ 预检失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET / — 列表（支持 orderId / status / requesterId 过滤）
  // ══════════════════════════════════════════════════════════════════
  router.get('/', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const { items } = await changeService.listChangeRequests({
        orderId: req.query.orderId ? String(req.query.orderId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        requesterId: req.query.requesterId ? String(req.query.requesterId) : undefined,
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        trustedActor: extractActorFromRequest(req),
      });
      return res.json({ items });
    } catch (e: any) {
      logger.error('[OrderChangeRoute] GET / failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '查询变更申请列表失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /:id — 详情
  // ══════════════════════════════════════════════════════════════════
  router.get('/:id', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const { item } = await changeService.getChangeRequest(req.params.id, extractActorFromRequest(req));
      if (!item || item.deletedAt) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `变更申请 ${req.params.id} 不存在` });
      }
      let customerConfirmationTarget: any = null;
      if ((item.changeTypes ?? []).some((type: string) => ['unitPrice', 'quantity', 'deliveryDate'].includes(type))) {
        try {
          customerConfirmationTarget = await prisma.$transaction(async (tx: any) => {
            const actor = await currentCustomerConfirmationActor(tx, extractActorFromRequest(req), 'orders:read');
            const snapshot = await customerConfirmationAdapter.inspect(tx, item.id, actor, 'read');
            return { targetType: 'OrderChangeRequest', targetId: item.id, ...snapshot,
              recommendation: { orderId: item.orderId, relationId: item.order?.customerRelationId ?? undefined,
                subject: item.requestNumber } };
          });
        } catch {
          // Keep the ordinary change detail available when this viewer lacks customer-evidence read scope.
          // The core confirmation endpoint independently rechecks current read/write access before any write.
        }
      }
      await assertOrderChangeReadResponse(prisma, item, extractActorFromRequest(req));
      return res.json({ item: { ...item, customerConfirmationTarget } });
    } catch (e: any) {
      logger.error('[OrderChangeRoute] GET /:id failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '查询变更申请详情失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // Rejected requests are immutable. Only the original requester can create a fresh successor;
  // the service locks/rechecks the source, reruns the order gates and resolves DR-007 anew.
  router.post('/:id/revise', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'order:change_request:create')) return;
    try {
      const body = req.body ?? {};
      if (!body.afterDelta || typeof body.afterDelta !== 'object' || Array.isArray(body.afterDelta))
        return res.status(400).json({ error: 'INVALID_INPUT', message: '修订必须提交明确的变更后内容。' });
      const result = await changeService.reviseRejectedChangeRequest({ changeRequestId: req.params.id,
        trustedActor: signedQuantityPlanActor(req), afterDelta: body.afterDelta,
        changeReason: typeof body.changeReason === 'string' ? body.changeReason : '',
        impactSummary: typeof body.impactSummary === 'string' ? body.impactSummary : '' });
      if (!result.ok) return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      return res.status(201).json(result.data);
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST /:id/revise failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '修订被驳回的订单变更失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // Read-only reviewer amendment preview. The expected fingerprint is recomputed again
  // under the apply transaction; this endpoint never creates approvals or changes business rows.
  router.post('/:id/amend-preview', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'order:change_request:apply')) return;
    try {
      const body = req.body ?? {};
      if (!body.afterDelta || typeof body.afterDelta !== 'object' || Array.isArray(body.afterDelta))
        return res.status(400).json({ error: 'INVALID_INPUT', message: '预览必须提交明确的最终变更内容。' });
      const result = await changeService.previewChangeRequestAmendment({ changeRequestId: req.params.id,
        trustedActor: signedQuantityPlanActor(req),
        expectedApprovalReviewVersion: typeof body.reviewContentVersion === 'string' ? body.reviewContentVersion : '',
        afterDelta: body.afterDelta,
        changeReason: typeof body.changeReason === 'string' ? body.changeReason : '',
        impactSummary: typeof body.impactSummary === 'string' ? body.impactSummary : '' });
      if (!result.ok) return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST /:id/amend-preview failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '最终变更内容预览失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // Reviewer amendment is one atomic domain command: new immutable CR + fresh DR-007 approval,
  // kernel-signed final version, and cancellation/audit link for the old pending pair.
  router.post('/:id/amend-and-approve', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'order:change_request:apply')) return;
    try {
      const body = req.body ?? {};
      if (!body.afterDelta || typeof body.afterDelta !== 'object' || Array.isArray(body.afterDelta))
        return res.status(400).json({ error: 'INVALID_INPUT', message: '修改并批准必须提交明确的最终变更内容。' });
      const result = await changeService.amendAndApproveChangeRequest({ changeRequestId: req.params.id,
        trustedActor: extractActorFromRequest(req) ?? undefined,
        expectedApprovalReviewVersion: typeof body.reviewContentVersion === 'string' ? body.reviewContentVersion : '',
        expectedFinalProposalFingerprint: typeof body.expectedFinalProposalFingerprint === 'string' ? body.expectedFinalProposalFingerprint : '',
        confirmedReviewedContent: body.confirmedReviewedContent === true,
        afterDelta: body.afterDelta,
        changeReason: typeof body.changeReason === 'string' ? body.changeReason : '',
        impactSummary: typeof body.impactSummary === 'string' ? body.impactSummary : '',
        decisionNote: typeof body.decisionNote === 'string' ? body.decisionNote : undefined });
      if (!result.ok) return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST /:id/amend-and-approve failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '订单变更修改并批准失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/apply — 审批通过后生效（幂等）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:id/apply', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'order:change_request:apply')) return;

    try {
      const result = await changeService.applyChangeRequest({
        changeRequestId: req.params.id,
        appliedBy: auth.userId,
        trustedActor:signedQuantityPlanActor(req),
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message, ...(result.error.approvalRequestId ? {approvalRequestId:result.error.approvalRequestId} : {}) });
      }
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST /:id/apply failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '变更生效失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/withdraw — 申请人撤回（仅 Pending）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:id/withdraw', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    // O-1（§10.7）：撤回此前零权限校验。权限点复用 create（能提申请就能申请撤回），
    // 「能撤谁的」由服务层按归属判定：本人或领导/老板（§10.4.1）。
    if (!requireScope(req, res, 'order:change_request:create')) return;
    try {
      const result = await changeService.withdrawChangeRequest({
        changeRequestId: req.params.id,
        actorId: auth.userId,
        actorRoles: auth.roles,
        trustedActor: extractActorFromRequest(req) ?? undefined,
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[OrderChangeRoute] POST /:id/withdraw failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '撤回变更申请失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}
