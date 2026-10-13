import { createHash } from 'node:crypto';
import { canonicalCustomerConfirmationJson, customerConfirmationSha256 } from '../customerConfirmations/customerConfirmationService';

export class OrderChangeFinalVersionError extends Error {
  readonly code = 'ORDER_CHANGE_VERSION_MISMATCH';
  readonly statusCode = 409;
  constructor(message = '订单、明细行或批准内容版本已变化，客户确认与生效均需重新核对。') {
    super(message);
    this.name = 'OrderChangeFinalVersionError';
  }
}

const SUPPORTED = new Set(['price', 'quantity', 'delivery']);
const FIELD_FOR_TYPE: Record<string, string> = { price: 'unitPrice', quantity: 'quantity', delivery: 'deliveryDate' };
const SCHEMA_FIELD: Record<string, string> = { price: 'unitPrice', quantity: 'quantity', delivery: 'deliveryDate' };
const DOMAIN_FIELD_BY_SCHEMA: Record<string, string> = { unitPrice: 'unitPrice', quantity: 'quantity', deliveryDate: 'deliveryDate' };

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalCustomerConfirmationJson(value)).digest('hex');
}

/**
 * Reviewer amendment signature input. It deliberately excludes a future successor ID,
 * but binds the exact old approval review hash, current native source basis, normalized
 * proposal fields, reason, and impact so the command can recompute it under lock.
 */
export function orderChangeAmendmentProposalFingerprint(input: {
  sourceChangeRequest: any;
  sourceApproval: any;
  sourceApprovalReviewVersion: string;
  currentSourceBasis: unknown;
  proposal: { changeType: string; hitChangeTypes: string[]; beforeSnapshot: unknown; afterDelta: unknown;
    changeReason: string; impactSummary: string };
}): string {
  const cr = input.sourceChangeRequest;
  const approval = input.sourceApproval;
  return customerConfirmationSha256(canonicalCustomerConfirmationJson({
    schemaVersion: 1,
    purpose: 'order-change-amendment-final-proposal',
    source: {
      changeRequest: {
        id: cr.id, orderId: cr.orderId, status: cr.status, requestNumber: cr.requestNumber,
        requesterId: cr.requesterId, approvalRequestId: cr.approvalRequestId,
        changeTypes: cr.changeTypes, beforeSnapshot: cr.beforeSnapshot, afterDelta: cr.afterDelta,
        changeReason: cr.changeReason, impactSummary: cr.notes ?? null,
        finalContentFingerprint: cr.finalContentFingerprint ?? null,
      },
      approval: {
        id: approval.id, requesterId: approval.requesterId, reviewerId: approval.reviewerId,
        actionType: approval.actionType, targetType: approval.targetType, targetId: approval.targetId,
        status: approval.status, reviewContentVersion: input.sourceApprovalReviewVersion,
      },
    },
    currentSourceBasis: input.currentSourceBasis,
    proposal: input.proposal,
  }));
}

/** Capture actual Order and all persisted OrderLine facts inside the caller's transaction. */
export function captureOrderChangeReviewBasis(order: any, orderLines: any[]) {
  if (!order?.id || !Array.isArray(orderLines) || orderLines.some(line => !line?.id || line.orderId !== order.id))
    throw new OrderChangeFinalVersionError('订单或订单行来源不完整，无法冻结客户确认版本。');
  const lines = [...orderLines].sort((a, b) => Number(a.lineNumber ?? 0) - Number(b.lineNumber ?? 0) || String(a.id).localeCompare(String(b.id)));
  return {
    schemaVersion: 1,
    order: {
      id: order.id,
      status: order.status ?? null,
      updatedAt: order.updatedAt == null ? null : String(order.updatedAt),
      quantity: order.quantity == null ? null : String(order.quantity),
      unit: order.unit ?? null,
      quoteAmount: order.quoteAmount == null ? null : String(order.quoteAmount),
      contractAmount: order.contractAmount == null ? null : String(order.contractAmount),
      totalNet: order.totalNet == null ? null : String(order.totalNet),
      dueDate: order.dueDate ?? null,
      clientDate: order.clientDate ?? null,
      customer: order.customer ?? null,
      customerRelationId: order.customerRelationId ?? null,
      customerCode: order.customerCode ?? null,
      currency: order.currency ?? null,
      salesCurrency: order.salesCurrency ?? null,
      type: order.type ?? null,
      businessLine: order.businessLine ?? null,
    },
    orderLines: lines.map(line => ({
      id: line.id,
      orderId: line.orderId,
      lineNumber: line.lineNumber ?? null,
      itemNo: line.itemNo ?? null,
      materialCode: line.materialCode ?? null,
      description: line.description ?? null,
      quantity: line.quantity == null ? null : String(line.quantity),
      unit: line.unit ?? null,
      unitPrice: line.unitPrice == null ? null : String(line.unitPrice),
      netValue: line.netValue == null ? null : String(line.netValue),
      internalTransferPrice: line.internalTransferPrice == null ? null : String(line.internalTransferPrice),
      confirmedSourceType: line.confirmedSourceType ?? null,
      confirmedSourceId: line.confirmedSourceId ?? null,
      confirmedAt: line.confirmedAt == null ? null : String(line.confirmedAt),
      confirmedBy: line.confirmedBy ?? null,
      specSnapshot: line.specSnapshot ?? null,
    })),
  };
}

