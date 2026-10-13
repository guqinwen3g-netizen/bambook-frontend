import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { todayLocalKey } from '../shared/localDate';
import { parsePositiveDecimal } from '../shared/moneyInput';
import { addDisposition, GOODS_KINDS, MONEY_KINDS, type ClaimResult, type DispositionInput } from './claimCaseService';
import { assertClaimSnapshot, buildClaimApprovalPayload, canonicalClaimJson, CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET,
  ClaimTransactionError, claimRefusal, lockClaimRows, requireClaimResult } from './claimApprovalFact';
import { REPLACEMENT_NOTE_PREFIX } from './replacementService';

export const CLAIM_REAPPROVAL_EVENT = 'CLAIM_REAPPROVAL_SUBMITTED';
const CHANGE_KEYS = ['materialCode', 'quantity', 'unit', 'amount', 'currency', 'returnDisposition', 'notes'] as const;
export interface ResubmitClaimApprovalInput {
  reason: string;
  clientRequestId: string;
  changes?: Omit<DispositionInput, 'kind'>;
}
export interface ClaimReapprovalResponse {
  previousDisposition: any;
  disposition: any;
  approvalRequestId: string;
  contentFingerprint: string;
  snapshotVersion: 1;
  businessEventId: string;
}
function badInput(message: string): never { throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message }); }
const digest = (value: unknown) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');

function normalizedParameters(dispositionId: string, input: ResubmitClaimApprovalInput) {
  if (!input || Array.isArray(input) || typeof input !== 'object') badInput('重送审参数须为对象');
  if (Object.keys(input).some(key => !['reason', 'clientRequestId', 'changes'].includes(key))) badInput('重送审不接受来源、审批人、类型或产出字段');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000) badInput('重送审必须填写明确理由（不超过 2000 字符）');
  if (typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim() || input.clientRequestId.length > 200) badInput('clientRequestId 须为 1–200 字符的稳定请求标识');
  if (input.changes !== undefined && (!input.changes || Array.isArray(input.changes) || typeof input.changes !== 'object')) badInput('changes 须为明确字段对象');
  const changes: Record<string, any> = {};
  for (const [key, value] of Object.entries(input.changes ?? {})) {
    if (!(CHANGE_KEYS as readonly string[]).includes(key)) badInput('重送审只能调整金额、数量、单位、物料、币种、去向和备注');
    if (key === 'amount' || key === 'quantity') {
      if (value === null) changes[key] = null;
      else {
        const parsed = parsePositiveDecimal(value, key === 'amount' ? '重送审金额' : '重送审数量');
        if (!parsed.ok) badInput(parsed.message);
        changes[key] = new Prisma.Decimal(parsed.value).toString();
      }
    } else {
      if (value !== null && typeof value !== 'string') badInput('物料、单位、币种、去向和备注须为文本或明确空值');
      changes[key] = typeof value === 'string' && key !== 'notes' ? value.trim() : value;
    }
  }
  return { dispositionId, reason: input.reason.trim(), changes };
}

/** Reconciliation is conservative: source text is a blocking clue, never approval/stock authority. */
async function assertNoProducedOrOrphanDocuments(tx: any, old: any, claimCase: any) {
  const outputKeys = ['creditNoteId', 'returnReceiptId', 'replacementShipmentId', 'repairWorkOrderId'];
  if (old.status === 'Executed' || outputKeys.some(key => Boolean(old[key]))) claimRefusal('处置已有钱货产出，须先完成有留痕的撤销或人工对账，不能重送审再出一套');
  const rows = await tx.claimDisposition.findMany({ where: { claimCaseId: claimCase.id } });
  const linked = (key: string) => new Set(rows.map((row: any) => row[key]).filter(Boolean));
  const active = { deletedAt: null, status: { notIn: ['Cancelled'] } };
  const notesPrefix = `${REPLACEMENT_NOTE_PREFIX} 来自客诉 ${claimCase.caseNumber}`;
  const [notes, receipts, repairs, shipments, directMovements] = await Promise.all([
    tx.creditNote.findMany({ where: { claimCaseId: claimCase.id, ...active }, select: { id: true } }),
    tx.returnReceipt.findMany({ where: { claimCaseId: claimCase.id }, select: { id: true, status: true, deletedAt: true } }),
    tx.repairWorkOrder.findMany({ where: { claimCaseId: claimCase.id, ...active }, select: { id: true, dispositionId: true, reshipmentId: true } }),
    tx.shipment.findMany({ where: { ...active, OR: [{ notes: notesPrefix }, { notes: { startsWith: `${notesPrefix} · ` } }] }, select: { id: true } }),
    tx.stockMovement.findMany({ where: { OR: [{ referenceType: 'ClaimDisposition', referenceId: old.id },
      { referenceType: 'ClaimCase', referenceId: claimCase.id }] }, select: { id: true } }),
  ]);
  const receiptLinks = linked('returnReceiptId');
  const unlinkedReceiptIds = receipts.filter((row: any) => !receiptLinks.has(row.id)).map((row: any) => row.id);
  // A deleted/cancelled orphan header may still have a live inventory ledger; never ignore it.
  const unlinkedReceiptMovements = unlinkedReceiptIds.length ? await tx.stockMovement.findMany({
    where: { referenceType: 'ReturnReceipt', referenceId: { in: unlinkedReceiptIds } }, select: { id: true },
  }) : [];
  const shipmentLinks = linked('replacementShipmentId');
  repairs.forEach((row: any) => { if (row.reshipmentId) shipmentLinks.add(row.reshipmentId); });
  if (notes.some((row: any) => !linked('creditNoteId').has(row.id))
      || receipts.some((row: any) => !row.deletedAt && row.status !== 'Cancelled' && !receiptLinks.has(row.id))
      || repairs.some((row: any) => row.dispositionId === old.id || !linked('repairWorkOrderId').has(row.id))
      || shipments.some((row: any) => !shipmentLinks.has(row.id)) || directMovements.length || unlinkedReceiptMovements.length) {
    claimRefusal('案件存在未关联或孤立的钱货产出，请先人工核对并处理；不能把历史半提交当成未执行');
  }
}

