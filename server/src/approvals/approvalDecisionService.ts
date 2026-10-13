import { canSelfConfirmQuotation, resolveQuotationBusinessLeader } from './quotationBusinessLeader';
import { isMoqExemptionApproval, lockMoqApprovalSource, assertCurrentMoqApproval } from '../moq/moqApprovalBasis';
/** Shared approval decision kernel. UI labels/scopes never replace decision ownership. */
import type { ApprovalRequest, PrismaClient, Prisma } from '@prisma/client';
import { approvalEventBus } from '../agent/events';
import { legacyAgentRoleForId } from '../auth/permissionService';
import { assertClaimDecisionAuthority, lockClaimRows, CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET } from '../claims/claimApprovalFact';
import { logger } from '../lib/logger';
import { isBusinessError } from '../shared/errorCodes';
import { CASH_REFUND_TARGET, CashRefundError, lockCashRefundByPaymentRequest, assertCashRefundDecisionFact } from '../claims/claimCashRefundFact';
import { isQuotationApproval, lockQuotationApprovalSource, lockQuotationSource, assertCurrentQuotationApproval } from '../quotations/quotationApprovalSnapshot';
import { approvalReviewContentVersion } from './approvalReviewContent';
export { approvalReviewContentVersion } from './approvalReviewContent';
import { createQuotationApprovalAmendmentService, type QuotationApprovalAmendment } from './quotationAmendmentService';
import { lockOrderChangeApprovalSource } from '../orderChanges/orderChangeFinalVersion';
import { lockReleaseSources } from '../production/releaseService';
import { persistApprovalResultReceipt, type ApprovalResultReceipt } from './approvalResultReceipt';
import { publishNotificationEvent } from '../realtime';
import { approvalReviewPreviewDigest, assertApprovalReviewReadyForDecision } from './approvalReviewDetailService';
import { lockAndAssertCurrentApprovalSignDocumentSnapshot } from './approvalSignDocumentSnapshotService';
import { assertPaymentRequestPayableApproval } from '../paymentRequests/paymentRequestPayableSource';

export const APPROVAL_NOT_ASSIGNED = 'APPROVAL_NOT_ASSIGNED';
export interface DecideActor {
  userId: string;
  roles: string[];
  roleIds?: string[];
  authorizationLoaded?: true;
  displayName?: string;
}
export interface DecideTargetApproval { reviewerId: string | null }
const BOSS_BYPASS_ROLES = ['owner'];
export type DecideOwnershipVerdict =
  | { ok: true }
  | { ok: false; code: typeof APPROVAL_NOT_ASSIGNED; message: string };

/** Preserve legacy null-reviewer / owner fallback; admin is never an ownership bypass. */
export function evaluateDecideOwnership(approval: DecideTargetApproval, actor: DecideActor): DecideOwnershipVerdict {
  if (!approval.reviewerId || approval.reviewerId === actor.userId
    || actor.roles.some(role => BOSS_BYPASS_ROLES.includes(role))) return { ok: true };
  return { ok: false, code: APPROVAL_NOT_ASSIGNED,
    message: `${APPROVAL_NOT_ASSIGNED}：本审批单已指派审批人，仅该审批人本人（或 BOSS 兜底）可决议` };
}

