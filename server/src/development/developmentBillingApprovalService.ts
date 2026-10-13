import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canonicalClaimJson } from '../claims/claimApprovalFact';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';
import { assertDevelopmentExpenseReviewCurrentInTx } from './developmentClosureService';
import { bindDevelopmentBillingCoverageInTx } from './developmentBillingCoverageService';
import { developmentBillingReviewTaskId, snapshotDevelopmentBillingItem } from './developmentBillingWorkflowService';
import { writeRouteAuditLog } from '../audit/routeAudit';

type FinalInput = { amount: string; waivedAmount: string; reason: string };
type ApprovalDecider = { decideInTransaction: (tx: any, input: any) => Promise<any> };
type PreviewInput = { approvalId: string; actorId: string; reviewContentVersion: string; finalInput: unknown };
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const digest = (value: unknown) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');
function fail(code: string, message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { code, status: statusCode, httpStatus: statusCode, statusCode });
}
function exactMoney(value: unknown, label: string): string {
  let parsed: Prisma.Decimal;
  try { parsed = new Prisma.Decimal(String(value)); } catch { return fail('INVALID_AMOUNT', `${label}无效`, 400); }
  if (!parsed.isFinite() || parsed.lt(0) || !parsed.eq(parsed.toDecimalPlaces(4)) || parsed.gte('100000000000000'))
    return fail('INVALID_AMOUNT', `${label}须为非负、最多四位小数的有效金额`, 400);
  return parsed.toString();
}
function normalizeFinalInput(value: unknown): FinalInput {
  const raw = object(value);
  if (Object.keys(raw).sort().join(',') !== 'amount,reason,waivedAmount')
    return fail('INVALID_INPUT', '最终调整只允许填写拟收金额、减免金额和调整理由', 400);
  const amount = exactMoney(raw.amount, '最终拟收金额');
  const waivedAmount = exactMoney(raw.waivedAmount, '最终减免金额');
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 10 || reason.length > 1000) fail('INVALID_INPUT', '调整理由至少 10 字且不超过 1000 字', 400);
  if (new Prisma.Decimal(waivedAmount).gt(amount)) fail('INVALID_AMOUNT', '减免金额不能超过拟收金额', 400);
  return { amount, waivedAmount, reason };
}
function normalizeStoredFinalInput(value: any): FinalInput {
  return { amount: exactMoney(value?.amount, '拟收金额'), waivedAmount: exactMoney(value?.waivedAmount, '减免金额'),
    reason: typeof value?.reason === 'string' ? value.reason : '' };
}
function frozenContentFingerprint(payload: Record<string, any>): boolean {
  const { contentFingerprint, ...content } = payload;
  return digest(content) === contentFingerprint;
}
const itemVersion = (item: any) => Number(item.developmentWorkflowVersion ?? 0);

/** The same deterministic digest is used by preview, the locked write adapter, and the approval kernel. */
export function developmentFeeFinalProposalDigest(input: {
  approval: any; billingItem: any; expenseReview: any; reviewContentVersion: string; finalInput: FinalInput;
}): string {
  const { approval, billingItem: item, expenseReview: review, reviewContentVersion, finalInput } = input;
  const payload = object(approval.payload);
  return digest({
    schemaVersion: 1,
    purpose: 'development-fee-final-proposal',
    approval: { id: approval.id, requesterId: approval.requesterId, reviewerId: approval.reviewerId,
      actionType: approval.actionType, targetType: approval.targetType, targetId: approval.targetId,
      status: approval.status, reviewContentVersion },
    source: {
      billingItemId: item.id, caseId: item.sourceId, sourceType: item.sourceType, chargeType: item.chargeType,
      status: item.status, workflowState: item.developmentWorkflowState, workflowVersion: itemVersion(item),
      approvalId: item.developmentApprovalId ?? null, amount: String(item.amount), waivedAmount: String(item.waivedAmount),
      offsetAmount: String(item.offsetAmount), currency: item.currency, bearerType: item.bearerType,
      bearerRelationId: item.bearerRelationId ?? null, bearerName: item.bearerName ?? null,
      expenseReviewId: item.developmentExpenseReviewId ?? null,
    },
    expenseReview: { id: review.id, fingerprint: review.fingerprint,
      snapshotDigest: digest(review.snapshot), lifecycleEventId: review.lifecycleEventId },
    frozenProposal: { contentFingerprint: payload.contentFingerprint, amount: String(payload.amount),
      waivedAmount: String(payload.waivedAmount), currency: payload.currency, expenseReviewId: payload.expenseReviewId,
      workflowVersion: payload.workflowVersion },
    finalInput,
  });
}

