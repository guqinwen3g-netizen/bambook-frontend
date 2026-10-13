import type { ApprovalRequest, Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { assertSupplierCommitmentApprovalRead, authorizeSupplierContract, SUPPLIER_COMMITMENT_APPROVAL_ACTION } from '../procurement/supplierCommitmentService';
import { authorizeSupplierSources, freshSupplierActor } from '../procurement/supplierContractAccess';
import { resolveSupplierApprovers } from '../procurement/supplierCommitmentAuthority';
import { assertSupplierSourceProof, supplierSnapshot } from '../procurement/supplierContractStore';
import { supplierFingerprint, SupplierContractError } from '../procurement/supplierContractPolicy';
import { approvalReviewContentVersion } from './approvalReviewContent';
import { buildApprovalReviewDetail, type ApprovalReviewDetail } from './approvalReviewDetailService';

type SupplierApproval = ApprovalRequest & { reviewer?: { displayName: string } | null };

/** Frozen reviewers remain only candidates: current grants, configuration and all
 * exact frozen sources are checked again before exposing a pending approval. */
export async function assertSupplierApprovalCenterRead(tx: Prisma.TransactionClient, approval: SupplierApproval, actor: TokenPayload): Promise<void> {
  await assertSupplierCommitmentApprovalRead(tx, approval, actor);
  if (approval.status !== 'pending' || approval.requesterId === actor.userId) return;
  await freshSupplierActor(tx, actor, 'approve');
  const revision = await tx.supplierCommitmentRevision.findUniqueOrThrow({ where: { id: approval.targetId! } });
  const kind = revision.purchaseOrderId ? 'purchase' : 'processing';
  const snapshot = supplierSnapshot(revision.snapshot, kind);
  const authority = await resolveSupplierApprovers(tx, kind, snapshot.sourceProofs);
  if (!Array.isArray(approval.eligibleReviewerIds) || !approval.eligibleReviewerIds.includes(actor.userId)
    || !authority.eligibleReviewerIds.includes(actor.userId))
    throw new SupplierContractError('NOT_FOUND', '审批不存在或已不在当前审批范围。', 404);
}

export async function readSupplierApprovalSyncStatus(prisma: PrismaClient, approval: SupplierApproval): Promise<'completed' | 'not_applicable' | 'unknown'> {
  if (approval.status === 'rejected') return 'not_applicable';
  if (approval.status !== 'approved' || !approval.targetId) return 'unknown';
  const revision = await prisma.supplierCommitmentRevision.findUnique({ where: { id: approval.targetId } });
  return revision?.approvalRequestId === approval.id && revision.decidedAt != null
    && ['approved', 'superseded'].includes(revision.status) ? 'completed' : 'unknown';
}

export async function readSupplierApprovalReviewDetail(tx: Prisma.TransactionClient, approval: SupplierApproval, actor: TokenPayload): Promise<ApprovalReviewDetail> {
  await assertSupplierApprovalCenterRead(tx, approval, actor);
  const revision = await tx.supplierCommitmentRevision.findUniqueOrThrow({ where: { id: approval.targetId! } });
  const kind = revision.purchaseOrderId ? 'purchase' : 'processing';
  const contractId = revision.purchaseOrderId ?? revision.outsourcingOrderId!;
  const snapshot = supplierSnapshot(revision.snapshot, kind);
  const current = await authorizeSupplierContract(tx, kind, contractId, actor, { mode: 'read', businessGates: false });
  // The generic signing adapter intentionally hides documentSnapshot. This
  // domain shows its commercial contents, preserving exact strings and lines.
  const fields = buildApprovalReviewDetail({ ...approval, payload: { content: revision.snapshot } }).frozen.fields;
  const detail = buildApprovalReviewDetail(approval);
  const version = approvalReviewContentVersion(approval);
  detail.title = `${kind === 'purchase' ? '采购' : '加工'}供应商承诺审批 · ${current.contract.number} · 版本 ${revision.revision}`;
  detail.frozen = { ...detail.frozen, label: '本次准确供应商承诺冻结内容', fields,
    attachments: [], attachmentStatus: 'not_applicable', attachmentStatusLabel: '附件由准确来源业务入口查看',
    sourceReference: { kind: kind === 'purchase' ? 'purchase_order' : 'processing_contract', id: contractId, label: current.contract.number },
    previewDigest: supplierFingerprint({ reviewContentVersion: version, fields }) };
  detail.currentSource = { status: 'available', label: '已核对当前单据及全部冻结来源读取范围。', fields: [
    { key: 'currentRevision', label: '当前单据版本', value: current.latest ? String(current.latest.revision) : '未知' },
    { key: 'approvedRevision', label: '当前已批承诺', value: current.contract.approvedCommitmentRevisionId ?? '尚无已批承诺' },
    { key: 'frozenSourceCount', label: '本次准确来源条目数', value: String(snapshot.sourceProofs.length) },
  ] };
  const history = await tx.approvalRequest.findMany({ where: { actionType: SUPPLIER_COMMITMENT_APPROVAL_ACTION,
    payload: { path: ['contractId'], equals: contractId }, status: { in: ['approved', 'rejected'] } },
    include: { reviewer: { select: { displayName: true } } }, orderBy: { decidedAt: 'desc' } });
  detail.decisionHistory = [];
  for (const row of history) {
    try { await assertSupplierCommitmentApprovalRead(tx, row, actor); }
    catch (error) {
      if (!(error instanceof SupplierContractError) || error.statusCode >= 500) throw error;
      detail.decisionHistoryStatus = 'unavailable'; continue;
    }
    detail.decisionHistory.push({ id: row.id, action: row.status, status: row.status,
      actorId: row.reviewerId ?? '', actorName: row.reviewer?.displayName ?? null,
      occurredAt: row.decidedAt?.toISOString() ?? row.createdAt.toISOString(), decisionNote: row.decisionNote ?? undefined });
  }
  detail.approvalBlockers = [];
  if (approval.status !== 'pending') detail.approvalBlockers.push('本次审批已处理，历史内容可回看。');
  else {
    try {
      const authority = await resolveSupplierApprovers(tx, kind, snapshot.sourceProofs);
      if (!Array.isArray(approval.eligibleReviewerIds) || !approval.eligibleReviewerIds.includes(actor.userId)
        || !authority.eligibleReviewerIds.includes(actor.userId)) detail.approvalBlockers.push('当前账号没有本次明确审批资格。');
      else {
        const sources = await authorizeSupplierSources(tx, actor, snapshot.lines.map(line => line.orderLineId), { mode: 'approve', formal: true });
        assertSupplierSourceProof(snapshot, sources.sources);
      }
    } catch (error) {
      if (!(error instanceof SupplierContractError) || error.statusCode >= 500) throw error;
      detail.approvalBlockers.push(error.message);
    }
  }
  detail.canApprove = detail.approvalBlockers.length === 0;
  return detail;
}