export class ApprovalDecisionError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string,
    readonly approval?: ApprovalRequest) { super(message); }
}
export type ApprovalDecision = 'approved' | 'rejected' | 'modified';
export type OnApprovalDecided = (approval: {
  id: string; actionType: string; targetType: string; targetId: string | null;
  status: 'approved' | 'rejected'; reviewerId: string; actualDecisionActor: string;
  decisionNote?: string;
}) => Promise<void>;
export type ApprovalSyncResult = {
  status: 'completed' | 'failed'; retryable: boolean; code?: 'APPROVAL_SYNC_FAILED';
};
type DecisionSource = 'api:approvals' | 'api:admin' | 'api:agent' | 'api:approvals-kernel';
export interface ApprovalDecisionInput {
  id: string; actor: DecideActor; decision: ApprovalDecision; source: DecisionSource;
  decisionNote?: string; ip?: string | null; mode?: 'normal' | 'boss'; bossReason?: string;
  reviewContentVersion?: string; reviewPreviewDigest?: string; confirmedReviewedContent?: boolean;
  quotationAmendment?: QuotationApprovalAmendment;
  modifiedInput?: Record<string, unknown>; reviewerActor?: Record<string, unknown>;
}
export interface CommittedApprovalDecision {
  updated: ApprovalRequest; existing: ApprovalRequest; decisionAuditId: string; actualDecisionActor: string;
  quotationAmendment?: Record<string, unknown>;
  resultReceipt?: ApprovalResultReceipt | null;
}
export type ApprovalDecisionServiceOptions = {
  onDecided?: OnApprovalDecided;
  quotationAmendmentService?: Pick<ReturnType<typeof createQuotationApprovalAmendmentService>, 'applyInTransaction'>;
};
const personSelect = { id: true, displayName: true, email: true } as const;
const detailObject = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const auditId = () => `alog_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const isClaimApproval = (approval: Pick<ApprovalRequest, 'actionType' | 'targetType'>) =>
  approval.actionType === CLAIM_APPROVAL_ACTION || approval.targetType === CLAIM_APPROVAL_TARGET;
function assertGenericDecisionAllowed(approval: Pick<ApprovalRequest, 'actionType'>): void {
  if (approval.actionType === 'supplier:commitment' || approval.actionType === 'order:main_approval')
    throw new ApprovalDecisionError('DOMAIN_APPROVAL_REQUIRED', 409, '本审批须按当前明确资格和准确冻结来源走原业务审批，不能通用特批、转派或修改批准。');
}

/** Lock before reading: the reviewer and complete domain snapshot must be the current row. */
async function lockedApproval(tx: Prisma.TransactionClient, id: string): Promise<ApprovalRequest> {
  await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${id} FOR UPDATE`;
  const approval = await tx.approvalRequest.findUnique({ where: { id } });
  if (!approval) throw new ApprovalDecisionError('NOT_FOUND', 404, `审批单 ${id} 不存在`);
  return approval;
}
/** Domain writes lock case → disposition → approval, so decisions use that same order. */
async function lockedDecisionApproval(tx: Prisma.TransactionClient, id: string): Promise<{ approval: ApprovalRequest; cashRefund: boolean }> {
  // Routing hint only; no permission or decision fact is taken from this unlocked read.
  const candidate = await tx.approvalRequest.findUnique({ where: { id },
    select: { requesterId: true, actionType: true, targetType: true, targetId: true, payload: true, status: true } });
  let lockedSignDocumentSnapshot: string | null = null;
  if (candidate?.status === 'pending' && (candidate.actionType === 'order:confirmation_sign'
    || candidate.actionType === 'contract:sign' || candidate.actionType === 'quotation:total_approve')) {
    try {
      const snapshot = await lockAndAssertCurrentApprovalSignDocumentSnapshot(tx, { id,
        actionType: candidate.actionType, targetType: candidate.targetType, targetId: candidate.targetId, payload: candidate.payload });
      lockedSignDocumentSnapshot = snapshot.contentFingerprint;
    } catch (error: any) {
      throw new ApprovalDecisionError(error?.code ?? 'APPROVAL_CONTENT_CHANGED', error?.statusCode ?? 409,
        String(error?.message ?? '签署冻结文档已变化，请重新提交签署。'));
    }
  }
  // Order change decisions share the native Order → request → lines → approval
  // lock order with apply/customer confirmation; a payload hash alone is not a
  // substitute for re-reading those persisted business facts.
  if (candidate?.status === 'pending' && candidate.actionType === 'order:change' && candidate.targetType === 'OrderChangeRequest'
    && !await lockOrderChangeApprovalSource(tx, id, candidate))
    throw new ApprovalDecisionError('ORDER_CHANGE_VERSION_MISMATCH', 409, '订单变更审批来源无法核验，请按当前订单版本重新申请');
  // These two native quotation actions lock their actual source before the
  // approval, matching quotation writers. Other domain lock orders are unchanged.
  const quotationId = candidate?.status === 'pending' ? await lockQuotationApprovalSource(tx, candidate) : null;
  let priceDeviationQuotationId: string | null = null;
  if (candidate?.status === 'pending' && candidate.actionType === 'quotation:price-deviation') {
    const payload = detailObject(candidate.payload);
    if (candidate.targetType !== 'Quotation' || !candidate.targetId || payload.quotationId !== candidate.targetId)
      throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409, '报价偏差审批缺少有效报价版本关联。');
    priceDeviationQuotationId = candidate.targetId;
    await lockQuotationSource(tx, priceDeviationQuotationId);
  }
  if (candidate?.status === 'pending' && candidate.actionType === 'order:dr013-exception') {
    if (candidate.targetType !== 'Dr013ExceptionRequest' || !candidate.targetId)
      throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409, '业务例外审批缺少当前例外申请关联。');
    await tx.$queryRaw`SELECT "id" FROM "Dr013ExceptionRequest" WHERE "id" = ${candidate.targetId} FOR UPDATE`;
  }
  if (candidate?.status === 'pending' && candidate.actionType === 'order:short-ship-exemption') {
    const payload = detailObject(candidate.payload);
    if (candidate.targetType !== 'OrderLine' || !candidate.targetId || !payload.shipmentId)
      throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409, '短装审批缺少订单行或出运单关联。');
    const lineHint = await tx.orderLine.findUnique({ where: { id: candidate.targetId }, select: { id: true, orderId: true } });
    if (!lineHint || lineHint.orderId !== payload.orderId)
      throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409, '短装审批关联的订单行已变化。');
    // Shipping writers serialize on the parent Order, then Shipment, then its
    // allocations. Keep that native order so the gate can safely re-read the
    // exact cross-shipment plan and tolerance before locking the approval.
    await lockReleaseSources(tx, [lineHint.orderId]);
    await tx.$queryRaw`SELECT "id" FROM "Shipment" WHERE "id" = ${payload.shipmentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ShipmentOrderAllocation" WHERE "orderLineId" = ${candidate.targetId} ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "OrderLine" WHERE "id" = ${candidate.targetId} FOR UPDATE`;
  }
  if (candidate?.status === 'pending') await lockMoqApprovalSource(tx, candidate);
  if (candidate && isClaimApproval(candidate)) {
    if (!candidate.targetId) throw new ApprovalDecisionError('VALIDATION_FAILED', 400, '索赔审批缺少处置目标');
    await lockClaimRows(tx, candidate.targetId);
  }
  let cashRefund = false;
  try {
    // Only the real Refund.paymentRequestId link can select this branch.
    // Ordinary supplier payments keep their own unchanged kernel contract.
    if (candidate?.targetType === CASH_REFUND_TARGET && candidate.targetId)
      cashRefund = !!await lockCashRefundByPaymentRequest(tx, candidate.targetId);
  } catch (error) {
    if (error instanceof CashRefundError) throw new ApprovalDecisionError(error.code, error.statusCode, error.message);
    throw error;
  }
  const approval = await lockedApproval(tx, id);
  if (!candidate || candidate.actionType !== approval.actionType || candidate.targetType !== approval.targetType
    || candidate.targetId !== approval.targetId) throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409,
    '审批目标已变化，请重新加载');
  if (lockedSignDocumentSnapshot) {
    const before = detailObject(candidate.payload).documentSnapshot;
    const after = detailObject(approval.payload).documentSnapshot;
    if (before?.contentFingerprint !== lockedSignDocumentSnapshot
      || after?.contentFingerprint !== lockedSignDocumentSnapshot
      || before?.sourceFingerprint !== after?.sourceFingerprint)
      throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '签署冻结内容在审批锁定期间已变化，请重新加载');
  }
  if (quotationId && isQuotationApproval(approval)) {
    assertPending(approval);
    if (JSON.stringify(candidate.payload) !== JSON.stringify(approval.payload))
      throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '审批内容已变化，请重新加载');
    await assertCurrentQuotationApproval(tx, approval, quotationId);
  }
  if (priceDeviationQuotationId && approval.actionType === 'quotation:price-deviation') {
    assertPending(approval);
    if (JSON.stringify(candidate.payload) !== JSON.stringify(approval.payload))
      throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '报价偏差审批内容已变化，请重新加载');
  }
  if (['order:dr013-exception', 'order:short-ship-exemption'].includes(approval.actionType)
    && JSON.stringify(candidate.payload) !== JSON.stringify(approval.payload))
    throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '原业务审批内容已变化，请重新加载');
  // A formerly resolved routing hint cannot be changed back into a pending
  // quotation decision without acquiring its source lock and reloading.
  if (!quotationId && isQuotationApproval(approval) && approval.status === 'pending')
    throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '审批状态已变化，请重新加载');
  if (cashRefund) {
    assertPending(approval);
    try { await assertCashRefundDecisionFact(tx, approval); }
    catch (error) {
      if (error instanceof CashRefundError) throw new ApprovalDecisionError(error.code, error.statusCode, error.message, approval);
      throw error;
    }
  }
  return { approval, cashRefund };
}
function assertPending(approval: ApprovalRequest) {
  if (approval.status !== 'pending') throw new ApprovalDecisionError('APPROVAL_ALREADY_RESOLVED', 409,
    `审批单已处理（${approval.status}），不可重复决策或转派`, approval);
}
function assertNotSelf(approval: ApprovalRequest, actor: DecideActor) {
  if (approval.requesterId === actor.userId) throw new ApprovalDecisionError('SELF_APPROVAL_FORBIDDEN', 403,
    '申请人不可审批自己的单子（自审禁止）');
}
function assertActor(actor: DecideActor) {
  if (!actor.userId) throw new ApprovalDecisionError('UNAUTHORIZED', 401, '审批决议需要真实登录主体');
}
/** Full snapshot predicate is defense in depth; every decision writer must use this kernel. */
function snapshotWhere(approval: ApprovalRequest): Prisma.ApprovalRequestWhereInput {
  return { id: approval.id, status: 'pending', reviewerId: approval.reviewerId,
    requesterId: approval.requesterId, actionType: approval.actionType,
    targetType: approval.targetType, targetId: approval.targetId,
    payload: { equals: approval.payload as Prisma.InputJsonValue } };
}
async function currentAuthority(tx: Prisma.TransactionClient, actor: DecideActor): Promise<{
  userId: string; roleIds: string[]; roles: string[]; authorizationLoaded: true;
}> {
  const assignments = await tx.userRole.findMany({ where: { userId: actor.userId }, select: { roleId: true } });
  const roleIds = [...new Set(assignments.map(assignment => assignment.roleId))].sort();
  const roles = [...new Set(roleIds.map(legacyAgentRoleForId).filter((role): role is NonNullable<typeof role> => Boolean(role)))];
  return { userId: actor.userId, roleIds, roles, authorizationLoaded: true as const };
}