async function loadCurrentSource(tx: any, approval: any, actorId: string, expectedReviewVersion: string, lock = false) {
  if (!approval || approval.status !== 'pending' || approval.actionType !== 'development:fee'
    || approval.targetType !== 'BillingItem' || !approval.targetId) fail('APPROVAL_NOT_FOUND', '开发费用审批不存在', 404);
  if (approval.requesterId === actorId) fail('SELF_APPROVAL_FORBIDDEN', '申请人不可审批自己的收费方案', 403);
  if (approval.reviewerId && approval.reviewerId !== actorId) {
    const assignments = await tx.userRole.findMany({ where: { userId: actorId }, select: { roleId: true } });
    const { legacyAgentRoleForId } = await import('../auth/permissionService');
    const roles = [...new Set(assignments.map((row: any) => legacyAgentRoleForId(row.roleId)).filter(Boolean))];
    if (!roles.includes('owner')) fail('APPROVAL_NOT_ASSIGNED', '仅当前审批人或 BOSS 兜底可预览并决议本次收费方案', 403);
  }
  const reviewVersion = approvalReviewContentVersion(approval);
  if (!reviewVersion || reviewVersion !== expectedReviewVersion) fail('APPROVAL_CONTENT_CHANGED', '收费审批依据已变化，请重新读取并核对');
  const payload = object(approval.payload);
  if (payload.schemaVersion !== 1 || payload.kind !== 'development_fee' || payload.billingItemId !== approval.targetId
    || typeof payload.caseId !== 'string' || !payload.caseId || !Number.isSafeInteger(payload.workflowVersion)
    || !frozenContentFingerprint(payload) || typeof payload.financeUserId !== 'string' || !payload.financeUserId
    || typeof payload.reason !== 'string' || payload.reason.trim().length < 1
    || typeof payload.expenseReviewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expenseReviewFingerprint))
    fail('APPROVAL_CONTENT_CHANGED', '收费审批缺少可核验的开发来源或版本');
  if (lock) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${payload.caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${approval.targetId} FOR UPDATE`);
  }
  const item = await tx.billingItem.findFirst({ where: { id: approval.targetId, sourceType: 'DevelopmentCase', sourceId: payload.caseId, deletedAt: null } });
  if (!item || item.chargeType !== 'development_fee' || item.status !== 'draft'
    || item.developmentWorkflowState !== 'approval_pending' || item.developmentApprovalId !== approval.id
    || itemVersion(item) !== payload.workflowVersion || item.developmentExpenseReviewId !== payload.expenseReviewId
    || !new Prisma.Decimal(item.amount).eq(payload.amount) || !new Prisma.Decimal(item.waivedAmount).eq(payload.waivedAmount)
    || item.currency !== payload.currency || item.bearerType !== 'customer' || payload.bearerType !== 'customer'
    || item.bearerRelationId !== payload.bearerRelationId || item.bearerName !== payload.bearerName
    || !new Prisma.Decimal(item.offsetAmount).isZero() || typeof payload.financeUserId !== 'string')
    fail('BILLING_CHANGED', '当前收费方案、客户承担方或审批申请版本已变化，不能沿用原领导审批', 409);
  const review = await assertDevelopmentExpenseReviewCurrentInTx(tx, payload.caseId, payload.expenseReviewId);
  if (review.fingerprint !== payload.expenseReviewFingerprint) fail('REVIEW_STALE', '费用核齐依据已变化，请重新核齐后提交');
  return { payload, item, review, reviewVersion };
}

function previewFromSource(approval: any, source: { payload: any; item: any; review: any; reviewVersion: string }, rawFinalInput: unknown) {
  const finalInput = normalizeFinalInput(rawFinalInput);
  const before = { amount: new Prisma.Decimal(source.item.amount).toString(),
    waivedAmount: new Prisma.Decimal(source.item.waivedAmount).toString() };
  const diff = [
    ...(new Prisma.Decimal(before.amount).eq(finalInput.amount) ? [] : [{ field: 'amount', before: before.amount, after: finalInput.amount }]),
    ...(new Prisma.Decimal(before.waivedAmount).eq(finalInput.waivedAmount) ? [] : [{ field: 'waivedAmount', before: before.waivedAmount, after: finalInput.waivedAmount }]),
  ];
  if (!diff.length) fail('INVALID_INPUT', '修改后的拟收费与当前方案相同，无需走修改批准预览');
  const previewDigest = developmentFeeFinalProposalDigest({ approval, billingItem: source.item, expenseReview: source.review,
    reviewContentVersion: source.reviewVersion, finalInput });
  return { approvalId: approval.id, reviewContentVersion: source.reviewVersion,
    sourceBillingItemVersion: itemVersion(source.item), finalInput, diff, previewDigest };
}

export async function previewDevelopmentBillingFinalProposal(prisma: PrismaClient, input: PreviewInput & {
  authorizeBusiness: (tx: any, caseId: string) => Promise<unknown>;
}) {
  return (prisma as any).$transaction(async (tx: any) => {
    const approval = await tx.approvalRequest.findUnique({ where: { id: input.approvalId } });
    if (!approval) fail('APPROVAL_NOT_FOUND', '开发费用审批不存在', 404);
    const caseId = object(approval.payload).caseId;
    if (typeof caseId !== 'string' || !caseId) fail('APPROVAL_CONTENT_CHANGED', '审批缺少开发来源');
    await input.authorizeBusiness(tx, caseId);
    const source = await loadCurrentSource(tx, approval, input.actorId, input.reviewContentVersion);
    return previewFromSource(approval, source, input.finalInput);
  });
}

export async function decideDevelopmentBillingApproval(input: {
  prisma: PrismaClient; decisionService: ApprovalDecider; approvalId: string; actor: any; status: 'approved' | 'rejected';
  decisionNote?: string; reviewContentVersion: string; confirmedReviewedContent: boolean; modifiedInput?: unknown;
  reviewPreviewDigest?: string; ip?: string | null;
  authorizeBusiness: (tx: any, caseId: string) => Promise<unknown>;
  authorizeRecipient: (tx: any, caseId: string, userId: string) => Promise<unknown>;
}) {
  const prisma: any = input.prisma;
  const committed = await prisma.$transaction(async (tx: any) => {
    const hint = await tx.approvalRequest.findUnique({ where: { id: input.approvalId } });
    if (!hint || hint.actionType !== 'development:fee') fail('APPROVAL_NOT_FOUND', '开发费用审批不存在', 404);
    const hintCaseId = object(hint.payload).caseId;
    if (typeof hintCaseId !== 'string' || !hintCaseId) fail('APPROVAL_CONTENT_CHANGED', '审批缺少开发来源');
    await input.authorizeBusiness(tx, hintCaseId);
    const { payload, item, review, reviewVersion } = await loadCurrentSource(tx, hint, input.actor.userId, input.reviewContentVersion, true);

    let finalInput = normalizeStoredFinalInput({ amount: payload.amount, waivedAmount: payload.waivedAmount, reason: payload.reason });
    let previewDigest: string | undefined;
    if (input.status === 'approved' && input.modifiedInput !== undefined) {
      const preview = previewFromSource(hint, { payload, item, review, reviewVersion }, input.modifiedInput);
      if (!input.reviewPreviewDigest || input.reviewPreviewDigest !== preview.previewDigest)
        fail('DEVELOPMENT_FEE_PREVIEW_STALE', '最终修改预览已变化，请重新预览并核对', 409);
      finalInput = preview.finalInput;
      previewDigest = preview.previewDigest;
    } else if (input.status === 'approved') {
      // Older readers may send the frozen detail digest for an unchanged approval.
      // It is not a final-proposal binding and must not be recorded as one.
    } else if (input.modifiedInput !== undefined || input.reviewPreviewDigest !== undefined) {
      fail('INVALID_INPUT', '最终修改预览仅可随通过决议提交');
    }
    if (input.status === 'approved') await input.authorizeRecipient(tx, hintCaseId, String(payload.financeUserId));

    const decisionInput = { id: input.approvalId, actor: input.actor, decision: input.status, source: 'api:approvals',
      decisionNote: input.decisionNote, ip: input.ip ?? null, reviewContentVersion: input.reviewContentVersion,
      confirmedReviewedContent: input.confirmedReviewedContent,
      ...(previewDigest ? { modifiedInput: finalInput, reviewPreviewDigest: previewDigest } : {}) };
    const decision = await input.decisionService.decideInTransaction(tx, decisionInput);
    const version = itemVersion(item) + 1, now = BigInt(Date.now()), before = {
      workflowState: item.developmentWorkflowState, workflowVersion: itemVersion(item), approvalId: item.developmentApprovalId,
      expenseReviewId: item.developmentExpenseReviewId, amount: String(item.amount), waivedAmount: String(item.waivedAmount), currency: item.currency,
      customerRelationId: item.bearerRelationId,
    };
    let taskId: string | null = null;
    let assignment: any;
    let itemData: any;
    if (input.status === 'approved') {
      const activeCoverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: item.id, releasedAt: null } });
      for (const cost of activeCoverage) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${cost.costRecordId} FOR UPDATE`);
      if (activeCoverage.length) await tx.billingItemCostCoverage.updateMany({ where: { billingItemId: item.id, releasedAt: null },
        data: { releasedAt: now, releaseReason: `领导批准后改为第 ${version} 轮财务核对覆盖` } });
      await bindDevelopmentBillingCoverageInTx(tx, { prisma, actorId: input.actor.userId,
        authorize: (inner: any, caseId: string) => input.authorizeBusiness(inner, caseId) },
      { caseId: hintCaseId, billingItemId: item.id, reviewId: payload.expenseReviewId, submissionVersion: version });
      itemData = { amount: new Prisma.Decimal(finalInput.amount), waivedAmount: new Prisma.Decimal(finalInput.waivedAmount),
        developmentWorkflowState: 'submitted', developmentWorkflowVersion: version, developmentAssigneeId: payload.financeUserId,
        developmentSubmittedBy: hint.requesterId, developmentSubmittedAt: now, notes: finalInput.reason, updatedAt: now };
      const saved = await tx.billingItem.update({ where: { id: item.id }, data: itemData });
      taskId = developmentBillingReviewTaskId(item.id, version);
      assignment = await tx.workAssignment.create({ data: { id: taskId, title: `核对开发收费 · ${item.itemNo}`,
        description: '领导已批准本次客户收费方案，请核对当前费用依据后确认。', userId: payload.financeUserId,
        assignerId: input.actor.userId, status: 'assigned', metadata: { managedBy: 'development_cost_closure', kind: 'finance_review',
          caseId: hintCaseId, billingItemId: item.id, version, reviewId: payload.expenseReviewId, approvalId: hint.id,
          decision: snapshotDevelopmentBillingItem(saved) } } });
      await tx.notification.createMany({ data: [{ id: `ntf_dev_fee_review_${decision.decisionAuditId}`, userId: payload.financeUserId,
        type: 'development_fee_review_requested', title: '开发收费待财务核对',
        body: `领导已批准 ${item.itemNo} 的客户收费方案，请核对费用依据。`, level: 'info',
        link: `/development?id=${encodeURIComponent(hintCaseId)}&tab=fees`,
        metadata: { caseId: hintCaseId, billingItemId: item.id, approvalId: hint.id, taskId } }], skipDuplicates: true });
      itemData = saved;
    } else {
      itemData = await tx.billingItem.update({ where: { id: item.id }, data: {
        developmentWorkflowState: 'returned', developmentWorkflowVersion: version,
        developmentAssigneeId: hint.requesterId, updatedAt: now,
      } });
    }
    const requestKey = `approval:${hint.id}:${decision.decisionAuditId}`;
    const event = await tx.developmentBillingWorkflowEvent.create({ data: { id: randomUUID(), billingItemId: item.id,
      requestKey, fingerprint: digest({ approvalId: hint.id, decisionAuditId: decision.decisionAuditId, status: input.status,
        reviewContentVersion: input.reviewContentVersion, modifiedInput: input.status === 'approved' ? finalInput : null }),
      action: input.status === 'approved' ? 'approval_approved' : 'approval_rejected', version, actorId: input.actor.userId,
      createdAt: now, snapshot: { before, after: { workflowState: itemData.developmentWorkflowState, workflowVersion: version,
        approvalId: hint.id, expenseReviewId: itemData.developmentExpenseReviewId, amount: String(itemData.amount),
        waivedAmount: String(itemData.waivedAmount), currency: itemData.currency }, note: input.decisionNote ?? '',
        approvalId: hint.id, decisionAuditId: decision.decisionAuditId, reviewContentVersion: input.reviewContentVersion,
        ...(previewDigest ? { finalInput, previewDigest } : {}), ...(taskId ? { taskId } : {}) } } });
    await writeRouteAuditLog({ prisma: tx, actorId: input.actor.userId, source: 'development:fee-approval',
      operation: input.status === 'approved' ? 'approve_development_fee' : 'reject_development_fee',
      targetType: 'BillingItem', targetId: item.id,
      after: { approvalId: hint.id, decisionAuditId: decision.decisionAuditId, eventId: event.id, workflowVersion: version, taskId } });
    const notificationId = input.status === 'approved' ? `ntf_dev_fee_review_${decision.decisionAuditId}` : null;
    return { ...decision, event, billingItem: itemData, ...(assignment ? { assignment } : {}), taskId,
      notificationUserId: input.status === 'approved' ? payload.financeUserId : null, notificationId };
  });
  return committed;
}