/** Append a new business version; never retrofit a historical approval into a valid fact. */
export async function resubmitClaimApproval(prisma: PrismaClient, dispositionId: string,
  input: ResubmitClaimApprovalInput, actorId: string): Promise<ClaimResult<ClaimReapprovalResponse>> {
  try {
    const parameters = normalizedParameters(dispositionId, input);
    const parametersHash = digest(parameters);
    const routingService = createApprovalRoutingService({ prisma });
    const approvalCreate = createApprovalCreateService({ prisma, routingService });
    return await prisma.$transaction(async (tx: any): Promise<ClaimResult<ClaimReapprovalResponse>> => {
      const { disposition: old, claimCase } = await lockClaimRows(tx, dispositionId);
      await tx.$queryRawUnsafe('SELECT id FROM "ApprovalRequest" WHERE "targetType" = $1 AND "targetId" = $2 FOR UPDATE', CLAIM_APPROVAL_TARGET, old.id);
      const audits = await tx.auditLog.findMany({ where: { action: CLAIM_REAPPROVAL_EVENT, targetType: CLAIM_APPROVAL_TARGET, targetId: old.id } });
      const retries = audits.filter((row: any) => row.detail?.businessEvent?.payload?.requestId === input.clientRequestId);
      if (retries.length) {
        if (retries.length !== 1 || retries[0].actorId !== actorId) claimRefusal('重送审请求标识或调用者不一致，请查阅原续办记录');
        const event = retries[0].detail.businessEvent;
        const fact = event.payload;
        if (fact.schemaVersion !== 1 || fact.actorId !== actorId || fact.parametersHash !== parametersHash
            || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(parameters) || event.sourceEntityId !== old.id
            || event.sourceEntityType !== CLAIM_APPROVAL_TARGET || event.type !== 'ClaimDispositionReapprovalSubmitted'
            || event.id !== retries[0].id || fact.oldDispositionId !== old.id) claimRefusal('相同重送审请求标识的完整参数不同，不可重放');
        const disposition = await tx.claimDisposition.findUnique({ where: { id: fact.replacementDispositionId } });
        const approval = await tx.approvalRequest.findUnique({ where: { id: fact.newApprovalRequestId } });
        if (!disposition || disposition.deletedAt || disposition.claimCaseId !== claimCase.id || !approval
            || approval.actionType !== CLAIM_APPROVAL_ACTION || approval.targetType !== CLAIM_APPROVAL_TARGET || approval.targetId !== disposition.id
            || approval.requesterId !== actorId || approval.payload?.contentFingerprint !== fact.newContentFingerprint
            || buildClaimApprovalPayload(disposition, claimCase).contentFingerprint !== fact.newContentFingerprint) claimRefusal('原续办单据或完整快照已变化，不能返回虚假成功');
        assertClaimSnapshot(approval, disposition, claimCase);
        return { ok: true, data: { previousDisposition: old, disposition, approvalRequestId: approval.id,
          contentFingerprint: fact.newContentFingerprint, snapshotVersion: 1, businessEventId: event.id } };
      }
      if (!['Draft', 'Approved'].includes(old.status)) claimRefusal(`处置状态为 ${old.status}，不能重新送审`);
      if (['Cancelled', 'Closed'].includes(claimCase.status)) claimRefusal('案件已取消或关闭，不能重新送审');
      await assertNoProducedOrOrphanDocuments(tx, old, claimCase);
      const needsMoney = (MONEY_KINDS as readonly string[]).includes(old.kind);
      const needsGoods = (GOODS_KINDS as readonly string[]).includes(old.kind);
      if (!needsMoney && ['amount', 'currency'].some(key => parameters.changes[key] != null)) badInput('该处置不动钱，不能注入金额或币种');
      if (!needsGoods && ['quantity', 'unit', 'returnDisposition'].some(key => parameters.changes[key] != null)) badInput('该处置不动货，不能注入数量、单位或退货去向');
      const previousApprovals = await tx.approvalRequest.findMany({ where: { targetType: CLAIM_APPROVAL_TARGET, targetId: old.id }, select: { id: true, status: true, actionType: true } });
      const inputRow: DispositionInput = { kind: old.kind };
      CHANGE_KEYS.forEach(key => { (inputRow as any)[key] = Object.prototype.hasOwnProperty.call(parameters.changes, key) ? parameters.changes[key] : old[key]; });
      const { disposition } = requireClaimResult(await addDisposition(prisma, claimCase.id, inputRow, actorId, { tx }));
      const snapshot = buildClaimApprovalPayload(disposition, claimCase);
      const approval = await approvalCreate.createBusinessApproval({ requesterId: actorId, actionType: CLAIM_APPROVAL_ACTION,
        targetType: CLAIM_APPROVAL_TARGET, targetId: disposition.id, payload: snapshot, client: tx });
      const now = BigInt(Date.now());
      const changed = await tx.claimDisposition.updateMany({ where: { id: old.id, status: old.status, deletedAt: null },
        data: { status: 'Cancelled', cancelledBy: actorId, cancelledAt: todayLocalKey(), cancelReason: `重新送审：${parameters.reason}`, updatedAt: now } });
      if (changed.count !== 1) claimRefusal('旧处置状态已由其他请求改变，重送审未提交');
      const previousDisposition = await tx.claimDisposition.findUnique({ where: { id: old.id } });
      await tx.claimCase.update({ where: { id: claimCase.id }, data: { status: 'Processing', updatedAt: now } });
      const id = `alog_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const beforeSnapshot = buildClaimApprovalPayload(old, claimCase);
      const beforeContent = beforeSnapshot.content;
      const versionFieldChanges = CHANGE_KEYS.filter(key => canonicalClaimJson(beforeContent.disposition[key]) !== canonicalClaimJson(snapshot.content.disposition[key]))
        .map(key => ({ fieldPath: key, before: beforeContent.disposition[key], after: snapshot.content.disposition[key] }));
      await tx.auditLog.create({ data: { id, actorId, action: CLAIM_REAPPROVAL_EVENT, targetType: CLAIM_APPROVAL_TARGET, targetId: old.id,
        operationType: 'transition', fieldPath: 'status', beforeValue: old.status, afterValue: 'Cancelled', transactionId: id,
        detail: { source: 'claim', before: { status: old.status, approverId: old.approverId ?? null, approvedAt: old.approvedAt ?? null,
            cancelledBy: old.cancelledBy ?? null, cancelledAt: old.cancelledAt ?? null, cancelReason: old.cancelReason ?? null, content: beforeContent },
          after: { status: 'Cancelled', approverId: old.approverId ?? null, approvedAt: old.approvedAt ?? null,
            cancelledBy: actorId, cancelledAt: previousDisposition.cancelledAt, cancelReason: previousDisposition.cancelReason, replacementDispositionId: disposition.id },
          fieldChanges: ['status', 'cancelledBy', 'cancelledAt', 'cancelReason'].map(key => ({ fieldPath: key, before: old[key] ?? null, after: previousDisposition[key] ?? null })),
          versionFieldChanges, caseProjection: { caseId: claimCase.id, beforeStatus: claimCase.status, afterStatus: 'Processing' },
          businessEvent: { id, type: 'ClaimDispositionReapprovalSubmitted', sourceEntityType: CLAIM_APPROVAL_TARGET, sourceEntityId: old.id,
            payload: { schemaVersion: 1, actorId, requestId: input.clientRequestId, parameters, parametersHash,
              oldDispositionId: old.id, replacementDispositionId: disposition.id, newApprovalRequestId: approval.id,
              previousApprovals, oldContentFingerprint: beforeSnapshot.contentFingerprint,
              newContentFingerprint: snapshot.contentFingerprint, snapshotVersion: 1 } } } } });
      return { ok: true, data: { previousDisposition, disposition, approvalRequestId: approval.id,
        contentFingerprint: snapshot.contentFingerprint, snapshotVersion: 1, businessEventId: id } };
    });
  } catch (error) {
    if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError };
    throw error;
  }
}
