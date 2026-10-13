import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { isValidLocalDateKey } from '../shared/localDate';
import { httpStatusOfCode } from '../shared/errorCodes';
import { canonicalClaimJson } from './claimApprovalFact';
import { assertClaimCreditNoteAccount, creditNoteDigest, lockCreditNoteForSettlement } from './claimCreditNoteVersionService';

export const CASH_REFUND_ACTION = 'finance:payment_request';
export const CASH_REFUND_TARGET = 'PaymentRequest';
export const CASH_REFUND_RESERVED = ['PendingApproval', 'Approved', 'Executing'] as const;
export type CashRefundCode = 'VALIDATION_FAILED' | 'INVALID_STATE' | 'NOT_FOUND' | 'OVER_APPLIED'
  | 'CURRENCY_MISMATCH' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'AUTHORIZATION_UNAVAILABLE';
export class CashRefundError extends Error {
  readonly statusCode: number;
  constructor(readonly code: CashRefundCode, message: string) { super(message); this.statusCode = httpStatusOfCode(code); }
}
type CashRefundRefusal = Readonly<{ code: CashRefundCode; statusCode: number; message: string }>;
const cashRefundRefusals = new WeakMap<object, CashRefundRefusal>();
export const readCashRefundRefusal = (error: unknown): CashRefundRefusal | undefined =>
  typeof error === 'object' && error !== null ? cashRefundRefusals.get(error) : undefined;
export const refundRefusal = (message: string): never => {
  const error = new CashRefundError('INVALID_STATE', message);
  cashRefundRefusals.set(error, Object.freeze({ code: error.code, statusCode: error.statusCode, message }));
  throw error;
};
export const refundId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
export type CashRefundVisibility = (tx: any, creditNote: any, actor: TokenPayload) => Promise<void>;

/** A verified credential identifies the actor, while authority is loaded again
 * from this transaction. A missing account, grant or visibility provider cannot
 * fall back to labels, a legacy JWT or an invented company-wide data scope. */
export async function currentRefundActor(tx: any, prior: TokenPayload, scope?: string): Promise<TokenPayload> {
  if (!prior?.userId) throw new CashRefundError('UNAUTHORIZED', '退款操作需要登录主体');
  let user;
  try { user = await loadUserWithRoles(tx, prior.userId); }
  catch { throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验退款账号，请稍后重试'); }
  if (!user || user.status !== 'active' || user.deletedAt != null) throw new CashRefundError('UNAUTHORIZED', '当前账号不可执行退款');
  let actor: TokenPayload;
  try { actor = await buildLoadedAuthTokenPayload(tx, user); }
  catch { throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验退款权限，请稍后重试'); }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (scope && !hasScope(actor, scope as any)) throw new CashRefundError('FORBIDDEN', `退款操作需要权限 ${scope}`);
  return actor;
}
export async function requireRefundVisibility(tx: any, note: any, actor: TokenPayload, visible?: CashRefundVisibility) {
  if (!visible) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '退款行范围校验尚未配置，暂不可访问');
  await visible(tx, note, actor);
}
export function refundRequestId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new CashRefundError('VALIDATION_FAILED', '须提供 1–200 字符稳定 clientRequestId');
  return value;
}
export function refundDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CashRefundError('VALIDATION_FAILED', '须提供真实 YYYY-MM-DD 日期');
  if (!isValidLocalDateKey(value)) throw new CashRefundError('VALIDATION_FAILED', '付款日期不存在');
  return value;
}
export function refundAmount(value: unknown): Prisma.Decimal {
  if (typeof value !== 'string' && typeof value !== 'number') throw new CashRefundError('VALIDATION_FAILED', '退款金额必须为完整十进制数');
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) throw new CashRefundError('VALIDATION_FAILED', '退款金额须为完整十进制正数');
  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(value); } catch { throw new CashRefundError('VALIDATION_FAILED', '退款金额不合法'); }
  if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 4 || amount.gte('100000000000000')) throw new CashRefundError('VALIDATION_FAILED', '退款金额须为正数，按数据库精度完整保存，不可隐式舍入');
  return amount;
}
export function refundPayee(value: any) {
  const fields = ['accountHolder', 'accountNumber', 'bankName', 'swift', 'method'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key) || typeof value[key] !== 'string')) throw new CashRefundError('VALIDATION_FAILED', '须提供完整真实收款方账户快照');
  const text = (key: string) => typeof value[key] === 'string' ? value[key].trim() : '';
  const result = { accountHolder: text('accountHolder'), accountNumber: text('accountNumber'), bankName: text('bankName'), swift: text('swift'), method: text('method') };
  if (!result.accountHolder || !['TT', 'LC', 'OA', 'DP', 'DA', 'Cash', 'Other'].includes(result.method)
      || (result.method !== 'Cash' && (!result.accountNumber || !result.bankName))) throw new CashRefundError('VALIDATION_FAILED', '收款方、真实付款方式及适用银行账户必填');
  return result;
}

