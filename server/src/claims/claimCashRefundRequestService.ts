import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { assertCashRefundReturnFact, readCashRefundPaidSource, readCashReturnSourceProof } from './claimCashRefundReturnFact';
import { canonicalClaimJson } from './claimApprovalFact';
import { assertClaimCreditNoteAccount, assertCreditNoteSettlementEvent, creditNoteDigest, lockCreditNoteForSettlement } from './claimCreditNoteVersionService';
import { assertRefundEvent, assertRefundHistory, CashRefundError, currentRefundActor,
  type CashRefundVisibility, lockCashRefund, refundRequestId, requireRefundVisibility } from './claimCashRefundFact';
import { type CashRefundRequestAction, normalizeRefundRequest, readRefundRequestFence, refundFenceId,
  refundRequestEnvelope, refundRequestKind, refundRequestScope } from './claimCashRefundRequestFact';

export interface CashRefundRequestCheckInput {
  action: CashRefundRequestAction; originalClientRequestId: string; originalPayload: Record<string, unknown>;
}
export interface CashRefundRequestRetireInput extends CashRefundRequestCheckInput {
  retirementClientRequestId: string; reason: string;
}
/** An exact receipt concerns system journaling only. In particular a retired
 * confirm key says nothing about a bank debit; Executing and its reservation
 * remain unchanged. It never authorizes another transfer of money. */
