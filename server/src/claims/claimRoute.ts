/**
 * claimRoute.ts — 售后索赔路由（口径 A1/A2/A3/A5/A7）
 *
 * ── 权限码（本模块**首次真正消费** `aftersales:*` 三码）──────────
 *   `aftersales:read`    读案件/退款单
 *   `aftersales:write`   登记案件 / 加处置 / 核销 / 作废
 *   `aftersales:approve` 审批处置 —— ⚠️ 按口径 **B1** 它只是 **UI 能力标签**（非强制门禁），
 *                        审批**主体**由 `approvals/` 内核按策略解析（本路由不判"谁能批"）
 *
 * ★ 这三个码此前一直登记在「悬空豁免表」里、`reason='module-absent'`（模块未建）。
 *   本路由落地后**必须把它们从豁免表移除** —— 守卫里有专项断言钉着（届时会红，正是设计意图）。
 */

import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import {
  addDisposition,
  approveDisposition,
  cancelClaimCase,
  createClaimCase,
  getClaimCase,
  listClaimCases,
} from './claimCaseService';
import { executeDisposition } from './claimSettlement';
import { resubmitClaimApproval } from './claimReapprovalService';
import { receiveClaimReturn, scrapClaimReturn } from './claimReturnFulfillmentService';
import { startClaimRepair, completeClaimRepair, recordClaimRepairInspection } from './claimRepairFulfillmentService';
import { createClaimRepairReturnShipment, bindClaimShipmentStock, getClaimShipmentStockBinding } from './claimShipmentFulfillmentService';
import { getReturnReceipt } from './returnReceiptService';
import { getRepairWorkOrder } from './repairWorkOrderService';
import { applyCreditNote, cancelCreditNote, listOpenCreditNotes } from './creditNoteService';
import { getClaimCreditNote, getCreditNoteVersions, issueClaimCreditNoteVersion } from './claimCreditNoteVersionService';
// ★ C7：尾差销账（对发票未结额开 CN 并立即抵扣；复用 A3 内核，不重复实现状态机）
import { writeOffInvoiceTail, WRITE_OFF_REASON_MIN } from '../finance/writeOffService';
import { logger } from '../lib/logger';
import { httpStatusOfCode } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { buildClaimApprovalPayload, CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET, ClaimTransactionError, requireClaimResult } from './claimApprovalFact';
import type { TokenPayload } from '../auth/service';
import { ClaimVisibilityError, createClaimVisibility } from './claimVisibility';

export interface ClaimRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
}

/** 服务层错误码 → HTTP 状态 */
function httpStatusOf(code: string | undefined): number {
  return code ? httpStatusOfCode(code) : 500;
}