export async function lockCashRefund(tx: any, id: string) {
  const hint = await tx.creditNoteRefund.findUnique({ where: { id } });
  if (!hint) throw new CashRefundError('NOT_FOUND', '客户退款申请不存在');
  const creditNote = await lockCreditNoteForSettlement(tx, hint.creditNoteId);
  await tx.$queryRawUnsafe('SELECT id FROM "CreditNoteRefund" WHERE id = $1 FOR UPDATE', id);
  const refund = await tx.creditNoteRefund.findUnique({ where: { id } });
  if (!refund || refund.creditNoteId !== hint.creditNoteId) refundRefusal('退款来源已变化，请重新加载');
  await tx.$queryRawUnsafe('SELECT id FROM "PaymentRequest" WHERE id = $1 FOR UPDATE', refund.paymentRequestId);
  const paymentRequest = await tx.paymentRequest.findUnique({ where: { id: refund.paymentRequestId } });
  if (!paymentRequest || paymentRequest.deletedAt) refundRefusal('退款缺少真实付款申请');
  return { creditNote, refund, paymentRequest };
}
/** Kernel calls this before locking the payment approval: same case → claim
 * sources → CN → refund → PR → payment approval order as consumption. */
export async function lockCashRefundByPaymentRequest(tx: any, paymentRequestId: string) {
  const hint = await tx.creditNoteRefund.findUnique({ where: { paymentRequestId } });
  return hint ? lockCashRefund(tx, hint.id) : null;
}
export async function cashRefundApprovalPayload(tx: any, refund: any, pr: any) {
  try { refundAmount(String(refund.amount)); }
  catch { refundRefusal('退款来源金额不符合真实正金额及数据库精度，请人工核对'); }
  const version = await tx.creditNoteDocumentVersion.findUnique({ where: { id: refund.versionId } });
  const note = await tx.creditNote.findUnique({ where: { id: refund.creditNoteId } });
  const customer = await tx.relation.findUnique({ where: { id: refund.customerRelationId } });
  if (!version || !note || !customer || customer.deletedAt || customer.category !== 'Customer' || version.creditNoteId !== note.id
      || !note.claimCaseId || note.logicalClaimCaseId !== note.claimCaseId
      || version.linesSnapshot?.claimCaseId !== note.claimCaseId
      || note.customerRelationId !== customer.id || version.currency !== refund.currency || note.currency !== refund.currency
      || version.contentFingerprint !== creditNoteDigest(version.linesSnapshot)
      || version.linesSnapshot?.customerRelationId !== customer.id || pr.payeeType !== 'Customer'
      || pr.customerRelationId !== customer.id || pr.customerName !== note.customerName || pr.supplierId || pr.supplierName
      || pr.id !== refund.paymentRequestId || pr.applicantId !== refund.requesterId || pr.currency !== refund.currency
      || !new Prisma.Decimal(pr.totalAmount).equals(refund.amount) || pr.paymentCategory !== 'customer_reimburse') refundRefusal('客户退款的账户、版本、金额或真实收款方与付款申请不一致');
  const payeeSnapshot = refundPayee(refund.payeeSnapshot);
  if (canonicalClaimJson(payeeSnapshot) !== canonicalClaimJson(refund.payeeSnapshot)) refundRefusal('退款账户快照已损坏');
  const content = { schemaVersion: 1, refund: { id: refund.id, creditNoteId: note.id, versionId: version.id,
    amount: String(refund.amount), currency: refund.currency, customerRelationId: customer.id,
    payeeSnapshot, requesterId: refund.requesterId, createdAt: String(refund.createdAt) },
    version: { id: version.id, version: version.version, contentFingerprint: version.contentFingerprint, linesSnapshot: version.linesSnapshot },
    paymentRequest: { id: pr.id, requestNumber: pr.requestNumber, applicantId: pr.applicantId, payeeType: pr.payeeType,
      customerRelationId: pr.customerRelationId, customerName: pr.customerName, totalAmount: String(pr.totalAmount),
      currency: pr.currency, paymentCategory: pr.paymentCategory, requestDate: pr.requestDate,
      expectedPaymentDate: pr.expectedPaymentDate ?? null, remark: pr.remark ?? null } };
  return { schemaVersion: 1, refundId: refund.id, creditNoteId: note.id, content, contentFingerprint: creditNoteDigest(content) };
}
function approvalPayloadWithoutResolution(approval: any) {
  const { resolution: _resolution, ...payload } = approval.payload ?? {};
  return payload;
}
export async function assertCashRefundDecisionFact(tx: any, approval: any) {
  if (approval.actionType !== CASH_REFUND_ACTION || approval.targetType !== CASH_REFUND_TARGET || !approval.targetId) refundRefusal('客户退款审批动作或目标错误');
  const source = await lockCashRefundByPaymentRequest(tx, approval.targetId);
  if (!source) return; // ordinary supplier approvals retain their existing contract
  const { refund, paymentRequest } = source;
  await assertClaimCreditNoteAccount(tx, source.creditNote);
  await assertRefundHistory(tx, refund);
  const payload = await cashRefundApprovalPayload(tx, refund, paymentRequest);
  if (refund.status !== 'PendingApproval' || paymentRequest.status !== 'Pending' || paymentRequest.approvalRequestId !== approval.id
      || refund.contentFingerprint !== payload.contentFingerprint
      || canonicalClaimJson(approvalPayloadWithoutResolution(approval)) !== canonicalClaimJson(payload)) refundRefusal('退款申请已撤回、失效或内容变化，不能再批准原请求');
}
export async function readCashRefundDecision(tx: any, refund: any, pr: any, expected: 'approved' | 'rejected' = 'approved') {
  await tx.$queryRawUnsafe('SELECT id FROM "ApprovalRequest" WHERE id = $1 FOR UPDATE', pr.approvalRequestId);
  const approval = await tx.approvalRequest.findUnique({ where: { id: pr.approvalRequestId } });
  const payload = await cashRefundApprovalPayload(tx, refund, pr);
  if (!approval || approval.status !== expected || approval.actionType !== CASH_REFUND_ACTION
      || approval.targetType !== CASH_REFUND_TARGET || approval.targetId !== pr.id || approval.requesterId !== refund.requesterId
      || refund.contentFingerprint !== payload.contentFingerprint
      || canonicalClaimJson(approvalPayloadWithoutResolution(approval)) !== canonicalClaimJson(payload)) refundRefusal('退款缺少准确的付款批准事实，须重新送审');
  const actorId = approval.bossFinalBypassBy || approval.reviewerId;
  if (!actorId || actorId === refund.requesterId || !approval.decidedAt) refundRefusal('退款缺少真实非自审决议主体');
  const audits = await tx.auditLog.findMany({ where: { actorId, OR: [
    { targetType: 'ApprovalRequest', targetId: approval.id }, { detail: { path: ['approvalId'], equals: approval.id } },
  ] } });
  const matches = audits.filter((row: any) => {
    const fact = row.detail?.approvalDecisionFact, authority = row.detail?.decisionActorAuthority;
    return fact?.schemaVersion === 1 && fact.status === expected && fact.actionType === CASH_REFUND_ACTION
      && fact.targetType === CASH_REFUND_TARGET && fact.targetId === pr.id && fact.contentFingerprint === payload.contentFingerprint
      && fact.decisionActorId === actorId && fact.decidedAt === approval.decidedAt.toISOString()
      && authority?.authorizationLoaded === true && authority.userId === actorId && Array.isArray(authority.roleIds);
  });
  if (matches.length !== 1 || (refund.decisionAuditId && refund.decisionAuditId !== matches[0].id)) refundRefusal('退款付款批准缺少唯一不可变决议审计');
  return { approval, decisionAuditId: matches[0].id, decisionActorId: actorId };
}