export function createClaimCashRefundRequestService(options: { prisma: PrismaClient; assertVisible?: CashRefundVisibility; assertReturnEvidence?: (row: any) => Promise<void> }) {
  async function resolve(parentId: string, parentType: 'note' | 'refund', input: CashRefundRequestCheckInput,
    prior: TokenPayload, retirement?: { retirementClientRequestId: string; reason: string }) {
    if (!input || !['create', 'start', 'cancel', 'confirm', 'failure', 'resubmit', 'return'].includes(input.action)
        || (parentType === 'note') !== (input.action === 'create')
        || Object.keys(input).some(key => !(retirement
          ? ['action', 'originalClientRequestId', 'originalPayload', 'retirementClientRequestId', 'reason']
          : ['action', 'originalClientRequestId', 'originalPayload']).includes(key))) throw new CashRefundError('VALIDATION_FAILED', '请求核对须指明准确操作、原编号和完整原始请求');
    const requestId = refundRequestId(input.originalClientRequestId);
    const envelope = refundRequestEnvelope(input.action, input.originalPayload);
    if (envelope.originalClientRequestId !== requestId) throw new CashRefundError('VALIDATION_FAILED', '原始请求内编号与核对编号不同');
    if (retirement) {
      refundRequestId(retirement.retirementClientRequestId);
      if (typeof retirement.reason !== 'string' || !retirement.reason.trim() || retirement.reason.length > 2000) throw new CashRefundError('VALIDATION_FAILED', '明确封存须提供理由，最大 2000 字符');
    }
    return (options.prisma as any).$transaction(async (tx: any) => {
      const source = parentType === 'refund' ? await lockCashRefund(tx, parentId) : null;
      const note = source?.creditNote ?? await lockCreditNoteForSettlement(tx, parentId);
      // Scope and current parent visibility are checked before disclosing key
      // existence. Retirement has the original action's real write authority.
      const actor = await currentRefundActor(tx, prior, refundRequestScope(input.action));
      await requireRefundVisibility(tx, note, actor, options.assertVisible);
      if (input.action === 'return') {
        if (!options.assertReturnEvidence) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '返款结果核对需要真实私有原字节校验');
        await assertClaimCreditNoteAccount(tx, note);
        const paidSource = await readCashRefundPaidSource(tx, note, source!.refund);
        for (const proof of await readCashReturnSourceProof(tx, source!.refund.id, paidSource)) await options.assertReturnEvidence(proof);
      }
      const parent = { creditNoteId: note.id, refundId: parentType === 'refund' ? parentId : null };
      const base = { schemaVersion: 1, action: input.action, originalClientRequestId: requestId,
        originalParameterHash: envelope.originalParameterHash, originalPayload: envelope.originalPayload,
        actorId: actor.userId, parent, meaning: 'system_record_only',
        ...(retirement ? { retirementClientRequestId: retirement.retirementClientRequestId, reason: retirement.reason.trim() } : {}) };
      const outcome = (state: 'applied' | 'not_applied' | 'unknown' | 'conflict', data: any = {}) => ({ ...base, state,
        retry: state === 'not_applied' ? 'correct_with_new_request' : state === 'unknown' ? 'same_request_only' : state === 'conflict' ? 'do_not_retry' : 'none', ...data });
      const fence = await readRefundRequestFence(tx, note.id, requestId);
      const refunds = await tx.creditNoteRefund.findMany({ where: { creditNoteId: note.id } });
      const returns = await tx.creditNoteRefundReturn.findMany({ where: { creditNoteId: note.id, requestId } });
      const originals = refunds.filter((row: any) => row.requestId === requestId);
      const events = await tx.creditNoteRefundEvent.findMany({ where: { refundId: { in: refunds.map((row: any) => row.id) }, requestId } });
      const settlement = await tx.creditNoteSettlementEvent.findUnique({ where: { creditNoteId_requestId: { creditNoteId: note.id, requestId } } });
      // A key associated with a different child/action or an offset cannot be
      // retired just because the requested command's row is absent.
      if (fence && (originals.length || events.length || settlement || returns.length)) throw new CashRefundError('INVALID_STATE', '封存请求同时存在执行事实，请人工核对');
      if (originals.length > 1 || events.length > 1 || returns.length > 1) throw new CashRefundError('INVALID_STATE', '请求编号对应多条事实，请人工核对');
      if (fence) {
        const fact = fence.fact;
        if (fact.actorId !== actor.userId || fact.action !== input.action
            || canonicalClaimJson(fact.parent) !== canonicalClaimJson(parent)
            || fact.originalParameterHash !== envelope.originalParameterHash
            || canonicalClaimJson(fact.originalPayload) !== canonicalClaimJson(envelope.originalPayload)
            || (retirement && (fact.retirementClientRequestId !== retirement.retirementClientRequestId || fact.reason !== retirement.reason.trim()))) return outcome('conflict');
        return outcome('not_applied', { fenceAuditId: fence.row.id, retirementClientRequestId: fact.retirementClientRequestId,
          reason: fact.reason, checkedAt: fact.checkedAt });
      }
      if (returns.length) {
        const row = returns[0];
        if (input.action !== 'return' || row.refundId !== parentId || row.actorId !== actor.userId || originals.length || events.length) return outcome('conflict');
        const fact = await assertCashRefundReturnFact(tx, note, row);
        if (!options.assertReturnEvidence) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '返款回执私有原字节校验尚未配置');
        for (const proof of [...fact.evidence, ...fact.sourceEvidence]) await options.assertReturnEvidence(proof);
        await assertClaimCreditNoteAccount(tx, note);
        if (!settlement || settlement.refundReturnId !== row.id) throw new CashRefundError('INVALID_STATE', '返款回执缺少唯一余额恢复事实');
        await assertCreditNoteSettlementEvent(tx, note, settlement);
        const original = row.parameters.requestEnvelope;
        if (canonicalClaimJson(original) !== canonicalClaimJson(envelope)) return outcome('conflict');
        return outcome('applied', { ack: { eventId: settlement.id, auditId: row.auditId, kind: 'Returned',
          refundId: row.refundId, returnId: row.id, paymentRequestId: fact.refund.paymentRequestId, versionId: row.currentVersionId,
          paymentVoucherId: row.receiptVoucherId, settlementEventId: settlement.id,
          parametersHash: row.parametersHash, parameters: row.parameters, createdAt: String(row.createdAt), statusAtExecution: 'Paid' } });
      }
      if (input.action === 'return' && (originals.length || events.length || settlement)) return outcome('conflict');
      if (originals.length || events.length || settlement) {
        const event = events[0], refund = event && refunds.find((row: any) => row.id === event.refundId);
        if (!event || !refund) return outcome('conflict');
        await assertRefundHistory(tx, refund); await assertRefundEvent(tx, event);
        const create = input.action === 'create' || input.action === 'resubmit';
        if (event.kind !== refundRequestKind[input.action] || event.actorId !== actor.userId
            || (create ? originals[0]?.id !== refund.id || (refund.parameters.predecessorId ?? null) !== (input.action === 'resubmit' ? parentId : null) : refund.id !== parentId)) return outcome('conflict');
        // Legacy rows retain semantic facts but did not retain the wire body.
        // Do not manufacture an exact acknowledgement for them retroactively.
        const original = event.parameters?.requestEnvelope;
        if (!original) return outcome('unknown', { explanation: 'legacy_fact_without_exact_request_envelope' });
        if (original.schemaVersion !== 1 || original.action !== input.action || original.originalClientRequestId !== requestId
            || original.originalParameterHash !== creditNoteDigest(original.originalPayload)) throw new CashRefundError('INVALID_STATE', '原请求回执内容已损坏');
        if (original.originalParameterHash !== envelope.originalParameterHash
            || canonicalClaimJson(original.originalPayload) !== canonicalClaimJson(envelope.originalPayload)) return outcome('conflict');
        let normalized: any;
        try { normalized = normalizeRefundRequest(input.action, input.originalPayload, input.action === 'resubmit' ? parentId : undefined); }
        catch { return outcome('conflict'); }
        if (canonicalClaimJson(normalized) !== canonicalClaimJson(create ? refund.parameters : event.parameters.command)) throw new CashRefundError('INVALID_STATE', '原请求回执与业务执行参数不同');
        if (event.kind === 'Paid') {
          if (!settlement || settlement.kind !== 'CashRefund' || settlement.refundId !== refund.id || settlement.actorId !== actor.userId) throw new CashRefundError('INVALID_STATE', '实付回执缺少准确结算出口');
          await assertCreditNoteSettlementEvent(tx, note, settlement);
        } else if (settlement) return outcome('conflict');
        return outcome('applied', { ack: { eventId: event.id, auditId: event.auditId, kind: event.kind,
          refundId: refund.id, paymentRequestId: refund.paymentRequestId, versionId: refund.versionId,
          paymentVoucherId: event.parameters.paymentVoucherId ?? null, settlementEventId: event.parameters.settlementEventId ?? null,
          parametersHash: event.parametersHash, parameters: event.parameters, createdAt: String(event.createdAt),
          statusAtExecution: event.parameters.statusAfter } });
      }
      // No record is only an instant observation. A waiting/late writer may
      // still arrive. Only a COMMITTED fence closes that race permanently.
      await assertClaimCreditNoteAccount(tx, note);
      if (source) await assertRefundHistory(tx, source.refund);
      if (!retirement) return outcome('unknown');
      const checkedAt = new Date(), reason = retirement.reason.trim();
      const fact = { ...base, state: 'not_applied', retirementClientRequestId: retirement.retirementClientRequestId,
        reason, checkedAt: checkedAt.toISOString() };
      const audit = await tx.auditLog.create({ data: { id: refundFenceId(note.id, requestId), actorId: actor.userId,
        action: 'CREDIT_NOTE_REFUND_REQUEST_RETIRED', targetType: 'CreditNote', targetId: note.id,
        operationType: 'transition', detail: { cashRefundRequestFence: fact }, createdAt: checkedAt } });
      // $transaction must commit before this receipt reaches the caller; an
      // audit failure or commit error never emits negative execution proof.
      return outcome('not_applied', { fenceAuditId: audit.id, retirementClientRequestId: retirement.retirementClientRequestId,
        reason, checkedAt: checkedAt.toISOString() });
    });
  }
  return {
    result: (id: string, type: 'note' | 'refund', input: CashRefundRequestCheckInput, actor: TokenPayload) => resolve(id, type, input, actor),
    retire: (id: string, type: 'note' | 'refund', input: CashRefundRequestRetireInput, actor: TokenPayload) => resolve(id, type, input, actor,
      { retirementClientRequestId: input.retirementClientRequestId, reason: input.reason }),
  };
}
