/**
 * 业务审批中心 API — /api/v1/approvals
 *
 * PRD 19.21（通知与审批中心 · 审批 Tab）+ 9.2 价格审批规则落地：
 *   - 第九章业务规则命中的审批（如 quotation:price-deviation 双轨偏差）集中在此处理
 *   - 与 Agent 工具审批（Assistant 内 resolve 流程，actionType 为 tool:*）分离：
 *     本路由只服务业务审批，工具审批不出现在列表
 *
 * 端点：
 *   GET  /?status=pending|done  — 待办 / 已办（含 requester/reviewer 摘要）
 *   POST /:id/decide            — 决策 { status: approved|rejected, decisionNote? }
 *
 * 权限（服务端强制执行，PRD 9.6）：
 *   - 仅 JWT（owner / admin / manager）；API-Key 一律 401
 *   - 驳回必须填 decisionNote（PRD 19.21「驳回必填意见」）
 *   - 申请人不可审批自己的单子（自审 403）
 *   - 已指派 reviewerId 的单仅该审批人本人可决议（owner BOSS 兜底除外），
 *     归属判定唯一真源 approvalDecisionService.evaluateDecideOwnership（403 APPROVAL_NOT_ASSIGNED）
 *   - 仅 pending 可决策，重复决策 409
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { logger } from '../lib/logger';
import { approvalReviewContentVersion, createApprovalDecisionService, type OnApprovalDecided, type DecideActor } from './approvalDecisionService';
import { createQuotationApprovalAmendmentRouter } from './quotationApprovalAmendmentRouter';
import { readApprovalReviewDetail } from './approvalReviewDetailService';
import { assertDevelopmentExpenseAccess, assertDevelopmentFinanceRecipient } from '../development/developmentExpenseAccess';
import { previewDevelopmentBillingFinalProposal, decideDevelopmentBillingApproval } from '../development/developmentBillingApprovalService';
import { publishNotificationEvent } from '../realtime';
import { assertApprovalReviewSourceRead, canReadApprovalReviewAttachments } from './approvalReviewSourceAccess';
import { isOrderChangeApprovalAction } from '../orderChanges/orderChangeReadAccess';
import { ORDER_MAIN_APPROVAL_ACTION, createOrderMainApprovalService, OrderMainApprovalError } from '../orders/orderMainApprovalService';
import { readOrderMainRejection, readOrderMainWithdrawal } from '../orders/orderMainApprovalEvidence';
import { SUPPLIER_COMMITMENT_APPROVAL_ACTION, decideSupplierCommitmentApproval } from '../procurement/supplierCommitmentService';
import { SupplierContractError } from '../procurement/supplierContractPolicy';
import { assertSupplierApprovalCenterRead, readSupplierApprovalReviewDetail, readSupplierApprovalSyncStatus } from './approvalSupplierCommitmentAdapter';

// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';
import { assertPaymentRequestPayableApproval, isPaymentRequestApproval } from '../paymentRequests/paymentRequestPayableSource';
// 业务审批可见/可决策角色：管理层（owner/admin）+ 部门主管（manager）
const APPROVER_ROLES = ['owner', 'admin', 'manager'];

// Agent 工具审批走 Assistant resolve 流程，不在业务审批中心展示
const EXCLUDED_ACTION_PREFIX = 'tool:';
// The current server hook projects only these native approval targets. Other
// approval types have no business continuation in index.ts today.
const BUSINESS_SYNC_TARGETS = new Set(['OrderChangeRequest', 'Dr013ExceptionRequest']);

export interface ApprovalRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  /** Committed decisions only; callback must project idempotently by approval id. */
  onDecided?: OnApprovalDecided;
}

const personSelect = { id: true, displayName: true, email: true } as const;
const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};

type BusinessSyncStatus = 'completed' | 'failed' | 'not_applicable' | 'unknown';

