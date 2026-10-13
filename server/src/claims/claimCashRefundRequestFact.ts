import { creditNoteDigest } from './claimCreditNoteVersionService';
import { canonicalClaimJson } from './claimApprovalFact';
import { normalizeCashRefundReturn } from './claimCashRefundReturnFact';
import { CashRefundError, refundAmount, refundDate, refundPayee, refundRequestId, refundRefusal } from './claimCashRefundFact';

export type CashRefundRequestAction = 'create' | 'start' | 'cancel' | 'confirm' | 'failure' | 'resubmit' | 'return';
export const refundRequestScope = (action: CashRefundRequestAction) => ['create', 'cancel', 'resubmit'].includes(action)
  ? 'finance:payment_request:create' : 'vouchers:write';
export const refundRequestKind: Record<CashRefundRequestAction, string> = {
  create: 'Requested', resubmit: 'Requested', start: 'Started', cancel: 'Cancelled', confirm: 'Paid', failure: 'Failed', return: 'Returned',
};
/** Wire intent is retained separately from normalized business parameters. A
 * semantic replay must not be misrepresented as proof of the exact saved body. */
export function refundRequestEnvelope(action: CashRefundRequestAction, input: any) {
  refundRequestId(input?.clientRequestId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CashRefundError('VALIDATION_FAILED', '原退款请求必须为完整对象');
  let payload: any;
  try {
    const json = JSON.stringify(input);
    if (json.length > 65536) throw Error('size');
    payload = JSON.parse(json);
    if (canonicalClaimJson(payload) !== canonicalClaimJson(input)) throw Error('json');
  } catch { throw new CashRefundError('VALIDATION_FAILED', '原退款请求须为完整 JSON，最大 64 KiB'); }
  return { schemaVersion: 1, action, originalClientRequestId: input.clientRequestId,
    originalPayload: payload, originalParameterHash: creditNoteDigest(payload) };
}
export function normalizeRefundRequest(action: CashRefundRequestAction, input: any, predecessorId?: string) {
  refundRequestId(input?.clientRequestId);
  if (action === 'return') return normalizeCashRefundReturn(input);
  const allowed: Record<Exclude<CashRefundRequestAction, 'return'>, string[]> = {
    create: ['clientRequestId', 'expectedVersion', 'amount', 'payeeSnapshot', 'expectedPaymentDate', 'reason'],
    resubmit: ['clientRequestId', 'expectedVersion', 'amount', 'payeeSnapshot', 'expectedPaymentDate', 'reason'],
    start: ['clientRequestId'], cancel: ['clientRequestId', 'reason'],
    confirm: ['clientRequestId', 'actualDate', 'actualMethod', 'paymentReference', 'evidenceIds','companyAccountId','expectedAccountRevision'],
    failure: ['clientRequestId', 'occurredAt', 'reference', 'evidenceIds', 'reason'],
  };
  if (Object.keys(input).some(key => !allowed[action].includes(key))) throw new CashRefundError('VALIDATION_FAILED', '退款操作含不支持的参数');
  if (action === 'create' || action === 'resubmit') {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || typeof input.reason !== 'string' || !input.reason.trim()) throw new CashRefundError('VALIDATION_FAILED', '退款申请须指定准确版本、金额和理由');
    return { expectedVersion: input.expectedVersion, amount: refundAmount(input.amount).toString(), payeeSnapshot: refundPayee(input.payeeSnapshot),
      expectedPaymentDate: input.expectedPaymentDate ? refundDate(input.expectedPaymentDate) : null, reason: input.reason.trim(), predecessorId: predecessorId ?? null };
  }
  if (action === 'start' || action === 'cancel') {
    if (input.reason != null && typeof input.reason !== 'string') throw new CashRefundError('VALIDATION_FAILED', '退款操作理由须为文字');
    const reason = input.reason?.trim() ?? null;
    if (action === 'cancel' && !reason) throw new CashRefundError('VALIDATION_FAILED', '撤回退款须填写理由');
    return { reason };
  }
  if (!Array.isArray(input.evidenceIds) || !input.evidenceIds.length || input.evidenceIds.some((id: any) => typeof id !== 'string' || !id.trim()) || new Set(input.evidenceIds).size !== input.evidenceIds.length) throw new CashRefundError('VALIDATION_FAILED', '须提供本退款真实服务端证据');
  const evidenceIds = [...input.evidenceIds].sort();
  if (action === 'confirm') {
    if (typeof input.paymentReference !== 'string' || !input.paymentReference.trim()) throw new CashRefundError('VALIDATION_FAILED', '实付确认须提供真实流水号');
    if(input.companyAccountId!=null&&(typeof input.companyAccountId!=='string'||!input.companyAccountId.trim()||!Number.isSafeInteger(input.expectedAccountRevision)))throw new CashRefundError('VALIDATION_FAILED','须核对真实退款公司账户和准确版本');
    return { paymentDate: refundDate(input.actualDate), paymentMethod: input.actualMethod, paymentReference: input.paymentReference.trim(), evidenceIds,
      ...(input.companyAccountId!=null?{companyAccountId:input.companyAccountId,expectedAccountRevision:input.expectedAccountRevision}:{}) };
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || typeof input.reference !== 'string' || !input.reference.trim()) throw new CashRefundError('VALIDATION_FAILED', '付款失败须有实际日期、流水及理由');
  return { occurredAt: refundDate(input.occurredAt), reference: input.reference.trim(), reason: input.reason.trim(), evidenceIds };
}
export function assertRefundReplayEnvelope(event: any, envelope: ReturnType<typeof refundRequestEnvelope>) {
  const previous = event?.parameters?.requestEnvelope;
  if (!previous) return; // Legacy semantic replay remains; exact-result reports unknown.
  if (previous.schemaVersion !== 1 || previous.originalParameterHash !== creditNoteDigest(previous.originalPayload)) refundRefusal('原退款请求回执已损坏');
  if (canonicalClaimJson(previous) !== canonicalClaimJson(envelope)) refundRefusal('同退款请求编号的完整原始请求不同，不能重放');
}
export const refundFenceId = (noteId: string, requestId: string) => 'cash_refund_fence_' + creditNoteDigest({ creditNoteId: noteId, requestId });
/** The CN parent is locked before this read by every command and retirement.
 * PK uniqueness and append-only AuditLog make the key terminal across actions,
 * actors and refund children. A mixed deployment with old writers is unsafe. */
