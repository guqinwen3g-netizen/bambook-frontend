/**
 * §10.3-9 电子签·签署人解析（Phase B 批次 2）
 *
 * 单据的「签署人」= 该单据**最近一次已批准审批**的审批人（ApprovalRequest.reviewerId）——
 * 与 §10.4 P-7 口径一致：签谁就是谁，禁止代签。
 * 渲染链据此用 sealService.resolveSealForSigner 取章（ownerUser > ownerRole > 默认章）。
 *
 * 失败 / 无已批准审批 → null（渲染链 fail-open：不出章，但不阻断出单）。
 */

import type { PrismaClient } from '@prisma/client';
import { assertCurrentApprovalSignDocumentSnapshot, assertCurrentQuotationSignDocumentSnapshot,
  getApprovalSignDocumentSnapshot, type ApprovalSignDocumentSnapshot } from '../approvals/approvalSignDocumentSnapshotService';
import { approvalReviewContentVersion } from '../approvals/approvalReviewContent';
import { approvalReviewPreviewDigest } from '../approvals/approvalReviewDetailService';
import { logger } from '../lib/logger';
import { readQuotationApprovalState } from '../quotations/quotationApprovalSnapshot';
import type { QuotationDocData } from '../templates/docTemplates/quotation';

export interface DocumentSigner {
  userId: string;
  /** 签署人首个角色（印章按角色归属时的解析依据）；无角色记录则 null */
  roleId: string | null;
  documentSnapshot?: ApprovalSignDocumentSnapshot;
  quotationData?: QuotationDocData;
}

/**
 * 单据类型 → 电子签审批目标类型（§10.3-9 覆盖范围）。
 *
 * 仅登记**已具备签署审批流**的单据类型——绝不把业务风控审批当签署：
 * 例如 `order:moq-exemption` 获批 ≠ 订单确认书已签，若按 Order 目标解析会误盖章。
 * 每类都要有对应的「提交签署」入口（报价=报价审批流；订单确认书=订单管理提交签署；
 * 付款申请=审核通过即签署；合同=单据中心生成合并合同时提交签署）。
 */
export const SIGN_TARGET_BY_DOC_TYPE: Record<string, string> = {
  Quotation: 'Quotation',
  // 订单确认书：由「提交签署」入口建 `order:confirmation_sign` 审批（targetType=OrderConfirmation）
  OrderConfirmation: 'OrderConfirmation',
  // 付款申请单：审核通过即签署（`finance:payment_request` 审批，targetType=PaymentRequest）
  PaymentRequest: 'PaymentRequest',
  // 合同：单据中心生成合并销售合同时提交签署（`contract:sign`，targetId=composite 回链）
  Contract: 'Contract',
};

/** 只有实际单据签署动作可以取章；风控豁免不等于签署。 */
const SIGN_ACTION_BY_TARGET: Record<string, string> = {
  Quotation: 'quotation:total_approve',
  OrderConfirmation: 'order:confirmation_sign',
  PaymentRequest: 'finance:payment_request',
  Contract: 'contract:sign',
};

const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};