export function createApprovalDecisionService(prisma: PrismaClient, options: ApprovalDecisionServiceOptions = {}) {
  const quotationAmendmentService = options.quotationAmendmentService
    ?? createQuotationApprovalAmendmentService({ prisma });
  async function deliver(approval: ApprovalRequest, actualDecisionActor: string, decisionAuditId: string): Promise<ApprovalSyncResult | undefined> {
    if (!options.onDecided || (approval.status !== 'approved' && approval.status !== 'rejected')) return undefined;
    try {
      // A transaction-scoped advisory lock serializes delivery across routes/processes.
      // It locks only the delivery key, so callbacks may acquire their domain row locks.
      await prisma.$transaction(async tx => {
        const deliveryKey = `approval-delivery:${approval.id}:${decisionAuditId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${deliveryKey}, 0))`;
        const completed = await tx.auditLog.findFirst({ where: { action: 'approval_sync_completed',
          targetType: 'ApprovalRequest', targetId: approval.id,
          detail: { path: ['decisionAuditId'], equals: decisionAuditId } } });
        if (completed) return;
        // Projection must also be idempotent: its commit can precede a delivery-log outage.
        await options.onDecided!({ id: approval.id, actionType: approval.actionType,
          targetType: approval.targetType, targetId: approval.targetId,
          status: approval.status as 'approved' | 'rejected',
          reviewerId: actualDecisionActor, actualDecisionActor, decisionNote: approval.decisionNote || undefined });
        await tx.auditLog.create({ data: { id: auditId(), actorId: actualDecisionActor,
          action: 'approval_sync_completed', targetType: 'ApprovalRequest', targetId: approval.id,
          detail: { approvalId: approval.id, decisionAuditId } } });
      }, { timeout: 30_000 });
      return { status: 'completed', retryable: false };
    } catch (error: any) {
      logger.error('[ApprovalDecision] committed decision sync failed', { approvalId: approval.id, error: error?.message });
      // A delivery-log outage cannot pretend the committed decision failed or expose SQL internals.
      await prisma.auditLog.create({ data: { id: auditId(), actorId: actualDecisionActor,
        action: 'approval_sync_failed', targetType: 'ApprovalRequest', targetId: approval.id,
        detail: { approvalId: approval.id, decisionAuditId, code: 'APPROVAL_SYNC_FAILED' } } })
        .catch((auditError: any) => logger.error('[ApprovalDecision] sync failure audit failed', { approvalId: approval.id, error: auditError?.message }));
      return { status: 'failed', retryable: true, code: 'APPROVAL_SYNC_FAILED' };
    }
  }

  async function decideInTransaction(tx: Prisma.TransactionClient, input: ApprovalDecisionInput): Promise<CommittedApprovalDecision> {
    try {
      assertActor(input.actor);
      const mode = input.mode ?? 'normal';
      const { approval: existing, cashRefund } = await lockedDecisionApproval(tx, input.id);
      assertGenericDecisionAllowed(existing);
      assertPending(existing);
      const requiresReviewBinding = input.source === 'api:approvals'
        || (input.source === 'api:approvals-kernel' && mode === 'boss');
      if (requiresReviewBinding) {
        const currentReviewVersion = approvalReviewContentVersion(existing);
        if (!input.reviewContentVersion || input.reviewContentVersion !== currentReviewVersion)
          throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409, '审批依据已变化，请重新加载并核对最终版本。', existing);
        if (input.decision === 'approved' && input.confirmedReviewedContent !== true)
          throw new ApprovalDecisionError('REVIEW_CONFIRMATION_REQUIRED', 400, '批准前必须确认已核对本次申请内容。', existing);
      }
      if (input.decision === 'approved') await assertPaymentRequestPayableApproval(tx, existing, input.actor);
      if (input.source === 'api:approvals' && input.decision === 'approved') {
        await assertApprovalReviewReadyForDecision(tx, existing, input.actor);
        if (['Quotation', 'OrderConfirmation', 'Contract'].includes(existing.targetType)) {
          const currentPreviewDigest = approvalReviewPreviewDigest(existing);
          if (!input.reviewPreviewDigest || !/^[a-f0-9]{64}$/.test(input.reviewPreviewDigest)
            || input.reviewPreviewDigest !== currentPreviewDigest)
            throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409,
              '签署预览与审批冻结内容不一致，请重新加载冻结申请预览。', existing);
        }
        if (existing.actionType === 'development:fee') {
          if (existing.targetType !== 'BillingItem')
            throw new ApprovalDecisionError('APPROVAL_CONTENT_CHANGED', 409, '开发收费审批目标不是当前收费记录。', existing);
          // Approving the frozen proposal needs only the regular review-version
          // binding. A modified proposal must carry the exact read-only preview
          // digest; the domain adapter recomputes that digest under its locks.
          if (input.modifiedInput !== undefined) {
            const modified = detailObject(input.modifiedInput);
            const keys = Object.keys(modified).sort();
            if (keys.join(',') !== 'amount,reason,waivedAmount'
              || typeof modified.amount !== 'string' || typeof modified.waivedAmount !== 'string'
              || typeof modified.reason !== 'string' || !modified.reason.trim()
              || !Number.isFinite(Number(modified.amount)) || Number(modified.amount) < 0
              || !Number.isFinite(Number(modified.waivedAmount)) || Number(modified.waivedAmount) < 0
              || !input.reviewPreviewDigest || !/^[a-f0-9]{64}$/.test(input.reviewPreviewDigest))
              throw new ApprovalDecisionError('VALIDATION_FAILED', 400,
                '开发收费修改批准必须绑定只读最终提案预览，并且只可修改拟收金额、减免金额和理由。', existing);
          }
        } else if (input.modifiedInput && input.source === 'api:approvals') {
          throw new ApprovalDecisionError('VALIDATION_FAILED', 400, '该审批类型不能提交修改后批准字段。', existing);
        }
      }
      if (isMoqExemptionApproval(existing) && input.decision !== 'rejected') {
        if (input.decision !== 'approved') throw new ApprovalDecisionError('VALIDATION_FAILED', 400, 'MOQ 豁免只接受通过或驳回；依据变化须重新申请');
        await assertCurrentMoqApproval(tx, existing);
      }
      if (existing.actionType === 'quotation:total_approve' && existing.targetType === 'Quotation') {
        if (!existing.targetId) throw new ApprovalDecisionError('VALIDATION_FAILED', 400, '报价审批缺少目标，请重新提交。');
        const currentHead = await resolveQuotationBusinessLeader(tx, existing.targetId);
        if (currentHead.reviewerId !== input.actor.userId)
          throw new ApprovalDecisionError('FORBIDDEN', 403, '报价须由当前对应业务负责人审批，请核对团队归属后重新提交。');
      }
      const selfConfirmed = existing.requesterId === input.actor.userId
        && mode === 'normal' && input.decision === 'approved'
        && await canSelfConfirmQuotation(tx, existing, input.actor.userId);
      if (!selfConfirmed) assertNotSelf(existing, input.actor);
      if (existing.actionType === 'quotation:total_approve' && input.decision === 'rejected' && !input.decisionNote?.trim())
        throw new ApprovalDecisionError('VALIDATION_FAILED', 400, '退回报价须填写原因。');
      if (isClaimApproval(existing) && input.decision === 'modified')
        throw new ApprovalDecisionError('VALIDATION_FAILED', 400, '售后处置审批只接受通过或驳回');
      if (cashRefund && input.decision === 'modified')
        throw new ApprovalDecisionError('VALIDATION_FAILED', 400, '客户退款审批只接受通过或驳回；收款方或金额变化须重新提交');
      // Privileged ownership/boss exceptions require current canonical DB roles, even for
      // old compatible JWTs without a loaded authorization marker.
      let authority = await currentAuthority(tx, input.actor);
      if (mode === 'normal') {
        const ownership = evaluateDecideOwnership(existing, { ...input.actor, roles: authority.roles });
        if (!ownership.ok) throw new ApprovalDecisionError(ownership.code, 403, ownership.message);
      } else if (input.decision !== 'approved' || (input.bossReason?.trim().length ?? 0) < 30) {
        throw new ApprovalDecisionError('VALIDATION_FAILED', 400, 'bossFinalBypassReason 至少 30 字');
      }
      if (isClaimApproval(existing)) authority = await assertClaimDecisionAuthority(tx, existing, input.actor, mode);
      if (mode === 'boss' && !authority.roles.includes('owner'))
        throw new ApprovalDecisionError('BOSS_BYPASS_REQUIRES_OWNER', 403,
          'BOSS_BYPASS_REQUIRES_OWNER：仅超级管理员（BOSS）可最终兜底特批');
      if (input.quotationAmendment && (input.decision !== 'approved' || input.source !== 'api:approvals'
        || mode !== 'normal' || !isQuotationApproval(existing)))
        throw new ApprovalDecisionError('VALIDATION_FAILED', 400,
          '报价修订只允许在当前条目/总价审批的原生确认流程中提交');
      const quotationAmendment = input.quotationAmendment
        ? await quotationAmendmentService.applyInTransaction(tx, existing, input.actor.userId,
          input.quotationAmendment, input.reviewContentVersion!)
        : undefined;
      const now = new Date();
      const note = mode === 'boss' ? `[BOSS_FINAL_BYPASS] ${input.bossReason!.trim()}`
        : input.decisionNote || (input.quotationAmendment ? `修订并批准：${input.quotationAmendment.reason.trim()}` : undefined);
      const data: Prisma.ApprovalRequestUpdateManyMutationInput = {
        status: input.decision, decisionNote: note || null, decidedAt: now,
        ...(mode === 'boss' ? { bossFinalBypassBy: input.actor.userId, bossFinalBypassAt: now,
          bossFinalBypassReason: input.bossReason!.trim() } : { reviewerId: input.actor.userId }),
      };
      if (input.source === 'api:agent') data.payload = { ...detailObject(existing.payload), resolution: {
        decision: input.decision, decisionNote: note || null,
        ...(input.decision === 'modified' && input.modifiedInput ? { modifiedInput: input.modifiedInput } : {}),
        reviewerId: input.actor.userId, reviewerDisplayName: input.actor.displayName ?? null,
        decidedAt: now.toISOString(),
      } } as Prisma.InputJsonValue;
      const changed = await tx.approvalRequest.updateMany({ where: snapshotWhere(existing), data });
      if (changed.count !== 1) throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '审批内容或指派人已变化，请重新加载');
      const detail: Record<string, any> = { source: input.source, actionType: existing.actionType,
        decisionActorAuthority: authority,
        ...(selfConfirmed ? { selfConfirmed: true } : {}),
        approvalDecisionFact: { schemaVersion: 1, status: input.decision, actionType: existing.actionType,
          targetType: existing.targetType, targetId: existing.targetId,
          contentFingerprint: detailObject(existing.payload).contentFingerprint ?? null,
          reviewContentVersion: requiresReviewBinding ? input.reviewContentVersion : null,
          frozenReviewerId: requiresReviewBinding ? existing.reviewerId : null,
          reviewPreviewDigest: ['Quotation', 'OrderConfirmation', 'Contract'].includes(existing.targetType)
            || existing.actionType === 'development:fee'
            ? input.reviewPreviewDigest ?? null : null,
          reviewedContentConfirmed: input.decision === 'approved' ? input.confirmedReviewedContent === true : null,
          ...(['order:confirmation_sign', 'contract:sign', 'quotation:total_approve'].includes(existing.actionType) ? (() => {
            const amendedSnapshot = quotationAmendment?.finalDocumentSnapshot;
            const snapshot = amendedSnapshot ?? detailObject(existing.payload).documentSnapshot;
            return { documentSnapshot: { kind: snapshot?.kind ?? null, sourceRef: snapshot?.sourceRef ?? null,
              templateVersion: snapshot?.templateVersion ?? null, sourceFingerprint: snapshot?.sourceFingerprint ?? null,
              contentFingerprint: snapshot?.contentFingerprint ?? null,
              ...(quotationAmendment ? { amendmentAuditId: quotationAmendment.amendmentAuditId ?? null } : {}) } };
          })() : {}),
          ...(existing.actionType === 'development:fee' && input.decision === 'approved' && input.modifiedInput
            ? { modifiedInput: input.modifiedInput } : {}),
          ...(quotationAmendment ? { finalContentVersion: quotationAmendment.finalContentVersion,
            finalQuotationFingerprint: quotationAmendment.finalFingerprint,
            finalQuotationVersion: quotationAmendment.finalVersion,
            quotationAmendmentAuditId: quotationAmendment.amendmentAuditId } : {}),
          decisionActorId: input.actor.userId, decidedAt: now.toISOString() },
      };
      if (quotationAmendment) {
        detail.quotationAmendment = quotationAmendment;
        detail.quotationAmendmentAuditId = quotationAmendment.amendmentAuditId;
      }
      let action: string;
      if (mode === 'boss') { action = 'boss_final_bypass'; Object.assign(detail, {
        originalReviewerId: existing.reviewerId, bossFinalBypassReason: input.bossReason!.trim() });
      } else if (input.source === 'api:agent') {
        action = `agent_approval_${input.decision}`;
        Object.assign(detail, { approvalId: existing.id, risk: existing.risk, decision: input.decision,
          decisionNote: note || null, reviewerActor: input.reviewerActor ?? null,
          ...(input.decision === 'modified' && input.modifiedInput ? { modifiedInput: input.modifiedInput } : {}) });
      } else if (input.source === 'api:admin') {
        action = input.decision === 'approved' ? 'approve' : 'reject'; detail.decisionNote = note || null;
      } else { action = input.decision === 'approved' ? 'approve_business_request' : 'reject_business_request';
        Object.assign(detail, { targetEntity: { type: existing.targetType, id: existing.targetId }, decisionNote: note || null });
      }
      const decisionAuditId = auditId();
      // Mandatory audit is part of the same atomic transaction as the decision.
      await tx.auditLog.create({ data: { id: decisionAuditId, actorId: input.actor.userId, action,
        targetType: input.source === 'api:agent' ? existing.targetType : 'ApprovalRequest',
        targetId: input.source === 'api:agent' ? existing.targetId || existing.id : existing.id,
        detail, ip: input.ip ?? null, operationType: 'transition', fieldPath: 'status',
        beforeValue: 'pending', afterValue: input.decision, transactionId: null } });
      const updated = await tx.approvalRequest.findUniqueOrThrow({ where: { id: existing.id },
        ...(input.source === 'api:approvals' ? { include: { requester: { select: personSelect }, reviewer: { select: personSelect } } } : {}) });
      const resultReceipt = await persistApprovalResultReceipt(tx, updated, decisionAuditId);
      return { updated, existing, decisionAuditId, actualDecisionActor: input.actor.userId, quotationAmendment, resultReceipt };
    } catch (error: unknown) {
      if (isBusinessError(error) && !(error instanceof ApprovalDecisionError))
        throw new ApprovalDecisionError(error.code, error.statusCode, String(error.message ?? error.code));
      throw error;
    }
  }

  async function publishCommittedDecision(committed: CommittedApprovalDecision, input: ApprovalDecisionInput) {
    // This code cannot run until both decision and mandatory audit have committed.
    let eventDelivery: { status: 'failed'; retryable: false; code: 'APPROVAL_EVENT_DELIVERY_FAILED' } | undefined;
    try {
      approvalEventBus.emit('resolved', committed.updated.id, {
        decision: input.decision, decisionNote: committed.updated.decisionNote || undefined,
        ...(input.source === 'api:agent' ? { modifiedInput: input.decision === 'modified' ? input.modifiedInput : undefined } : {}),
      });
    } catch (error: any) {
      logger.error('[ApprovalDecision] committed event listener failed', { approvalId: committed.updated.id, error: error?.message });
      eventDelivery = { status: 'failed', retryable: false, code: 'APPROVAL_EVENT_DELIVERY_FAILED' };
    }
    const receipt = committed.resultReceipt;
    if (receipt?.created) {
      try {
        publishNotificationEvent({ type: receipt.type, title: receipt.title, body: receipt.body,
          level: receipt.level, eventId: receipt.id, eventType: receipt.type,
          recipientIds: [receipt.userId], metadata: receipt.metadata });
      } catch (error: any) {
        // The durable Notification row committed with the decision; only this live nudge was lost.
        logger.warn('[ApprovalDecision] receipt SSE delivery failed', { approvalId: committed.updated.id, error: error?.message });
      }
    }
    const sync = await deliver(committed.updated, committed.actualDecisionActor, committed.decisionAuditId);
    return { ...committed, sync, eventDelivery };
  }

  async function decide(input: ApprovalDecisionInput) {
    const committed = await prisma.$transaction(tx => decideInTransaction(tx, input));
    return publishCommittedDecision(committed, input);
  }

  async function delegate(input: { id: string; actor: DecideActor; toUserId: string; reason: string; ip?: string | null }) {
    assertActor(input.actor);
    if (!input.toUserId.trim() || input.reason.trim().length < 10)
      throw new ApprovalDecisionError('VALIDATION_FAILED', 400, 'toUserId 必填且 delegateReason 至少 10 字');
    return prisma.$transaction(async tx => {
      const { approval: existing } = await lockedDecisionApproval(tx, input.id);
      assertGenericDecisionAllowed(existing);
      assertPending(existing);
      if (existing.reviewerId !== input.actor.userId) throw new ApprovalDecisionError('DELEGATION_NOT_BY_REVIEWER', 403,
        'DELEGATION_NOT_BY_REVIEWER：仅当前审批人本人可发起转派');
      if (input.toUserId === input.actor.userId) throw new ApprovalDecisionError('VALIDATION_FAILED', 400, 'toUserId 与当前审批人相同，无需转派');
      if (input.toUserId === existing.requesterId) throw new ApprovalDecisionError('SELF_APPROVAL_FORBIDDEN', 403, '禁止转派给申请人本人（会形成自审）');
      const target = await tx.userAccount.findFirst({ where: { id: input.toUserId, status: 'active', deletedAt: null }, select: { id: true } });
      if (!target) throw new ApprovalDecisionError('VALIDATION_FAILED', 400, 'toUserId 用户不存在或已停用');
      const now = new Date();
      const changed = await tx.approvalRequest.updateMany({ where: snapshotWhere(existing), data: {
        delegatedBy: existing.reviewerId, delegatedAt: now, delegateReason: input.reason, reviewerId: input.toUserId } });
      if (changed.count !== 1) throw new ApprovalDecisionError('APPROVAL_CONCURRENT_CHANGE', 409, '审批内容或指派人已变化，请重新加载');
      await tx.auditLog.create({ data: { id: auditId(), actorId: input.actor.userId, action: 'delegate_approval',
        targetType: 'ApprovalRequest', targetId: existing.id, detail: { source: 'api:approvals-kernel',
          actionType: existing.actionType, delegatedTo: input.toUserId, delegateReason: input.reason }, ip: input.ip ?? null,
        operationType: 'transition', fieldPath: 'reviewerId', beforeValue: existing.reviewerId ?? undefined,
        afterValue: input.toUserId, transactionId: null } });
      return tx.approvalRequest.findUniqueOrThrow({ where: { id: existing.id } });
    });
  }

  async function retrySync(id: string, actor: DecideActor): Promise<{ item: ApprovalRequest; sync: ApprovalSyncResult }> {
    assertActor(actor);
    if (!options.onDecided) throw new ApprovalDecisionError('APPROVAL_SYNC_UNAVAILABLE', 409, '未配置审批业务同步');
    const committed = await prisma.$transaction(async tx => {
      const item = await lockedApproval(tx, id);
      if ((item.status !== 'approved' && item.status !== 'rejected') || !item.decidedAt)
        throw new ApprovalDecisionError('APPROVAL_NOT_DECIDED', 409, '只能补同步已提交的审批决议');
      const actualActor = item.bossFinalBypassBy || item.reviewerId;
      const authority = await currentAuthority(tx, actor);
      if (!actualActor || (actor.userId !== actualActor && !authority.roles.includes('owner')))
        throw new ApprovalDecisionError(APPROVAL_NOT_ASSIGNED, 403, '仅真实决议人或 BOSS 可补同步');
      const audits = await tx.auditLog.findMany({ where: { OR: [{ targetType: 'ApprovalRequest', targetId: id },
        { detail: { path: ['approvalId'], equals: id } }] }, orderBy: { createdAt: 'asc' } });
      const facts = audits.filter(audit => { const fact = detailObject(audit.detail).approvalDecisionFact;
        return fact?.schemaVersion === 1 && audit.actorId === actualActor && fact.decisionActorId === actualActor
          && fact.status === item.status && fact.actionType === item.actionType && fact.targetType === item.targetType
          && fact.targetId === item.targetId && fact.decidedAt === item.decidedAt!.toISOString()
          && fact.contentFingerprint === (detailObject(item.payload).contentFingerprint ?? null); });
      if (facts.length !== 1) throw new ApprovalDecisionError('APPROVAL_DECISION_FACT_MISSING', 409, '找不到唯一匹配的已提交决议事实，不能补同步');
      const decisionAuditId = facts[0].id;
      const complete = audits.some(audit => audit.action === 'approval_sync_completed'
        && detailObject(audit.detail).decisionAuditId === decisionAuditId);
      return { item, actualActor, decisionAuditId, complete };
    });
    const sync = committed.complete ? { status: 'completed' as const, retryable: false }
      : (await deliver(committed.item, committed.actualActor, committed.decisionAuditId))!;
    return { item: committed.item, sync };
  }
  return { decide, decideInTransaction, publishCommittedDecision, delegate, retrySync };
}