export interface OrderChangeFinalVersionInput {
  changeRequest: any;
  order: any;
  orderLines: any[];
  approval: any;
  requireApproved?: boolean;
  allowStaleSource?: boolean;
  /** Read an already-applied version from the immutable source snapshot bound into the approval payload. */
  useFrozenSource?: boolean;
  /** Applied rows are readback-only; this does not permit an apply or a new decision. */
  allowAppliedReadback?: boolean;
}

/**
 * Rebuild the exact customer-confirmable version from current native rows and
 * the immutable approval payload. A body-supplied fingerprint is never read.
 */
export function buildOrderChangeFinalVersion(input: OrderChangeFinalVersionInput) {
  const { changeRequest: cr, order, orderLines, approval, requireApproved = true, allowStaleSource = false,
    useFrozenSource = false, allowAppliedReadback = false } = input;
  const payload = approval?.payload && typeof approval.payload === 'object' && !Array.isArray(approval.payload) ? approval.payload : null;
  const changeType = payload?.changeType;
  const field = FIELD_FOR_TYPE[changeType];
  if (!cr?.id || !cr.orderId || !SUPPORTED.has(changeType) || !field || !payload
    || cr.orderId !== order?.id || cr.deletedAt != null
    || (requireApproved && cr.status !== 'Approved' && !(allowAppliedReadback && cr.status === 'Applied'))
    || cr.approvalRequestId !== approval?.id || cr.requesterId !== approval?.requesterId
    || (requireApproved && (approval?.status !== 'approved' || !approval?.decidedAt))
    || (!requireApproved && approval?.status !== 'pending')
    || approval?.actionType !== 'order:change' || approval?.targetType !== 'OrderChangeRequest'
    || approval?.targetId !== cr.orderId
    || canonicalCustomerConfirmationJson(payload.beforeSnapshot) !== canonicalCustomerConfirmationJson(cr.beforeSnapshot)
    || canonicalCustomerConfirmationJson(payload.afterDelta) !== canonicalCustomerConfirmationJson(cr.afterDelta)
    || payload.changeReason !== cr.changeReason || payload.impactSummary !== cr.notes
    || canonicalCustomerConfirmationJson(payload.hitChangeTypes) !== canonicalCustomerConfirmationJson(cr.changeTypes)) {
    throw new OrderChangeFinalVersionError('缺少与订单变更单完全一致的已批准最终内容。');
  }
  if (SCHEMA_FIELD[changeType] !== cr.changeTypes?.[0])
    throw new OrderChangeFinalVersionError('变更类型与审批字段不一致，不能生成客户确认版本。');

  const currentBasis = captureOrderChangeReviewBasis(order, orderLines);
  const frozenBasis = payload.orderChangeReviewBasis;
  const sourceMatchesFrozen = !!frozenBasis && canonicalCustomerConfirmationJson(currentBasis) === canonicalCustomerConfirmationJson(frozenBasis);
  if (!sourceMatchesFrozen && !allowStaleSource)
    throw new OrderChangeFinalVersionError('订单或订单明细在申请/批准后发生变化，请重新提交订单变更。');
  if (useFrozenSource && (!frozenBasis || frozenBasis.schemaVersion !== 1
    || frozenBasis.order?.id !== order.id || !Array.isArray(frozenBasis.orderLines)))
    throw new OrderChangeFinalVersionError('已生效变更缺少审批时冻结的订单来源版本，无法回读客户确认。');
  const fingerprintBasis = useFrozenSource ? frozenBasis : currentBasis;

  const lineQuantityPlanHash = typeof cr.afterDelta?.lineQuantityPlanHash === 'string' ? cr.afterDelta.lineQuantityPlanHash : null;
  const lineIds = fingerprintBasis.orderLines.map((line: any) => line.id);
  const scope = {
    schemaVersion: 1,
    targetId: cr.id,
    orderId: cr.orderId,
    changeType,
    fields: [...new Set((cr.changeTypes ?? []).map((item: string) => DOMAIN_FIELD_BY_SCHEMA[item]).filter(Boolean))].sort(),
    beforeSnapshot: cr.beforeSnapshot,
    afterDelta: cr.afterDelta,
    orderVersion: fingerprintBasis.order.updatedAt,
    lineIds,
    lineQuantityPlanHash,
  };
  const { resolution: _decisionMetadata, ...approvedPayload } = payload;
  const content = {
    schemaVersion: 1,
    changeRequest: {
      id: cr.id, orderId: cr.orderId, requestNumber: cr.requestNumber,
      changeTypes: cr.changeTypes, requesterId: cr.requesterId,
      beforeSnapshot: cr.beforeSnapshot, afterDelta: cr.afterDelta,
      changeReason: cr.changeReason, impactSummary: cr.notes,
    },
    internalApprovalId: approval.id,
    approvedPayload,
    sourceBasis: fingerprintBasis,
    scope,
  };
  const finalContentFingerprint = digest(content);
  return { finalContentFingerprint, scopeFingerprint: finalContentFingerprint, scope, sourceBasis: fingerprintBasis, sourceMatchesFrozen };
}