export async function appendRefundEvent(tx: any, refund: any, kind: string, actorId: string, requestId: string, parameters: any) {
  const eventId = refundId('CNRE'), auditId = refundId('alog'), createdAt = BigInt(Date.now());
  const previous = await tx.creditNoteRefundEvent.findFirst({ where: { refundId: refund.id }, orderBy: { sequence: 'desc' } });
  const sequence = (previous?.sequence ?? 0) + 1;
  const parametersHash = creditNoteDigest(parameters);
  await tx.auditLog.create({ data: { id: auditId, actorId, action: 'CREDIT_NOTE_REFUND_EVENT',
    targetType: 'CreditNoteRefund', targetId: refund.id, operationType: 'transition',
    detail: { cashRefundEvent: { schemaVersion: 1, eventId, sequence, kind, actorId, requestId, parameters, parametersHash, createdAt: String(createdAt) } } } });
  return tx.creditNoteRefundEvent.create({ data: { id: eventId, refundId: refund.id, sequence, kind, actorId, requestId, parameters, parametersHash, auditId, createdAt } });
}
export async function assertRefundEvent(tx: any, event: any) {
  const audit = await tx.auditLog.findUnique({ where: { id: event.auditId } });
  const fact = audit?.detail?.cashRefundEvent;
  if (!audit || audit.actorId !== event.actorId || audit.action !== 'CREDIT_NOTE_REFUND_EVENT'
      || audit.targetType !== 'CreditNoteRefund' || audit.targetId !== event.refundId
      || fact?.schemaVersion !== 1 || fact.eventId !== event.id || fact.sequence !== event.sequence || fact.kind !== event.kind || fact.actorId !== event.actorId
      || fact.requestId !== event.requestId || fact.createdAt !== String(event.createdAt)
      || fact.parametersHash !== event.parametersHash || event.parametersHash !== creditNoteDigest(event.parameters)
      || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(event.parameters)) refundRefusal('客户退款执行事件与必需审计不一致');
}
export async function refundReplay(tx: any, refund: any, kind: string, actorId: string, requestId: string, parameters: any) {
  const event = await tx.creditNoteRefundEvent.findUnique({ where: { refundId_requestId: { refundId: refund.id, requestId } } });
  if (!event) return null;
  await assertRefundEvent(tx, event);
  if (event.kind !== kind || event.actorId !== actorId
      || canonicalClaimJson(event.parameters.command ?? event.parameters) !== canonicalClaimJson(parameters)) refundRefusal('同退款请求的主体或完整参数不同，不可重放');
  return event;
}
export async function cashRefundReservedAmount(tx: any, noteId: string, excludeId?: string) {
  const refunds = await tx.creditNoteRefund.findMany({ where: { creditNoteId: noteId } });
  let amount = new Prisma.Decimal(0);
  for (const refund of refunds) {
    await assertRefundHistory(tx, refund);
    if (refund.id !== excludeId && (CASH_REFUND_RESERVED as readonly string[]).includes(refund.status)) amount = amount.plus(refund.amount);
  }
  return amount;
}
export async function assertRefundHistory(tx: any, refund: any) {
  const events = await tx.creditNoteRefundEvent.findMany({ where: { refundId: refund.id }, orderBy: { sequence: 'asc' } });
  if (!events.length) refundRefusal('退款预留缺少不可变请求事件');
  const transitions: Record<string, [string | null, string]> = {
    Requested: [null, 'PendingApproval'], Approved: ['PendingApproval', 'Approved'], Rejected: ['PendingApproval', 'Rejected'],
    Started: ['Approved', 'Executing'], Paid: ['Executing', 'Paid'], Failed: ['Executing', 'Approved'],
  };
  let status: string | null = null;
  for (const [index, event] of events.entries()) {
    await assertRefundEvent(tx, event);
    let allowed = transitions[event.kind];
    if (event.kind === 'Cancelled' || event.kind === 'Invalidated') {
      if (!['PendingApproval', 'Approved'].includes(status ?? '')) refundRefusal('已执行或实付的退款不可假取消释放余额');
      allowed = [status, event.kind];
    }
    if (event.kind === 'Resubmitted') {
      if (!['Rejected', 'Cancelled', 'Invalidated'].includes(status ?? '')) refundRefusal('退款重送审历史状态不合法');
      allowed = [status, status!];
    }
    if (!allowed || event.sequence !== index + 1 || status !== allowed[0] || event.parameters.statusBefore !== status
        || event.parameters.statusAfter !== allowed[1]) refundRefusal('退款状态或事件次序与真实历史不一致');
    status = allowed[1];
  }
  const requested = events[0];
  const pr = await tx.paymentRequest.findUnique({ where: { id: refund.paymentRequestId } });
  const payload = pr && await cashRefundApprovalPayload(tx, refund, pr);
  if (status !== refund.status || requested.actorId !== refund.requesterId || requested.requestId !== refund.requestId
      || requested.parameters.requestParametersHash !== refund.parametersHash
      || refund.parametersHash !== creditNoteDigest(refund.parameters)
      || String(refund.amount) !== refund.parameters.amount
      || canonicalClaimJson(refund.payeeSnapshot) !== canonicalClaimJson(refund.parameters.payeeSnapshot)
      || !payload || requested.parameters.contentFingerprint !== refund.contentFingerprint
      || refund.contentFingerprint !== payload.contentFingerprint || requested.parameters.approvalRequestId !== pr.approvalRequestId) refundRefusal('退款请求或状态投影已损坏，请核对原事实后续办');
  const decisions = events.filter((event: any) => event.kind === 'Approved' || event.kind === 'Rejected');
  if (decisions.length > 1 || (decisions.length === 0 && refund.decisionAuditId)) refundRefusal('退款决议历史不唯一或投影错误');
  for (const event of decisions) {
    const decision = await readCashRefundDecision(tx, refund, pr, event.kind === 'Approved' ? 'approved' : 'rejected');
    if (event.actorId !== decision.decisionActorId || event.requestId !== 'decision:' + decision.decisionAuditId
        || event.parameters.decisionAuditId !== decision.decisionAuditId || event.parameters.approvalRequestId !== decision.approval.id
        || event.parameters.contentFingerprint !== refund.contentFingerprint || refund.decisionAuditId !== decision.decisionAuditId) refundRefusal('退款批准或驳回事件与真实原决议不一致');
  }
  return events;
}