/** Reconstruct continuation status only from the exact immutable decision audit and its delivery audit. */
async function readBusinessSyncStatus(prisma: PrismaClient, item: any): Promise<BusinessSyncStatus> {
  if (item.actionType === SUPPLIER_COMMITMENT_APPROVAL_ACTION) return readSupplierApprovalSyncStatus(prisma, item);
  if (!BUSINESS_SYNC_TARGETS.has(item.targetType)) return 'not_applicable';
  if (!['approved', 'rejected'].includes(item.status) || !item.decidedAt) return 'unknown';

  const audits = await prisma.auditLog.findMany({
    where: { targetType: 'ApprovalRequest', targetId: item.id },
    orderBy: { createdAt: 'desc' },
  });
  const decidedAt = item.decidedAt instanceof Date ? item.decidedAt.toISOString() : new Date(item.decidedAt).toISOString();
  const fingerprint = asRecord(item.payload).contentFingerprint ?? null;
  const decisionActorId = item.bossFinalBypassBy ?? item.reviewerId;
  if (!decisionActorId) return 'unknown';
  const decisions = audits.filter((audit: any) => {
    const fact = asRecord(asRecord(audit.detail).approvalDecisionFact);
    return fact.schemaVersion === 1 && audit.actorId === decisionActorId && fact.decisionActorId === decisionActorId
      && fact.status === item.status && fact.actionType === item.actionType
      && fact.targetType === item.targetType && fact.targetId === item.targetId
      && fact.decidedAt === decidedAt && fact.contentFingerprint === fingerprint;
  });
  if (decisions.length !== 1) return 'unknown';

  const decisionAuditId = decisions[0].id;
  const correlated = audits.filter((audit: any) => {
    const detail = asRecord(audit.detail);
    return detail.approvalId === item.id && detail.decisionAuditId === decisionAuditId
      && (audit.action === 'approval_sync_completed' || audit.action === 'approval_sync_failed');
  });
  if (correlated.some((audit: any) => audit.action === 'approval_sync_completed')) return 'completed';
  if (correlated.some((audit: any) => audit.action === 'approval_sync_failed')) return 'failed';
  return 'unknown';
}