export function createClaimRouter(options: ClaimRouterOptions): Router {
  const router = Router();
  const { prisma } = options;

  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });

  const authenticate = (req: Request, res: Response): TokenPayload | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
      return null;
    }
    (req as any).actor = actor; // 供 hasScopeOnRequest 使用
    return actor;
  };

  const requireScope = (req: Request, res: Response, scope: string): boolean => {
    if (hasScopeOnRequest(req, scope as any)) return true;
    res.status(403).json({ error: 'FORBIDDEN', message: `需要权限 ${scope}` });
    return false;
  };

  /**
   * 审计留痕（收口字段名 —— `writeRouteAuditLog` 用的是 source/operation/targetType/targetId，
   * 不是 entityType/entityId；且 `source` 必填）。失败不阻断业务（fire-and-forget）。
   */
  const audit = (input: { actorId: string; operation: string; targetType: string; targetId: string; after?: any }) =>
    writeRouteAuditLog({ prisma, source: 'claim', ...input }).catch(() => undefined);

  /** 统一错误出口（服务层 Result → HTTP） */
  const sendResult = (res: Response, r: { ok: boolean; data?: any; error?: any }, okStatus = 200) => {
    if (r.ok) return res.status(okStatus).json(r.data);
    return res.status(httpStatusOf(r.error?.code)).json({ error: r.error?.code, message: r.error?.message });
  };

  const visibility = (req: Request) => (req as any).claimVisibility as ReturnType<typeof createClaimVisibility>;
  const sendVisibilityError = (res: Response, error: unknown): boolean => {
    if (!(error instanceof ClaimVisibilityError)) return false;
    const safe = safeRouteError(error, {fallbackCode:'CLAIM_SOURCE_ACCESS_FAILED'});
    res.status(safe.status).json({ error: safe.code, message: safe.message });
    return true;
  };
  // A single parent guard covers all existing case/child/CN entry points before
  // services can read private details or write. Unknown/future routes are not
  // assigned an invented permission; their own explicit contract remains required.
  router.use(async (req, res, next) => {
    const path = req.path, read = req.method === 'GET', write = req.method === 'POST';
    let scope: string | null | undefined, kind: 'case' | 'disposition' | 'returnReceipt' | 'returnLine' | 'repair' | 'shipment' | 'creditNote' | 'invoice' | undefined;
    let id: string | undefined, match: RegExpMatchArray | null;
    if (read && /^\/claims\/sources\/(customers|orders|invoices)$/.test(path)) scope = 'aftersales:read';
    else if (path === '/claims' && (read || write)) scope = read ? 'aftersales:read' : 'aftersales:write';
    else if (read && path === '/credit-notes') scope = 'aftersales:read';
    else if ((match = path.match(/^\/claims\/dispositions\/([^/]+)\/(approve|execute|resubmit-approval)$/)) && write) {
      kind = 'disposition'; id = match[1]; scope = match[2] === 'approve' ? null : 'aftersales:write';
    } else if ((match = path.match(/^\/claims\/([^/]+)(?:\/(dispositions|cancel|credit-note))?$/))
      && (read && (!match[2] || match[2] === 'credit-note') || write && ['dispositions', 'cancel'].includes(match[2]))) {
      kind = 'case'; id = match[1]; scope = read ? 'aftersales:read' : 'aftersales:write';
    } else if ((match = path.match(/^\/return-receipt-lines\/([^/]+)\/(receive|scrap)$/)) && write) {
      kind = 'returnLine'; id = match[1]; scope = 'inventory:write';
    } else if ((match = path.match(/^\/return-receipts\/([^/]+)$/)) && read) {
      kind = 'returnReceipt'; id = match[1]; scope = 'aftersales:read';
    } else if ((match = path.match(/^\/repair-work-orders\/([^/]+)(?:\/(start|complete|inspections|return-shipment))?$/)) && (read && !match[2] || write && !!match[2])) {
      kind = 'repair'; id = match[1]; scope = read ? 'aftersales:read' : match[2] === 'inspections' ? 'qc:write' : match[2] === 'return-shipment' ? 'shipments:write' : 'production:write';
    } else if ((match = path.match(/^\/claim-shipments\/([^/]+)\/stock$/)) && (read || write)) {
      kind = 'shipment'; id = match[1]; scope = read ? 'aftersales:read' : 'inventory:write';
    } else if ((match = path.match(/^\/credit-notes\/([^/]+)\/(versions|issue|apply|cancel)$/)) && (read && match[2] === 'versions' || write && match[2] !== 'versions')) {
      kind = 'creditNote'; id = match[1]; scope = read ? 'aftersales:read' : match[2] === 'apply' ? 'invoices:reconcile' : 'aftersales:write';
    } else if ((match = path.match(/^\/invoices\/([^/]+)\/write-off-tail$/)) && write) {
      kind = 'invoice'; id = match[1]; scope = 'aftersales:write';
    }
    if (scope === undefined) return next();
    const actor = authenticate(req, res); if (!actor) return;
    try {
      if (id) {
        try { id = decodeURIComponent(id); }
        catch { throw new ClaimVisibilityError('VALIDATION_FAILED', '记录 ID 编码无效'); }
      }
      const access = createClaimVisibility(prisma, actor);
      (req as any).actor = await access.currentActor();
      if (scope && !requireScope(req, res, scope)) return;
      (req as any).claimVisibility = access;
      if (kind === 'case') await access.requireCase(id!);
      else if (kind === 'creditNote') {
        await access.requireCreditNote(id!);
        if (write && path.endsWith('/apply') && req.body?.toInvoiceId) {
          if (typeof req.body.toInvoiceId !== 'string') throw new ClaimVisibilityError('VALIDATION_FAILED', 'toInvoiceId 须为准确的发票 ID');
          await access.requireInvoice(req.body.toInvoiceId);
        }
      }
      else if (kind === 'invoice') await access.requireInvoice(id!);
      else if (kind) await access.requireChild(kind, id!);
      return next();
    } catch (error) {
      if (sendVisibilityError(res, error)) return;
      return res.status(httpStatusOfCode('DEPENDENCY_CHECK_FAILED')).json({ error: 'DEPENDENCY_CHECK_FAILED', message: '暂时无法核验售后数据范围，请稍后重试' });
    }
  });

  for (const [entity, method] of [['customers', 'candidateCustomers'], ['orders', 'candidateOrders'], ['invoices', 'candidateInvoices']] as const) {
    router.get(`/claims/sources/${entity}`, async (req, res) => {
      try { return res.json(await visibility(req)[method](req.query)); }
      catch (error) {
        if (sendVisibilityError(res, error)) return;
        return res.status(httpStatusOfCode('DEPENDENCY_CHECK_FAILED')).json({ error: 'DEPENDENCY_CHECK_FAILED', message: '暂时无法读取真实业务来源，请稍后重试' });
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 案件
  // ══════════════════════════════════════════════════════════════════

  router.get('/claims', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:read')) return;
    try {
      const r = await listClaimCases(prisma, {
        status: req.query.status ? String(req.query.status) : undefined,
        customerRelationId: req.query.customerRelationId ? String(req.query.customerRelationId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset !== undefined ? Number(req.query.offset) : undefined,
        scopeWhere: await visibility(req).caseScopeWhere(),
      });
      return sendResult(res, r);
    } catch (e: any) {
      if (sendVisibilityError(res, e)) return;
      logger.error('[ClaimRoute] GET /claims failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '查询售后案件失败' });
    }
  });

  router.get('/claims/:id', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:read')) return;
    try {
      const result = await getClaimCase(prisma, req.params.id);
      if (result.ok && result.data?.claimCase.sourceInvoiceId) {
        const invoice = await visibility(req).requireInvoice(result.data.claimCase.sourceInvoiceId);
        result.data.claimCase.sourceInvoice = { id: invoice.id, invoiceNumber: invoice.invoiceNumber, currency: invoice.currency,
          customerRelationId: invoice.customerRelationId, billTo: { id: invoice.customerRelationId, name: invoice.customerName } };
      }
      return sendResult(res, result);
    } catch (e: any) {
      if (sendVisibilityError(res, e)) return;
      logger.error('[ClaimRoute] GET /claims/:id failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '查询售后案件失败' });
    }
  });

  router.post('/claims', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      const r = await createClaimCase(prisma, req.body ?? {}, auth.userId, { actor: auth });
      if (r.ok) {
        await audit({
          actorId: auth.userId, operation: 'create', targetType: 'ClaimCase', targetId: r.data!.claimCase.id,
          after: { caseNumber: r.data!.claimCase.caseNumber, problemDesc: r.data!.claimCase.problemDesc },
        });
      }
      return sendResult(res, r, 201);
    } catch (e: any) {
      logger.error('[ClaimRoute] POST /claims failed', { error: e?.message });
      if (sendVisibilityError(res, e)) return;
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '登记售后案件失败' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // 处置（提交 → 审批 → 执行）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 加一条处置 —— ★ 同时**创建审批单**（口径 A7：任何金额都汇总领导批）。
   *
   * 审批主体由 `approvals/` 内核按策略解析（本路由不判"谁能批"）。
   * `NO_REVIEWER_RESOLVED`（解析不到审批人）**原样透传 409** —— fail-closed，
   * 不允许"没人可批就自动通过"。
   */
  router.post('/claims/:id/dispositions', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      const created = await prisma.$transaction(async (tx: any) => {
        const { disposition } = requireClaimResult(await addDisposition(prisma, req.params.id, req.body ?? {}, auth.userId, { tx }));
        const claimCase = await tx.claimCase.findUnique({ where: { id: disposition.claimCaseId } });
        if (!claimCase || claimCase.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '售后案件不存在' });
        const payload = buildClaimApprovalPayload(disposition, claimCase);
        const approval = await approvalCreateService.createBusinessApproval({
          requesterId: auth.userId, actionType: CLAIM_APPROVAL_ACTION, targetType: CLAIM_APPROVAL_TARGET,
          targetId: disposition.id, payload, client: tx,
        });
        await writeRouteAuditLog({ prisma: tx, source: 'claim', actorId: auth.userId, operation: 'create',
          targetType: 'ClaimDisposition', targetId: disposition.id,
          after: { claimCaseId: claimCase.id, kind: disposition.kind, approvalRequestId: approval.id,
            snapshotVersion: payload.schemaVersion, contentFingerprint: payload.contentFingerprint } });
        return { disposition, approvalRequestId: approval.id };
      });
      return res.status(201).json(created);
    } catch (e: any) {
      if (e instanceof ClaimTransactionError) return sendResult(res, { ok: false, error: e.claimError });
      logger.error('[ClaimRoute] POST /claims/:id/dispositions failed', { error: e?.message });
      if (e?.code === 'NO_REVIEWER_RESOLVED') return res.status(httpStatusOfCode('NO_REVIEWER_RESOLVED')).json({
        error: e.code, message: '处置未提交：索赔须配置有效且明确的总领导，配置后重新提交',
      });
      if (e?.code === 'APPROVAL_PENDING_CONTENT_CHANGED') return res.status(httpStatusOfCode('CONFLICT')).json({
        error: e.code, message: '处置未提交：未决审批内容已变化，请处理原审批后重新提交',
      });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: e?.code === 'APPROVAL_CREATE_FAILED' ? e.code : 'INTERNAL_ERROR', message: '添加处置失败，处置与审批均未提交' });
    }
  });

  /** Manual continuation appends a new disposition/approval while retaining historical facts. */
  router.post('/claims/dispositions/:id/resubmit-approval', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      return sendResult(res, await resubmitClaimApproval(prisma, req.params.id, req.body ?? {}, auth.userId), 201);
    } catch (e: any) {
      logger.error('[ClaimRoute] resubmit approval failed', { error: e?.message });
      if (e?.code === 'NO_REVIEWER_RESOLVED') return res.status(httpStatusOfCode('NO_REVIEWER_RESOLVED')).json({ error: e.code, message: '重送审未提交：须配置有效且明确的总领导后重新提交' });
      if (e?.code === 'APPROVAL_PENDING_CONTENT_CHANGED') return res.status(httpStatusOfCode('CONFLICT')).json({ error: e.code, message: '重送审未提交：未决审批内容已变化' });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '重新送审失败，未确认新增续办；请刷新核对原处置并使用相同请求标识重试' });
    }
  });

  /**
   * 审批处置。
   *
   * ⚠️ 口径 **B1**：`aftersales:approve` 是 **UI 能力标签**、**不是强制门禁** ⇒
   *   本端点**不做 scope 强制**，只做鉴权；"谁能批"由 `approvals/` 内核决定
   *   （审批人在审批中心点通过 → 调本端点推进处置状态）。
   */
  router.post('/claims/dispositions/:id/approve', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const r = await approveDisposition(prisma, req.params.id, auth.userId);
      return sendResult(res, r);
    } catch (e: any) {
      logger.error('[ClaimRoute] approve failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '审批处置失败' });
    }
  });

  /** 执行处置 —— ★ 走 `claimSettlement` 收口点（钱/货两条腿的唯一入口） */
  router.post('/claims/dispositions/:id/execute', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      const r = await executeDisposition(prisma, req.params.id, auth.userId, {
        warehouseId: req.body?.warehouseId ?? null,
        // ★ A-3 二期：返修要工位；换货补发可指定原出运单（继承运输属性 + 追溯）
        workStationId: req.body?.workStationId ?? null,
        sourceShipmentId: req.body?.sourceShipmentId ?? null,
        notes: req.body?.notes ?? null,
        clientRequestId: req.body?.clientRequestId ?? null,
      });
      return sendResult(res, r);
    } catch (e: any) {
      logger.error('[ClaimRoute] execute failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '执行处置失败' });
    }
  });

  /** 撤销案件（口径 A5：能撤销 + 留痕） */
  router.post('/return-receipt-lines/:id/receive', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'inventory:write')) return;
    try { return sendResult(res, await receiveClaimReturn(prisma, req.params.id, req.body ?? {}, auth.userId)); }
    catch (e: any) {
      logger.error('[ClaimRoute] actual return receive failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '实际收货未确认提交，请刷新核对并使用相同请求标识重试' });
    }
  });

  router.post('/return-receipt-lines/:id/scrap', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'inventory:write')) return;
    try { return sendResult(res, await scrapClaimReturn(prisma, req.params.id, req.body ?? {}, auth.userId)); }
    catch (e: any) {
      logger.error('[ClaimRoute] actual return scrap failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '报废未确认提交，请刷新核对并使用相同请求标识重试' });
    }
  });

  router.get('/return-receipts/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res) || !requireScope(req, res, 'aftersales:read')) return;
    try { return sendResult(res, await getReturnReceipt(prisma, req.params.id)); }
    catch (e: any) { logger.error('[ClaimRoute] return receipt read failed', { error: e?.message }); return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '读取退货单失败' }); }
  });
  router.get('/repair-work-orders/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res) || !requireScope(req, res, 'aftersales:read')) return;
    try { return sendResult(res, await getRepairWorkOrder(prisma, req.params.id)); }
    catch (e: any) { logger.error('[ClaimRoute] repair read failed', { error: e?.message }); return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '读取返修工单失败' }); }
  });
  for (const [action, scope, service] of [
    ['start', 'production:write', startClaimRepair], ['complete', 'production:write', completeClaimRepair], ['inspections', 'qc:write', recordClaimRepairInspection],
  ] as const) router.post(`/repair-work-orders/:id/${action}`, async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth || !requireScope(req, res, scope)) return;
    try { return sendResult(res, await service(prisma, req.params.id, req.body ?? {}, auth.userId), action === 'inspections' ? 201 : 200); }
    catch (e: any) {
      logger.error('[ClaimRoute] repair actual progress failed', { action, error: e?.message });
      if (e?.code === 'INSUFFICIENT_PERMISSION') return res.status(httpStatusOfCode('FORBIDDEN')).json({ error: e.code, message: '实际质检登记人当前没有质检写权限' });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '返修进度未确认提交，请刷新核对并使用相同请求标识重试' });
    }
  });

  router.post('/repair-work-orders/:id/return-shipment', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth || !requireScope(req, res, 'shipments:write')) return;
    try { return sendResult(res, await createClaimRepairReturnShipment(prisma, req.params.id, req.body ?? {}, auth.userId), 201); }
    catch (e: any) { logger.error('[ClaimRoute] repair return draft failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '返还草稿未确认提交，请刷新核对并使用相同请求标识重试' }); }
  });
  router.get('/claim-shipments/:id/stock', async (req: Request, res: Response) => {
    if (!authenticate(req, res) || !requireScope(req, res, 'aftersales:read')) return;
    try { return sendResult(res, await getClaimShipmentStockBinding(prisma, req.params.id)); }
    catch (e: any) { logger.error('[ClaimRoute] claim stock binding read failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '读取实际库存选择失败，请刷新重试' }); }
  });
  router.post('/claim-shipments/:id/stock', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth || !requireScope(req, res, 'inventory:write')) return;
    try { return sendResult(res, await bindClaimShipmentStock(prisma, req.params.id, req.body ?? {}, auth.userId)); }
    catch (e: any) { logger.error('[ClaimRoute] claim stock binding failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '实际库存选择未确认提交，请刷新核对并使用相同请求标识重试' }); }
  });

  router.post('/claims/:id/cancel', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      const r = await cancelClaimCase(prisma, req.params.id, String(req.body?.reason ?? ''), auth.userId);
      if (r.ok) {
        await audit({
          actorId: auth.userId, operation: 'cancel', targetType: 'ClaimCase', targetId: req.params.id,
          after: { status: 'Cancelled', reason: req.body?.reason },
        });
      }
      return sendResult(res, r);
    } catch (e: any) {
      logger.error('[ClaimRoute] cancel failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '撤销案件失败' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // 退款单（CN）
  // ══════════════════════════════════════════════════════════════════

  router.get('/claims/:id/credit-note', async (req: Request, res: Response) => {
    if (!authenticate(req, res) || !requireScope(req, res, 'aftersales:read')) return;
    try { return sendResult(res, await getClaimCreditNote(prisma, req.params.id)); }
    catch (e: any) { logger.error('[ClaimRoute] claim credit note failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '查询案件退款账户失败' }); }
  });
  router.get('/credit-notes/:id/versions', async (req: Request, res: Response) => {
    if (!authenticate(req, res) || !requireScope(req, res, 'aftersales:read')) return;
    try { return sendResult(res, await getCreditNoteVersions(prisma, req.params.id, {
      versionId: req.query.versionId ? String(req.query.versionId) : undefined,
    })); }
    catch (e: any) { logger.error('[ClaimRoute] credit note versions failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '查询退款单版本失败' }); }
  });
  router.post('/credit-notes/:id/issue', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth || !requireScope(req, res, 'aftersales:write')) return;
    try { return sendResult(res, await issueClaimCreditNoteVersion(prisma, req.params.id, req.body, auth.userId)); }
    catch (e: any) { logger.error('[ClaimRoute] credit note issue failed', { error: e?.message });
      return res.status(httpStatusOfCode('INTERNAL_ERROR')).json({ error: 'INTERNAL_ERROR', message: '发行退款单版本失败' }); }
  });

  router.get('/credit-notes', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:read')) return;
    try {
      const r = await listOpenCreditNotes(prisma, {
        customerRelationId: req.query.customerRelationId ? String(req.query.customerRelationId) : undefined,
        claimCaseId: req.query.claimCaseId ? String(req.query.claimCaseId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset !== undefined ? Number(req.query.offset) : undefined,
        includeClosed: req.query.includeClosed === 'true',
        status: req.query.status ? String(req.query.status) : undefined,
        scopeWhere: await visibility(req).creditNoteScopeWhere(),
      });
      return sendResult(res, r);
    } catch (e: any) {
      logger.error('[ClaimRoute] GET /credit-notes failed', { error: e?.message });
      if (sendVisibilityError(res, e)) return;
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '查询退款单失败' });
    }
  });

  /** 核销退款单（口径 A2：抵扣发票 / 现金退款 —— 现金退款一期未实现，服务层显式拒绝） */
  /**
   * ★ C7：尾差销账 —— 对某张应收票的**未结额**开一张贷项票（纯折让，非客诉）并立即抵扣。
   *
   * 为什么单开这个入口：CN 的唯一创建路径原是「索赔处置」（5 步 + 语义错位），
   * 一笔 $3.25 的尾差没人会走 ⇒ 发票永远 PartiallyPaid、账龄天天报警（A3 修了内核、缺入口）。
   *
   * 权限：`aftersales:write`（与核销同一档 —— 它本质就是一次核销 + 开单）。
   * ⚠️ 有金额上限（见 writeOffService.checkTailThreshold），超额请走索赔/审批。
   */
  router.post('/invoices/:invoiceId/write-off-tail', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      const r = await writeOffInvoiceTail(prisma, {
        invoiceId: req.params.invoiceId,
        amount: req.body?.amount ?? null,
        reason: String(req.body?.reason ?? ''),
        issueDate: req.body?.issueDate ?? undefined,
      }, auth.userId);
      return sendResult(res, r, 201);
    } catch (e: any) {
      logger.error('[ClaimRoute] write-off-tail failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '尾差销账失败' });
    }
  });

  router.post('/credit-notes/:id/apply', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'invoices:reconcile')) return;
    try {
      const r = await applyCreditNote(prisma, req.params.id, {
        // ★ v3.14（L-A）：不再 `?? 0` —— 没填就让被调方按「未填写」拒掉（此前是"没填 ⇒ 0 ⇒ 核销金额须为正数"，
        //   用户看到的是误导提示，而载荷里曾经真的带过 0）
        appliedAmount: req.body?.appliedAmount,
        toInvoiceId: req.body?.toInvoiceId ?? null,
        refund: req.body?.refund === true,
        clientRequestId: req.body?.clientRequestId,
      }, auth.userId);
      if (r.ok && !r.data!.replayed) {
        await audit({
          actorId: auth.userId, operation: 'apply', targetType: 'CreditNote', targetId: req.params.id,
          after: { applied: r.data!.applied, openAmount: String(r.data!.creditNote.openAmount), status: r.data!.creditNote.status },
        });
      }
      return sendResult(res, r);
    } catch (e: any) {
      logger.error('[ClaimRoute] apply failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '核销退款单失败' });
    }
  });

  /** 作废退款单（口径 A5） */
  router.post('/credit-notes/:id/cancel', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'aftersales:write')) return;
    try {
      const r = await cancelCreditNote(prisma, req.params.id, String(req.body?.reason ?? ''), auth.userId);
      if (r.ok) {
        await audit({
          actorId: auth.userId, operation: 'cancel', targetType: 'CreditNote', targetId: req.params.id,
          after: { status: 'Cancelled', reason: req.body?.reason },
        });
      }
      return sendResult(res, r);
    } catch (e: any) {
      logger.error('[ClaimRoute] credit-note cancel failed', { error: e?.message });
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: '作废退款单失败' });
    }
  });

  return router;
}