/** All generic HTTP and Agent voucher/allocation mutations call this using the
 * current transaction. A real FK is the gate; notes/attachments cannot confer it. */
export async function assertNotCashRefundVoucher(tx: any, voucherId: string) {
  // Shared with bank-return consumption: FK recheck after the receipt lock
  // closes ordinary update/allocation vs. refund-return binding races.
  await tx.$queryRawUnsafe('SELECT id FROM "PaymentVoucher" WHERE id = $1 FOR UPDATE', voucherId);
  const cashReturn = await tx.creditNoteRefundReturn.findUnique({ where: { receiptVoucherId: voucherId } });
  if (cashReturn) refundRefusal('实际银行返款收款已恢复原贷项负债，不可再分配发票、改写、作废或删除；请从专用返款事实核对');
  const refund = await tx.creditNoteRefund.findUnique({ where: { paymentVoucherId: voucherId } });
  if (refund) refundRefusal('客户实付退款凭证不可独立改写、核销、作废或删除；实际银行返款须走后续专用返款流程');
}

export async function assertCashRefundSettlement(tx: any, note: any, event: any) {
  if (!event.refundId || !event.paymentVoucherId || event.invoiceId || event.refundReturnId || event.sourceEventId || event.kind !== 'CashRefund') refundRefusal('现金退款结算缺少真实付款出口');
  const refund = await tx.creditNoteRefund.findUnique({ where: { id: event.refundId } });
  const voucher = await tx.paymentVoucher.findUnique({ where: { id: event.paymentVoucherId } });
  const pr = refund && await tx.paymentRequest.findUnique({ where: { id: refund.paymentRequestId } });
  if (!refund || !voucher || !pr || refund.status !== 'Paid' || refund.creditNoteId !== note.id || refund.paymentVoucherId !== voucher.id
      || pr.status !== 'Paid' || pr.paymentVoucherId !== voucher.id || voucher.deletedAt || voucher.status === 'cancelled'
      || voucher.type !== 'Disbursement' || voucher.customerRelationId !== refund.customerRelationId
      || voucher.currency !== event.currency || event.currency !== note.currency || !new Prisma.Decimal(voucher.amount).equals(event.amount)
      || !new Prisma.Decimal(refund.amount).equals(event.amount)) refundRefusal('现金退款结算与客户真实付款事实不一致');
  const paid = await tx.creditNoteRefundEvent.findMany({ where: { refundId: refund.id, kind: 'Paid' } });
  if (paid.length !== 1) refundRefusal('现金退款缺少唯一实付确认事件');
  await assertRefundEvent(tx, paid[0]);
  const parameters = paid[0].parameters;
  if (paid[0].actorId !== event.actorId || paid[0].requestId !== event.requestId || parameters.settlementEventId !== event.id
      || parameters.paymentVoucherId !== voucher.id || parameters.paymentDate !== voucher.paymentDate || parameters.paymentMethod !== voucher.paymentMethod
      || !parameters.paymentReference || !Array.isArray(parameters.evidenceIds) || !parameters.evidenceIds.length
      || voucher.attachments?.paymentReference !== parameters.paymentReference
      || canonicalClaimJson(voucher.attachments?.evidenceIds) !== canonicalClaimJson(parameters.evidenceIds)
      || canonicalClaimJson(event.parameters) !== canonicalClaimJson(parameters)
      || event.parametersHash !== creditNoteDigest(parameters)) refundRefusal('现金退款实付日期、方式、流水或证据不完整');
  const evidence = await tx.creditNoteRefundEvidence.findMany({ where: { id: { in: parameters.evidenceIds }, refundId: refund.id, purpose: 'PaymentProof' } });
  if (evidence.length !== new Set(parameters.evidenceIds).size || evidence.some((row: any) => !/^[a-f0-9]{64}$/.test(row.sha256) || row.fileSize <= 0)) refundRefusal('实付确认缺少服务端持久化付款证据');
  for (const row of evidence) await assertCashRefundEvidence(tx, row);
  await readCashRefundDecision(tx, refund, pr);
  return paid[0];
}
export async function assertCashRefundEvidence(tx: any, evidence: any) {
  const audits = await tx.auditLog.findMany({ where: { action: 'CREDIT_NOTE_REFUND_EVIDENCE_ADDED', targetType: 'CreditNoteRefundEvidence', targetId: evidence.id } });
  const fact = audits[0]?.detail?.evidence;
  if (audits.length !== 1 || audits[0].actorId !== evidence.uploadedBy || fact?.schemaVersion !== 1
      || fact.refundId !== evidence.refundId || fact.evidenceId !== evidence.id || fact.sha256 !== evidence.sha256
      || fact.fileSize !== evidence.fileSize || fact.purpose !== evidence.purpose || fact.uploadedBy !== evidence.uploadedBy
      || fact.uploadedAt !== String(evidence.uploadedAt)) refundRefusal('付款证据缺少准确的服务端上传及必需审计');
}