async function verifiedQuotationSnapshot(db: any, approval: any, quotation: any, signerId: string): Promise<ApprovalSignDocumentSnapshot | null> {
  if (!approval.decidedAt) return null;
  const audits = await db.auditLog.findMany({ where: { actorId: signerId, OR: [
    { targetType: 'ApprovalRequest', targetId: approval.id }, { detail: { path: ['approvalId'], equals: approval.id } },
  ] } });
  const matches: ApprovalSignDocumentSnapshot[] = [];
  for (const audit of audits) {
    const detail = obj(audit.detail), fact = obj(detail.approvalDecisionFact), authority = obj(detail.decisionActorAuthority);
    const actionIsDecision = ['approve_business_request', 'approve', 'agent_approval_approved', 'boss_final_bypass'].includes(audit.action);
    if (!actionIsDecision || !['api:approvals', 'api:approvals-kernel', 'api:admin', 'api:agent'].includes(detail.source)
      || authority.userId !== signerId || authority.authorizationLoaded !== true
      || !Object.prototype.hasOwnProperty.call(fact, 'frozenReviewerId') || fact.schemaVersion !== 1
      || fact.status !== 'approved' || fact.reviewedContentConfirmed !== true
      || fact.actionType !== approval.actionType || fact.targetType !== approval.targetType || fact.targetId !== approval.targetId
      || fact.decisionActorId !== signerId || fact.decidedAt !== new Date(approval.decidedAt).toISOString()) continue;
    const payload = { ...obj(approval.payload) };
    if (detail.source === 'api:agent') delete payload.resolution;
    const reviewed = { ...approval, reviewerId: fact.frozenReviewerId, payload };
    if (fact.reviewContentVersion !== approvalReviewContentVersion(reviewed)
      || fact.reviewPreviewDigest !== approvalReviewPreviewDigest(reviewed)) continue;

    const amendmentAuditId = typeof fact.quotationAmendmentAuditId === 'string' ? fact.quotationAmendmentAuditId : '';
    let snapshot = getApprovalSignDocumentSnapshot(approval);
    if (amendmentAuditId) {
      const amendments = audits.filter((entry: any) => entry.id === amendmentAuditId && entry.action === 'quotation_approval_amended'
        && entry.targetType === 'ApprovalRequest' && entry.targetId === approval.id && entry.actorId === signerId);
      if (amendments.length !== 1) continue;
      const amendment = obj(amendments[0].detail);
      snapshot = obj(amendment.finalDocumentSnapshot) as unknown as ApprovalSignDocumentSnapshot;
      if (amendment.schemaVersion !== 1 || amendment.approvalId !== approval.id || amendment.quotationId !== quotation.id
        || amendment.decisionActorId !== signerId || !/^[a-f0-9]{64}$/.test(String(amendment.previewVersion ?? ''))
        || !snapshot || snapshot.kind !== 'Quotation'
        || fact.quotationAmendmentAuditId !== amendments[0].id
        || fact.finalContentVersion !== amendment.finalContentVersion
        || fact.finalQuotationFingerprint !== amendment.finalFingerprint
        || fact.finalQuotationVersion !== amendment.finalVersion) continue;
    }
    if (!snapshot) continue;
    try {
      const current = await assertCurrentQuotationSignDocumentSnapshot(db,
        { ...approval, payload: { ...obj(approval.payload), documentSnapshot: snapshot } }, quotation);
      const descriptor = obj(fact.documentSnapshot);
      if (descriptor.kind === current.kind && descriptor.sourceRef === current.sourceRef
        && descriptor.templateVersion === current.templateVersion && descriptor.sourceFingerprint === current.sourceFingerprint
        && descriptor.contentFingerprint === current.contentFingerprint
        && (!amendmentAuditId || descriptor.amendmentAuditId === amendmentAuditId)) matches.push(current);
    } catch { /* a stale source or invalid frozen envelope is not a signer */ }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** 按审批目标解析签署人（最新一条已批准审批的 reviewerId + 其首个角色） */
export async function resolveDocumentSigner(
  prisma: PrismaClient,
  params: { targetType: string; targetId: string },
): Promise<DocumentSigner | null> {
  try {
    const actionType = SIGN_ACTION_BY_TARGET[params.targetType];
    if (!actionType) return null;
    const db = prisma as any;
    const approval = await db.approvalRequest.findFirst({
      where: {
        actionType,
        targetType: params.targetType,
        targetId: params.targetId,
        status: 'approved',
        OR: [{ reviewerId: { not: null } }, { bossFinalBypassBy: { not: null } }],
      },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const signerId = approval?.bossFinalBypassBy ?? approval?.reviewerId;
    if (!signerId || approval.actionType !== actionType) return null;

    let quotationData: QuotationDocData | undefined;
    let quotationDocumentSnapshot: ApprovalSignDocumentSnapshot | undefined;
    if (params.targetType === 'Quotation') {
      const quotation = await db.quotation.findUnique({ where: { id: params.targetId },
        include: { lines: { orderBy: { lineNumber: 'asc' } } } });
      if (!quotation || quotation.deletedAt || await readQuotationApprovalState(db, approval, quotation) !== 'approved') return null;
      quotationDocumentSnapshot = await verifiedQuotationSnapshot(db, approval, quotation, signerId) ?? undefined;
      if (!quotationDocumentSnapshot) return null;
      // The signature check and renderer consume this same verified source row/snapshot.
      quotationData = quotationDocumentSnapshot.data as QuotationDocData;
    }

    const documentSnapshot = quotationDocumentSnapshot ?? ((params.targetType === 'OrderConfirmation' || params.targetType === 'Contract')
      ? await assertCurrentApprovalSignDocumentSnapshot(prisma, approval) : undefined);

    if (documentSnapshot) {
      if (!approval.decidedAt) return null;
      const audits = await db.auditLog.findMany({ where: { actorId: signerId, OR: [
        { targetType: 'ApprovalRequest', targetId: approval.id },
        { detail: { path: ['approvalId'], equals: approval.id } },
      ] } });
      const verified = audits.some((audit: any) => {
        const detail = audit.detail ?? {}, fact = detail.approvalDecisionFact ?? {}, authority = detail.decisionActorAuthority ?? {};
        const payload = { ...(approval.payload ?? {}) };
        if (detail.source === 'api:agent') delete payload.resolution;
        const reviewed = { ...approval, reviewerId: fact.frozenReviewerId, payload };
        const signed = fact.documentSnapshot ?? {};
        return ['approve_business_request', 'approve', 'agent_approval_approved', 'boss_final_bypass'].includes(audit.action)
          && ['api:approvals', 'api:approvals-kernel', 'api:admin', 'api:agent'].includes(detail.source)
          && authority.userId === signerId && authority.authorizationLoaded === true
          && Object.prototype.hasOwnProperty.call(fact, 'frozenReviewerId')
          && fact.schemaVersion === 1 && fact.status === 'approved' && fact.reviewedContentConfirmed === true
          && fact.actionType === approval.actionType && fact.targetType === approval.targetType && fact.targetId === approval.targetId
          && fact.decisionActorId === signerId && fact.decidedAt === new Date(approval.decidedAt).toISOString()
          && fact.reviewContentVersion === approvalReviewContentVersion(reviewed)
          && fact.reviewPreviewDigest === approvalReviewPreviewDigest(reviewed)
          && signed.kind === documentSnapshot.kind && signed.sourceRef === documentSnapshot.sourceRef
          && signed.templateVersion === documentSnapshot.templateVersion
          && signed.sourceFingerprint === documentSnapshot.sourceFingerprint && signed.contentFingerprint === documentSnapshot.contentFingerprint;
      });
      if (!verified) return null;
    }

    const role = await db.userRole.findFirst({
      where: { userId: signerId },
      orderBy: { createdAt: 'asc' },
      select: { roleId: true },
    });
    return { userId: signerId, roleId: role?.roleId ?? null, ...(documentSnapshot ? { documentSnapshot } : {}),
      ...(quotationData ? { quotationData } : {}) };
  } catch (e: any) {
    logger.warn('[DocSigner] resolve signer failed (rendering continues without stamp)', {
      targetType: params.targetType,
      targetId: params.targetId,
      error: e?.message,
    });
    return null;
  }
}

/**
 * 按「单据类型 + 业务真源 id」解析签署人。
 * 未登记签署审批的类型（OC/CONTRACT 等）或无 sourceRef → null（不出章）。
 */
export async function resolveDocumentSignerByDoc(
  prisma: PrismaClient,
  doc: { type: string; sourceRef: string | null },
): Promise<DocumentSigner | null> {
  if (!doc.sourceRef) return null;
  const targetType = SIGN_TARGET_BY_DOC_TYPE[doc.type];
  if (!targetType) return null;
  return resolveDocumentSigner(prisma, { targetType, targetId: doc.sourceRef });
}