export function createApprovalRouter(options: ApprovalRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, onDecided } = options;
  const decisions = createApprovalDecisionService(prisma, { onDecided });
  const orderMainApprovals = createOrderMainApprovalService(prisma);

  // ── 鉴权 + 角色门禁：仅 JWT 且具备审批角色 ──
  const authenticate = (req: Request, res: Response): DecideActor | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'authentication required（业务审批仅接受 JWT 登录）' });
      return null;
    }
    if (requireAuth && !actor.roles?.some(r => APPROVER_ROLES.includes(r))) {
      res.status(403).json({ error: 'forbidden：仅管理层 / 部门主管可处理业务审批' });
      return null;
    }
    return { ...actor, roles: actor.roles ?? [] };
  };

  // Result readback may be requested by the applicant; the router applies its
  // own exact requester/reviewer scope. Preview/confirm retain the manager gate.
  const authenticateRead = (req: Request, res: Response): DecideActor | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'authentication required（业务审批仅接受 JWT 登录）' });
      return null;
    }
    return { ...actor, roles: actor.roles ?? [] };
  };

  router.use('/', createQuotationApprovalAmendmentRouter({
    prisma,
    authenticateRead,
    authenticateDecide: authenticate,
    decide: input => decisions.decide(input),
  }));

  // ── GET / — 待办 / 已办列表 ──
  router.get('/', async (req: Request, res: Response) => {
    const actor = authenticateRead(req, res);
    if (!actor) return;
    try {
      const view = req.query.status === 'done' ? 'done' : 'pending';
      const canSeeGeneralApprovals = actor.roles.some(role => APPROVER_ROLES.includes(role));
      const base = { actionType: { not: { startsWith: EXCLUDED_ACTION_PREFIX } } };
      const ownerFallback = actor.roles.includes('owner') ? [{ reviewerId: null }] : [];
      const orderMainCandidate = { actionType: ORDER_MAIN_APPROVAL_ACTION, eligibleReviewerIds: { array_contains: [actor.userId] } };
      const supplierCandidate = { actionType: SUPPLIER_COMMITMENT_APPROVAL_ACTION, eligibleReviewerIds: { array_contains: [actor.userId] } };
      const generalPending = canSeeGeneralApprovals ? [{ reviewerId: actor.userId }, ...ownerFallback] : [];
      const generalDone = canSeeGeneralApprovals ? [{ reviewerId: actor.userId }, { requesterId: actor.userId },
        ...(actor.roles.includes('owner') ? [{ bossFinalBypassBy: actor.userId }] : [])] : [];
      const where: any = view === 'pending'
        ? { ...base, status: 'pending', OR: [orderMainCandidate, supplierCandidate, ...generalPending] }
        : { ...base, status: { in: ['approved', 'rejected', 'cancelled'] }, OR: [orderMainCandidate, supplierCandidate, ...generalDone] };
      const items = await prisma.approvalRequest.findMany({
        where,
        orderBy: view === 'pending' ? { createdAt: 'asc' } : { decidedAt: 'desc' }, // 待办按先到先审；已办按决策时间倒序
        take: 100,
        include: { requester: { select: personSelect }, reviewer: { select: personSelect } },
      });
      const visibleItems = [];
      for (const item of items) {
        if (isOrderChangeApprovalAction(item.actionType)) {
          try { await prisma.$transaction(tx => assertApprovalReviewSourceRead(tx, item, extractActorFromRequest(req)!)); }
          catch (error) {
            if ([403, 404].includes(safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).status)) continue;
            throw error;
          }
        }
        if (isPaymentRequestApproval(item)) {
          try { await prisma.$transaction(tx => assertPaymentRequestPayableApproval(tx, item, extractActorFromRequest(req), false)); }
          catch (error) {
            if ([403, 404].includes(safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).status)) continue;
            throw error;
          }
        }
        if (item.actionType === ORDER_MAIN_APPROVAL_ACTION) {
          try {
            const access = await prisma.$transaction(tx => orderMainApprovals.readAccess(tx, item, extractActorFromRequest(req)!));
            visibleItems.push({ ...item, reviewContentVersion: approvalReviewContentVersion(item), frozenEvidenceStatus: access.frozenEvidenceStatus,
              rejectionReason: access.rejectionReason, requestedChanges: access.requestedChanges });
          } catch (error) {
            if ([403, 404].includes(safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).status)) continue;
            throw error;
          }
          continue;
        }
        if (item.actionType === SUPPLIER_COMMITMENT_APPROVAL_ACTION) {
          try { await prisma.$transaction(tx => assertSupplierApprovalCenterRead(tx, item, extractActorFromRequest(req)!)); }
          catch (error) {
            if (error instanceof SupplierContractError && [403, 404, 409].includes(error.statusCode)) continue;
            throw error;
          }
        }
        visibleItems.push({ ...item, reviewContentVersion: approvalReviewContentVersion(item) });
      }
      for (const item of visibleItems) if (isOrderChangeApprovalAction(item.actionType))
        await prisma.$transaction(tx => assertApprovalReviewSourceRead(tx, item, extractActorFromRequest(req)!));
      res.json({ items: visibleItems });
    } catch (e: any) {
      logger.error('[ApprovalRoute] GET list failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to list approvals' });
      res.status(r.status).json({ error: r.message });
    }
  });

  // Exact review projection. Current business data is included only after its
  // native read permission (including customer relation scope) succeeds.
  router.get('/:id/detail', async (req: Request, res: Response) => {
    const rawActor = extractActorFromRequest(req);
    if (!rawActor?.userId) return res.status(401).json({ error: 'authentication required（业务审批仅接受 JWT 登录）' });
    try {
      const roles = rawActor.roles ?? [];
      const hasApprovalRole = !requireAuth || roles.some(role => APPROVER_ROLES.includes(role));
      const readScope: any[] = [{ requesterId: rawActor.userId }];
      if (hasApprovalRole) readScope.push({ reviewerId: rawActor.userId });
      // Actual Orders L2 below authorizes source business readers as well as
      // frozen reviewer candidates. Knowing an approval ID grants no access.
      readScope.push({ actionType: ORDER_MAIN_APPROVAL_ACTION });
      readScope.push({ actionType: SUPPLIER_COMMITMENT_APPROVAL_ACTION, eligibleReviewerIds: { array_contains: [rawActor.userId] } });
      if (hasApprovalRole && roles.includes('owner')) {
        readScope.push({ status: 'pending', reviewerId: null });
        readScope.push({ bossFinalBypassBy: rawActor.userId });
      }
      const item = await prisma.approvalRequest.findFirst({ where: { id: req.params.id,
        actionType: { not: { startsWith: EXCLUDED_ACTION_PREFIX } }, OR: readScope },
        include: { requester: { select: personSelect }, reviewer: { select: personSelect } } });
      if (!item) return res.status(404).json({ error: 'approval not found' });
      if (isPaymentRequestApproval(item))
        await prisma.$transaction(tx => assertPaymentRequestPayableApproval(tx, item, rawActor, false));
      if (item.actionType === SUPPLIER_COMMITMENT_APPROVAL_ACTION) {
        const detail = await prisma.$transaction(tx => readSupplierApprovalReviewDetail(tx, item, rawActor));
        return res.json({ detail });
      }
      if (item.actionType === ORDER_MAIN_APPROVAL_ACTION) {
        const { access, historyRows } = await prisma.$transaction(async tx => {
          const access = await orderMainApprovals.readAccess(tx, item, rawActor);
          const rows = await tx.approvalRequest.findMany({
            where: { actionType: ORDER_MAIN_APPROVAL_ACTION, targetType: 'Order', targetId: item.targetId, status: { in: ['approved', 'rejected', 'cancelled'] } },
            include: { reviewer: { select: personSelect } }, orderBy: { decidedAt: 'desc' },
          });
          return { access, historyRows: await Promise.all(rows.map(async row => ({ ...row, ...await readOrderMainRejection(tx, row), ...await readOrderMainWithdrawal(tx, row) }))) };
        });
        const payload: any = item.payload || {};
        const snapshotOrder = payload.snapshot?.order;
        if (!snapshotOrder || snapshotOrder.id !== item.targetId) return res.status(409).json({ error: '审批冻结订单快照缺失，无法安全审阅。' });
        const toText = (value: unknown) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        const headerFields = Object.entries(snapshotOrder).filter(([key, value]) => key !== 'lines' && key !== 'deletedAt' && value !== undefined)
          .map(([key, value]) => ({ key: `order.${key}`, label: key, value: toText(value) }));
        const lineFields = (Array.isArray(snapshotOrder.lines) ? snapshotOrder.lines : []).flatMap((line: any, index: number) =>
          Object.entries(line).filter(([key, value]) => value !== undefined).map(([key, value]) => ({
            key: `lines.${index}.${key}`, label: `条目 ${index + 1} · ${key}`, value: toText(value),
          })));
        const frozenFields = [...headerFields, ...lineFields];
        const version = approvalReviewContentVersion(item);
        return res.json({ detail: {
          schemaVersion: 1, approvalId: item.id, actionType: item.actionType, targetType: item.targetType, targetId: item.targetId,
          title: `${payload.businessLine === 'fabric' ? '面料' : '成衣'}订单主单审批 · ${snapshotOrder.poNumber || snapshotOrder.id}`,
          reviewContentVersion: version,
          frozenEvidenceStatus: access.frozenEvidenceStatus,
          frozen: { label: '本次订单与全部条目的冻结快照', fields: frozenFields, attachments: [],
            attachmentStatus: 'not_applicable', attachmentStatusLabel: '订单主单审批不在此处打开附件',
            sourceReference: { kind: 'order', id: item.targetId, label: `订单 ${snapshotOrder.poNumber || snapshotOrder.id}` }, previewDigest: version },
          currentSource: { status: 'available', label: access.frozenEvidenceStatus === 'legacy_unverifiable'
            ? '历史冻结依据未验证，仅供回看。待审申请请撤回后重新提交。' : '本审批依据提交时冻结；退回原因和具体修改要求分别保留。', fields:
            historyRows.filter(row => row.status === 'rejected').slice(0, 1).flatMap(row => [
              { key: 'rejectionReason', label: '退回原因', value: row.rejectionReason || '历史未独立记录' },
              { key: 'requestedChanges', label: '具体修改要求', value: row.requestedChanges || '历史未独立记录' },
            ]) },
          decisionHistory: historyRows.map((row: any) => ({ id: row.id, action: row.status, status: row.status,
            actorId: row.status === 'cancelled' ? row.withdrawnBy || '' : row.reviewerId || '', actorName: row.reviewer?.displayName || null,
            occurredAt: row.decidedAt?.toISOString?.() || row.createdAt.toISOString(), decisionNote: row.decisionNote || undefined,
            rejectionReason: row.rejectionReason, requestedChanges: row.requestedChanges,
            withdrawnBy: row.withdrawnBy, withdrawnAt: row.withdrawnAt, withdrawalReason: row.withdrawalReason })),
          decisionHistoryStatus: 'available', approvalBlockers: access.approvalBlockers, canApprove: access.canApprove,
        } });
      }
      const detail = await prisma.$transaction(async (tx: any) => {
        let canReadCurrentSource = false;
        if (isOrderChangeApprovalAction(item.actionType)) {
          // A hidden current source also denies its frozen commercial payload.
          await assertApprovalReviewSourceRead(tx, item, rawActor); canReadCurrentSource = true;
        } else {
          try { await assertApprovalReviewSourceRead(tx, item, rawActor); canReadCurrentSource = true; }
          catch { canReadCurrentSource = false; }
        }
        const canReadAttachments = await canReadApprovalReviewAttachments(tx, item, rawActor);
        const detail = await readApprovalReviewDetail(tx, item, { canReadCurrentSource, canReadAttachments, actor: rawActor });
        if (isOrderChangeApprovalAction(item.actionType)) await assertApprovalReviewSourceRead(tx, item, rawActor);
        return detail;
      });
      return res.json({ detail });
    } catch (e: any) {
      logger.error('[ApprovalRoute] GET review detail failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to read approval review detail' });
      return res.status(r.status).json({ error: r.message });
    }
  });

  router.post('/:id/development-fee-preview', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const { reviewContentVersion, finalInput } = req.body || {};
      if (typeof reviewContentVersion !== 'string' || !/^[a-f0-9]{64}$/.test(reviewContentVersion))
        return res.status(400).json({ error: '缺少已审阅的审批内容版本，请重新加载审批详情。' });
      const preview = await previewDevelopmentBillingFinalProposal(prisma, { approvalId: req.params.id,
        actorId: auth.userId, reviewContentVersion, finalInput,
        authorizeBusiness: (tx, caseId) => assertDevelopmentExpenseAccess(tx, extractActorFromRequest(req), caseId, 'read') });
      return res.json({ preview });
    } catch (e: any) {
      logger.error('[ApprovalRoute] POST development fee preview failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'DEVELOPMENT_FEE_PREVIEW_FAILED', fallbackMessage: '最终收费方案预览失败，请刷新审批详情' });
      return res.status(r.status).json({ error: r.message });
    }
  });

  // ── GET /:id — exact read. Requesters can inspect their own frozen application;
  // reviewers and the existing owner fallback remain scoped to their assigned range.
  router.get('/:id', async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'authentication required（业务审批仅接受 JWT 登录）' });
      return;
    }
    try {
      const roles = actor.roles ?? [];
      const hasApprovalRole = !requireAuth || roles.some(role => APPROVER_ROLES.includes(role));
      const readScope: any[] = [{ requesterId: actor.userId }];
      if (hasApprovalRole) readScope.push({ reviewerId: actor.userId });
      readScope.push({ actionType: ORDER_MAIN_APPROVAL_ACTION });
      readScope.push({ actionType: SUPPLIER_COMMITMENT_APPROVAL_ACTION, eligibleReviewerIds: { array_contains: [actor.userId] } });
      if (hasApprovalRole && roles.includes('owner')) {
        readScope.push({ status: 'pending', reviewerId: null });
        // The BOSS final-bypass actor may read the decision they personally made.
        readScope.push({ bossFinalBypassBy: actor.userId });
      }
      const item = await prisma.approvalRequest.findFirst({
        where: {
          id: req.params.id,
          actionType: { not: { startsWith: EXCLUDED_ACTION_PREFIX } },
          OR: readScope,
        },
        include: { requester: { select: personSelect }, reviewer: { select: personSelect } },
      });
      // Match missing and foreign rows to avoid disclosing approval existence.
      if (!item) return res.status(404).json({ error: 'approval not found' });
      if (isPaymentRequestApproval(item))
        await prisma.$transaction(tx => assertPaymentRequestPayableApproval(tx, item, actor, false));
      const mainAccess = item.actionType === ORDER_MAIN_APPROVAL_ACTION
        ? await prisma.$transaction(tx => orderMainApprovals.readAccess(tx, item, actor)) : null;
      if (item.actionType === SUPPLIER_COMMITMENT_APPROVAL_ACTION)
        await prisma.$transaction(tx => assertSupplierApprovalCenterRead(tx, item, actor));
      const businessSyncStatus = await readBusinessSyncStatus(prisma, item);
      if (isOrderChangeApprovalAction(item.actionType))
        await prisma.$transaction(tx => assertApprovalReviewSourceRead(tx, item, actor));
      return res.json({ item: {
        ...item,
        reviewContentVersion: approvalReviewContentVersion(item),
        businessSyncStatus,
        ...(mainAccess ? { frozenEvidenceStatus: mainAccess.frozenEvidenceStatus, canApprove: mainAccess.canApprove,
          approvalBlockers: mainAccess.approvalBlockers, rejectionReason: mainAccess.rejectionReason, requestedChanges: mainAccess.requestedChanges,
          withdrawnBy: mainAccess.withdrawnBy, withdrawnAt: mainAccess.withdrawnAt, withdrawalReason: mainAccess.withdrawalReason } : {}),
      } });
    } catch (e: any) {
      logger.error('[ApprovalRoute] GET detail failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to read approval' });
      return res.status(r.status).json({ error: r.message });
    }
  });

  // ── POST /:id/decide — 决策（通过 / 驳回） ──
  router.post('/:id/decide', async (req: Request, res: Response) => {
    const routeHint = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, select: { actionType: true } }).catch(() => null);
    const auth = [ORDER_MAIN_APPROVAL_ACTION, SUPPLIER_COMMITMENT_APPROVAL_ACTION].includes(routeHint?.actionType ?? '') ? authenticateRead(req, res) : authenticate(req, res);
    if (!auth) return;
    try {
      const { status, decisionNote, rejectionReason, requestedChanges, reviewContentVersion, reviewPreviewDigest,
        confirmedReviewedContent } = req.body || {};
      if (status !== 'approved' && status !== 'rejected') {
        return res.status(400).json({ error: 'status 须为 approved 或 rejected' });
      }
      if (typeof reviewContentVersion !== 'string' || !/^[a-f0-9]{64}$/.test(reviewContentVersion)) {
        return res.status(400).json({ error: '缺少已审阅的审批内容版本，请重新加载审批详情。' });
      }
      if (status === 'approved' && confirmedReviewedContent !== true) {
        return res.status(400).json({ error: '批准前必须确认已核对本次申请内容。' });
      }
      const note = status === 'rejected'
        ? `驳回原因：${typeof rejectionReason === 'string' ? rejectionReason.trim() : ''}\n需要修改的内容：${typeof requestedChanges === 'string' ? requestedChanges.trim() : ''}`
        : (typeof decisionNote === 'string' ? decisionNote.trim() : '');
      if (status === 'rejected' && (!(typeof rejectionReason === 'string' && rejectionReason.trim()) || !(typeof requestedChanges === 'string' && requestedChanges.trim()))) {
        return res.status(400).json({ error: '驳回原因和需要修改的内容都必须填写。' });
      }

      if (routeHint?.actionType === SUPPLIER_COMMITMENT_APPROVAL_ACTION) {
        if (req.body?.modifiedInput !== undefined) return res.status(400).json({ error: '供应商承诺修改须退回经办修订并重新提交审批。' });
        const result = await decideSupplierCommitmentApproval({ prisma, approvalId: req.params.id,
          actor: extractActorFromRequest(req)!, decision: status, note: note || undefined,
          reviewContentVersion, confirmedReviewedContent: confirmedReviewedContent === true,
          requestKey: req.body?.requestKey });
        return res.json({ item: result.item, commandAck: result.commandAck });
      }

      if (routeHint?.actionType === ORDER_MAIN_APPROVAL_ACTION) {
        const current = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
        if (!current) return res.status(404).json({ error: 'approval not found' });
        if (approvalReviewContentVersion(current) !== reviewContentVersion) return res.status(409).json({ error: '审批内容已变化，请刷新后重新核对。' });
        if (status === 'approved' && confirmedReviewedContent !== true) return res.status(400).json({ error: '批准前必须确认已核对本次申请内容。' });
        try {
          if (req.body?.modifiedInput !== undefined) return res.status(400).json({ error: '订单主单修改须退回业务修订并重新提交审批。' });
          const item = await orderMainApprovals.decide({ approvalId: req.params.id, actorId: auth.userId, decision: status, note,
            rejectionReason, requestedChanges, reviewContentVersion, trustedActor: extractActorFromRequest(req) });
          return res.json({ item: { ...item, reviewContentVersion: approvalReviewContentVersion(item), businessSyncStatus: status === 'approved' ? 'completed' : 'not_applicable' } });
        } catch (error: any) {
          if (error instanceof OrderMainApprovalError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
          throw error;
        }
      }

      if (routeHint?.actionType === 'development:fee') {
        const { modifiedInput, reviewPreviewDigest } = req.body || {};
        const committed = await decideDevelopmentBillingApproval({ prisma, decisionService: decisions,
          approvalId: req.params.id, actor: auth, status, decisionNote: note || undefined, ip: req.ip,
          reviewContentVersion, confirmedReviewedContent: confirmedReviewedContent === true,
          modifiedInput, reviewPreviewDigest,
          authorizeBusiness: (tx, caseId) => assertDevelopmentExpenseAccess(tx, extractActorFromRequest(req), caseId, 'read'),
          authorizeRecipient: (tx, caseId, userId) => assertDevelopmentFinanceRecipient(tx, caseId, userId),
        });
        const published = await decisions.publishCommittedDecision(committed, { id: req.params.id, actor: auth,
          decision: status, source: 'api:approvals', decisionNote: note || undefined, ip: req.ip,
          reviewContentVersion, confirmedReviewedContent: confirmedReviewedContent === true,
          ...(status === 'approved' && modifiedInput !== undefined
            ? { modifiedInput, reviewPreviewDigest } : {}) } as any);
        if (committed.notificationId && committed.notificationUserId) {
          try {
            publishNotificationEvent({ type: 'development_fee_review_requested', title: '开发收费待财务核对',
              body: `领导已批准开发收费方案，请核对费用依据。`, level: 'info', eventId: committed.notificationId,
              eventType: 'development_fee_review_requested', recipientIds: [committed.notificationUserId],
              metadata: { approvalId: req.params.id, billingItemId: committed.billingItem.id, taskId: committed.taskId } });
          } catch (error: any) {
            logger.warn('[ApprovalRoute] committed development fee notification SSE failed', { approvalId: req.params.id, error: error?.message });
          }
        }
        return res.json({ item: published.updated, development: { event: committed.event,
          billingItem: committed.billingItem, ...(committed.assignment ? { assignment: committed.assignment } : {}), taskId: committed.taskId },
          ...(published.sync ? { sync: published.sync } : {}), ...(published.eventDelivery ? { eventDelivery: published.eventDelivery } : {}) });
      }

      const { updated, existing, sync, eventDelivery } = await decisions.decide({
        id: req.params.id, actor: auth, decision: status, decisionNote: note || undefined,
        source: 'api:approvals', ip: req.ip, reviewContentVersion,
        reviewPreviewDigest,
        confirmedReviewedContent: confirmedReviewedContent === true,
      });
      logger.info('[ApprovalRoute] approval decided', { id: existing.id, actionType: existing.actionType,
        status, reviewerId: auth.userId });
      res.json({ item: updated, ...(sync ? { sync } : {}), ...(eventDelivery ? { eventDelivery } : {}) });
    } catch (e: any) {
      logger.error('[ApprovalRoute] POST decide failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to decide approval' });
      res.status(r.status).json({ error: r.message });
    }
  });

  // A main approval withdrawal preserves its original payload and recovers by
  // the original request key. It never acts as a decision or auto-resubmission.
  router.post('/:id/withdraw', async (req: Request, res: Response) => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) return res.status(401).json({ error: 'authentication required' });
    try {
      return res.json(await orderMainApprovals.withdraw({ approvalId: req.params.id, actor,
        requestKey: req.body?.requestKey, reviewContentVersion: req.body?.reviewContentVersion, reason: req.body?.reason }));
    } catch (error) {
      if (error instanceof OrderMainApprovalError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      const result = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '撤回结果暂不可确认，请保留原请求后重试。' });
      return res.status(result.status).json({ error: result.message, code: result.code });
    }
  });

  // Retry only business delivery from a committed, audited decision; never decide twice.
  router.post('/:id/retry-sync', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      res.json(await decisions.retrySync(req.params.id, auth));
    } catch (error: any) {
      logger.error('[ApprovalRoute] retry-sync failed', { error: error?.message });
      const result = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: 'failed to retry approval sync' });
      res.status(result.status).json({ error: result.message });
    }
  });

  return router;
}