export async function readRefundRequestFence(tx: any, noteId: string, requestId: string) {
  const row = await tx.auditLog.findUnique({ where: { id: refundFenceId(noteId, requestId) } });
  if (!row) return null;
  const fact = row.detail?.cashRefundRequestFence;
  if (row.action !== 'CREDIT_NOTE_REFUND_REQUEST_RETIRED' || row.targetType !== 'CreditNote' || row.targetId !== noteId
      || fact?.schemaVersion !== 1 || fact.state !== 'not_applied' || fact.parent?.creditNoteId !== noteId
      || fact.originalClientRequestId !== requestId || fact.actorId !== row.actorId
      || fact.originalParameterHash !== creditNoteDigest(fact.originalPayload)
      || fact.originalPayload?.clientRequestId !== requestId || !fact.retirementClientRequestId || !fact.reason
      || fact.checkedAt !== row.createdAt?.toISOString()) refundRefusal('退款请求封存事实已损坏，请人工核对');
  return { row, fact };
}
export async function assertRefundRequestNotRetired(tx: any, noteId: string, requestId: string, action?: CashRefundRequestAction, refundId?: string) {
  if (await readRefundRequestFence(tx, noteId, requestId)) refundRefusal('原请求编号已明确封存，不可迟到执行或改参数复用；请核对封存回执后使用新请求');
  if (!action) return;
  const refunds = await tx.creditNoteRefund.findMany({ where: { creditNoteId: noteId } });
  const originals = refunds.filter((row: any) => row.requestId === requestId);
  const events = await tx.creditNoteRefundEvent.findMany({ where: { refundId: { in: refunds.map((row: any) => row.id) }, requestId } });
  const returns = await tx.creditNoteRefundReturn.findMany({ where: { creditNoteId: noteId, requestId } });
  if (returns.length && (action !== 'return' || returns.length !== 1 || returns[0].refundId !== refundId)
      || action === 'return' && (originals.length || events.length)) refundRefusal('原编号已用于该退款账户的其他操作，不能改变操作种类重复消费');
  const create = action === 'create' || action === 'resubmit';
  if (events.some((event: any) => event.kind !== refundRequestKind[action] || (!create && event.refundId !== refundId))
      || (!create && originals.length) || originals.length > 1 || events.length > 1) refundRefusal('原编号已用于该退款账户的其他操作，请核对准确原结果');
}