export function assertOrderChangeDecisionFact(approval: any, audits: any[], expectedStatus: 'approved' | 'rejected'): void {
  const actualActorId = approval?.bossFinalBypassBy ?? approval?.reviewerId;
  const decidedAt = approval?.decidedAt instanceof Date ? approval.decidedAt.toISOString() : null;
  const contentFingerprint = approval?.payload?.contentFingerprint ?? null;
  const facts = (audits ?? []).filter((audit: any) => {
    const fact = audit?.detail?.approvalDecisionFact;
    const actions = expectedStatus === 'approved'
      ? ['approve_business_request', 'approve', 'agent_approval_approved', 'boss_final_bypass']
      : ['reject_business_request', 'reject', 'agent_approval_rejected'];
    return fact?.schemaVersion === 1 && fact.status === expectedStatus
      && fact.actionType === approval?.actionType && fact.targetType === approval?.targetType
      && fact.targetId === approval?.targetId && fact.contentFingerprint === contentFingerprint
      && fact.decidedAt === decidedAt && fact.decisionActorId === actualActorId
      && audit.actorId === actualActorId && audit.targetId === approval?.id
      && actions.includes(audit.action)
      && (expectedStatus !== 'approved' || fact.reviewedContentConfirmed === true)
      && /^[a-f0-9]{64}$/.test(fact.reviewContentVersion ?? '');
  });
  if (!actualActorId || actualActorId === approval?.requesterId || !decidedAt || facts.length !== 1)
    throw new OrderChangeFinalVersionError('找不到唯一、绑定最终审批内容且完成明确核对签署的批准审计。');
  // The kernel recorded the hash before mutating status/reviewer. It is durable evidence,
  // while the payload's exact equality to the CR is checked by buildOrderChangeFinalVersion.
  if (expectedStatus === 'approved' && approval?.bossFinalBypassBy && facts[0].action !== 'boss_final_bypass')
    throw new OrderChangeFinalVersionError('BOSS 兜底批准审计与最终审批人不一致。');
  if (expectedStatus === 'approved' && !approval?.bossFinalBypassBy && facts[0].action === 'boss_final_bypass')
    throw new OrderChangeFinalVersionError('BOSS 兜底审计缺少对应的审批人事实。');
}

export function assertOrderChangeApprovalDecisionFact(approval: any, audits: any[]): void {
  assertOrderChangeDecisionFact(approval, audits, 'approved');
}

export function normalizeOrderChangeDecimal(value: unknown): string | null {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const [wholeRaw, fractionRaw = ''] = text.split('.');
  const whole = wholeRaw.replace(/^(-?)0+(?=\d)/, '$1');
  const fraction = fractionRaw.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Called by the shared approval kernel before it locks ApprovalRequest. This
 * read-only source fence gives approval, customer confirmation, and apply the
 * same Order → CR → OrderLine → ApprovalRequest lock order.
 */
export async function lockOrderChangeApprovalSource(tx: any, approvalId: string, candidate: any) {
  if (candidate?.actionType !== 'order:change' || candidate?.targetType !== 'OrderChangeRequest'
    || !candidate?.targetId || !SUPPORTED.has(candidate?.payload?.changeType)) return null;
  const matches = await tx.orderChangeRequest.findMany({
    where: { approvalRequestId: approvalId, orderId: candidate.targetId, deletedAt: null },
    take: 2,
  });
  if (matches.length !== 1) throw new OrderChangeFinalVersionError('订单变更审批未唯一关联一张申请，不能核对当前版本。');
  const hint = matches[0];
  if (hint.status !== 'Pending') throw new OrderChangeFinalVersionError('订单变更申请不再待审批，请重新加载当前事实。');

  await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', hint.orderId);
  await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE', hint.id);
  const order = await tx.order.findUnique({ where: { id: hint.orderId } });
  const changeRequest = await tx.orderChangeRequest.findUnique({ where: { id: hint.id } });
  if (!order || order.deletedAt || !changeRequest || changeRequest.deletedAt || changeRequest.status !== 'Pending'
    || changeRequest.orderId !== candidate.targetId || changeRequest.approvalRequestId !== approvalId)
    throw new OrderChangeFinalVersionError('订单变更来源或待审状态已变化，请重新加载。');
  await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', order.id);
  const lines = await tx.orderLine.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
  const finalVersion = buildOrderChangeFinalVersion({
    changeRequest, order, orderLines: lines,
    approval: { ...candidate, id: approvalId, status: 'pending' },
    requireApproved: false,
  });
  if (!finalVersion.sourceMatchesFrozen)
    throw new OrderChangeFinalVersionError('订单或明细行在发起审批后已变化，不能按旧申请签署。');
  return { orderId: order.id, changeRequest, order, lines };
}
