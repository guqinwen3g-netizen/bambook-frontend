import {commercialFields, QUOTATION_COMMERCIAL_FIELDS, QUOTATION_LINE_COMMERCIAL_FIELDS} from './quotationCommercial';
/** Current quotation permission is a verified source snapshot, never historical status alone. */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Quotation, QuotationLine } from '@prisma/client';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
export const quotationApprovalError = (code: string) => {
  const spec = lookupErrorCode(code);
  if (!spec) throw new Error('Quotation approval error code is not registered: ' + code);
  return businessError(code, spec.message);
};

export const ACTION_LINE_APPROVE = 'quotation:line_approve';
export const ACTION_TOTAL_APPROVE = 'quotation:total_approve';
export const isQuotationApproval = (value: { actionType?: string; targetType?: string }) =>
  value.actionType === ACTION_LINE_APPROVE || value.actionType === ACTION_TOTAL_APPROVE;
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function canonicalQuotationJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalQuotationJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalQuotationJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalQuotationJson(value)).digest('hex');
const text = (value: unknown) => value == null ? null : String(value);
function decimal(value: unknown): string {
  if (value == null || value === '') throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  const parsed = new Prisma.Decimal(String(value));
  if (!parsed.isFinite()) throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  return parsed.toString();
}
/** Excludes lifecycle timestamps/status and conversion pointer; freezes commercial content. */
export function buildQuotationSnapshot(quotation: any) {
  if (!quotation?.id || !Number.isSafeInteger(quotation.version) || quotation.version < 1
    || !quotation.currency || !Array.isArray(quotation.lines)
    || !Object.prototype.hasOwnProperty.call(quotation, 'notes')
    || (quotation.notes != null && typeof quotation.notes !== 'string'))
    throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  const lines = quotation.lines.map((line: any) => {
    if (!line.id || !Number.isSafeInteger(line.lineNumber) || !line.unit || !line.description)
      throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
    return { ...commercialFields(line, QUOTATION_LINE_COMMERCIAL_FIELDS, null), moq: line.moq == null ? null : decimal(line.moq), id: line.id, lineNumber: line.lineNumber, fabricCode: text(line.fabricCode), description: line.description,
      quantity: decimal(line.quantity), unit: line.unit, unitPrice: decimal(line.unitPrice), amount: decimal(line.amount),
      notes: text(line.notes), imageUrl: text(line.imageUrl), moqOverride: line.moqOverride ?? null };
  }).sort((a: any, b: any) => a.lineNumber - b.lineNumber || a.id.localeCompare(b.id));
  return { ...commercialFields(quotation, QUOTATION_COMMERCIAL_FIELDS, null), schemaVersion: 2, quotationId: quotation.id, quotationNumber: text(quotation.quotationNumber),
    version: quotation.version, currency: quotation.currency, totalAmount: decimal(quotation.totalAmount),
    customerRelationId: text(quotation.customerRelationId), customerName: text(quotation.customerName),
    customerCode: text(quotation.customerCode), developmentCaseId: text(quotation.developmentCaseId),
    orderId: text(quotation.orderId), orderLineId: text(quotation.orderLineId), issueDate: text(quotation.issueDate),
    validUntil: text(quotation.validUntil), deliveryTerms: text(quotation.deliveryTerms), paymentTerms: text(quotation.paymentTerms),
    paymentInstrument: text(quotation.paymentInstrument), baseCurrency: text(quotation.baseCurrency),
    notes: text(quotation.notes),
    exchangeRate: quotation.exchangeRate == null ? null : decimal(quotation.exchangeRate), lines };
}
export function buildQuotationApprovalSnapshot(quotation: any, actionType: string, targetId: string) {
  const quotationSnapshot = buildQuotationSnapshot(quotation);
  if (quotationSnapshot.lines.length === 0) throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  const targetType = actionType === ACTION_LINE_APPROVE ? 'QuotationLine' : actionType === ACTION_TOTAL_APPROVE ? 'Quotation' : null;
  if (!targetType || (targetType === 'Quotation' ? targetId !== quotation.id : !quotationSnapshot.lines.some((line: any) => line.id === targetId)))
    throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  const source = { actionType, targetType, targetId, quotationSnapshot };
  return { quotationSnapshot, contentFingerprint: fingerprint(source) };
}
export type QuotationApprovalSourceState = 'current' | 'stale' | 'legacy_unverified';
export function quotationApprovalSourceState(approval: any, quotation: any): QuotationApprovalSourceState {
  const payload = object(approval?.payload), snapshot = object(payload.quotationSnapshot);
  if (!isQuotationApproval(approval ?? {}) || snapshot.schemaVersion !== 2 || !Object.prototype.hasOwnProperty.call(snapshot, 'notes') || !payload.contentFingerprint
    || payload.quotationId !== quotation.id || snapshot.quotationId !== quotation.id) return 'legacy_unverified';
  if (fingerprint({ actionType: approval.actionType, targetType: approval.targetType, targetId: approval.targetId,
    quotationSnapshot: snapshot }) !== payload.contentFingerprint) return 'legacy_unverified';
  try {
    const current = buildQuotationApprovalSnapshot(quotation, approval.actionType, approval.targetId);
    return current.contentFingerprint === payload.contentFingerprint ? 'current' : 'stale';
  } catch { return 'stale'; }
}
export async function lockQuotationSource(tx: any, id: string): Promise<Quotation & { lines: QuotationLine[] }> {
  await tx.$queryRaw`SELECT "id" FROM "Quotation" WHERE "id" = ${id} FOR UPDATE`;
  const quotation = await tx.quotation.findUnique({ where: { id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
  if (!quotation || quotation.deletedAt) throw quotationApprovalError('NOT_FOUND');
  return quotation;
}
/** Candidate is only a routing hint; caller must lock/re-read the approval afterwards. */
export async function lockQuotationApprovalSource(tx: any, candidate: any): Promise<string | null> {
  if (!isQuotationApproval(candidate ?? {})) return null;
  const id = object(candidate.payload).quotationId;
  if (typeof id !== 'string' || !id) throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  await lockQuotationSource(tx, id);
  return id;
}
export async function assertCurrentQuotationApproval(tx: any, approval: any, lockedQuotationId: string) {
  if (object(approval.payload).quotationId !== lockedQuotationId) throw quotationApprovalError('SOURCE_CHANGED');
  const quotation = await tx.quotation.findUnique({ where: { id: lockedQuotationId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
  if (!quotation || quotation.deletedAt) throw quotationApprovalError('SOURCE_CHANGED');
  const state = quotationApprovalSourceState(approval, quotation);
  if (state !== 'current') throw quotationApprovalError(state === 'stale' ? 'QUOTATION_APPROVAL_STALE' : 'QUOTATION_APPROVAL_UNVERIFIED');
}
/** Mandatory decision fact identifies the immutable actor/date/source, across all four entrances. */
async function hasDecisionFact(db: any, approval: any): Promise<boolean> {
  if (!approval.decidedAt) return false;
  const actorId = approval.bossFinalBypassBy ?? approval.reviewerId;
  if (!actorId) return false;
  const audits = await db.auditLog.findMany({ where: { actorId, OR: [
    { targetType: 'ApprovalRequest', targetId: approval.id }, { detail: { path: ['approvalId'], equals: approval.id } },
  ] } });
  return audits.some((audit: any) => {
    const detail = object(audit.detail), fact = object(detail.approvalDecisionFact), authority = object(detail.decisionActorAuthority);
    const action = approval.status === 'approved' ? 'approve' : 'reject';
    const trustedEntrance = (audit.action === `${action}_business_request` && ['api:approvals','api:approvals-kernel'].includes(detail.source))
      || (audit.action === action && detail.source === 'api:admin')
      || (audit.action === `agent_approval_${approval.status}` && detail.source === 'api:agent')
      || (approval.status === 'approved' && audit.action === 'boss_final_bypass' && approval.bossFinalBypassBy === actorId
        && Array.isArray(authority.roles) && authority.roles.includes('owner'));
    return trustedEntrance && authority.userId === actorId && authority.authorizationLoaded === true
      && fact.schemaVersion === 1 && fact.status === approval.status && fact.actionType === approval.actionType
      && fact.targetType === approval.targetType && fact.targetId === approval.targetId
      && fact.contentFingerprint === object(approval.payload).contentFingerprint && fact.decisionActorId === actorId
      && fact.decidedAt === new Date(approval.decidedAt).toISOString();
  });
}
async function hasAmendmentDecisionFact(db: any, approval: any, quotation: any): Promise<boolean> {
  if (approval?.status !== 'approved' || !approval.decidedAt || !await hasDecisionFact(db, approval)) return false;
  const actorId = approval.bossFinalBypassBy ?? approval.reviewerId;
  const audits = await db.auditLog.findMany({ where: { actorId, targetType: 'ApprovalRequest', targetId: approval.id } });
  const decisionRows = audits.filter((audit: any) => {
    const detail = object(audit.detail), fact = object(detail.approvalDecisionFact);
    return fact.schemaVersion === 1 && fact.status === 'approved' && fact.actionType === approval.actionType
      && fact.targetType === approval.targetType && fact.targetId === approval.targetId
      && fact.decisionActorId === actorId && fact.decidedAt === new Date(approval.decidedAt).toISOString()
      && fact.contentFingerprint === object(approval.payload).contentFingerprint
      && typeof fact.quotationAmendmentAuditId === 'string';
  });
  if (decisionRows.length !== 1) return false;
  const decision = object(decisionRows[0].detail), fact = object(decision.approvalDecisionFact);
  const amendmentRows = audits.filter((audit: any) => audit.id === fact.quotationAmendmentAuditId
    && audit.action === 'quotation_approval_amended' && audit.targetType === 'ApprovalRequest'
    && audit.targetId === approval.id && audit.actorId === actorId);
  if (amendmentRows.length !== 1) return false;
  const amendment = object(amendmentRows[0].detail);
  try {
    const current = buildQuotationSnapshot(quotation);
    const currentFingerprint = fingerprint(current);
    const originalSnapshot = object(object(approval.payload).quotationSnapshot);
    return amendment.schemaVersion === 1 && amendment.approvalId === approval.id
      && amendment.quotationId === quotation.id && amendment.requesterId === approval.requesterId
      && amendment.decisionActorId === actorId && amendment.sourceVersion === originalSnapshot.version
      && amendment.sourceFingerprint === object(approval.payload).contentFingerprint
      && amendment.finalVersion === quotation.version && amendment.finalContentVersion === currentFingerprint
      && amendment.finalFingerprint === currentFingerprint
      && canonicalQuotationJson(amendment.finalSnapshot) === canonicalQuotationJson(current)
      && fact.finalContentVersion === currentFingerprint && fact.finalQuotationFingerprint === currentFingerprint
      && fact.finalQuotationVersion === quotation.version
      && decision.quotationAmendmentAuditId === amendmentRows[0].id;
  } catch { return false; }
}
export async function readQuotationApprovalState(db: any, approval: any, quotation: any): Promise<string> {
  if (!approval) return 'unrequested';
  const source = quotationApprovalSourceState(approval, quotation);
  if (source !== 'current') {
    if (source === 'stale' && await hasAmendmentDecisionFact(db, approval, quotation)) return 'approved';
    return source;
  }
  if (approval.status === 'approved' || approval.status === 'rejected')
    return await hasDecisionFact(db, approval) ? approval.status : 'legacy_unverified';
  return approval.status === 'pending' ? 'pending' : 'stale';
}
export async function readQuotationApprovalHistory(db: any, quotation: any) {
  return db.approvalRequest.findMany({ where: { actionType: { in: [ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE] }, OR: [
    { targetType: 'Quotation', targetId: quotation.id },
    { targetType: 'QuotationLine', targetId: { in: quotation.lines.map((line: any) => line.id) } },
    { payload: { path: ['quotationId'], equals: quotation.id } },
  ] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}
export function quotationPendingBlocker(history: any[], quotation: any): 'pending' | 'legacy_unverified' | null {
  const sources = history.filter(row => row.status === 'pending').map(row => quotationApprovalSourceState(row, quotation));
  if (sources.includes('legacy_unverified')) return 'legacy_unverified';
  return sources.includes('current') ? 'pending' : null;
}
export async function assertQuotationApprovalConsumption(db: any, quotation: any, operation: 'send' | 'convert' = 'send') {
  const history = await readQuotationApprovalHistory(db, quotation);
  if (history.length === 0) throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED'); // Every issued version needs a whole-quotation decision.
  const latest = (action: string, targetId: string) => history.find((row: any) => row.actionType === action && row.targetId === targetId);
  const total = latest(ACTION_TOTAL_APPROVE, quotation.id);
  const totalState = await readQuotationApprovalState(db, total, quotation);
  const lineStates = await Promise.all(quotation.lines.map((line: any) => readQuotationApprovalState(db, latest(ACTION_LINE_APPROVE, line.id), quotation)));
  if (quotationPendingBlocker(history, quotation) === 'legacy_unverified') throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  const currentPending = history.find((row: any) => row.status === 'pending' && quotationApprovalSourceState(row, quotation) === 'current');
  if (currentPending || totalState === 'pending' || lineStates.includes('pending')) throw Object.assign(quotationApprovalError('QUOTATION_APPROVAL_PENDING'), {
    approvalRequestId: currentPending?.id ?? history.find((row: any) => row.status === 'pending')?.id,
    message: `报价单 ${quotation.quotationNumber} 仍有待审批条目或总价，需审批通过后方可${operation === 'convert' ? '转换订单' : '发送'}（门禁：quotation-approval）`,
  });
  if (totalState === 'rejected' || lineStates.includes('rejected')) throw quotationApprovalError('QUOTATION_APPROVAL_REJECTED');
  if (totalState === 'approved') return;
  if (totalState === 'legacy_unverified' || lineStates.includes('legacy_unverified')) throw quotationApprovalError('QUOTATION_APPROVAL_UNVERIFIED');
  throw quotationApprovalError('QUOTATION_APPROVAL_STALE');
}
export function assertSameQuotationSource(before: any, after: any) {
  if (canonicalQuotationJson(buildQuotationSnapshot(before)) !== canonicalQuotationJson(buildQuotationSnapshot(after)))
    throw quotationApprovalError('SOURCE_CHANGED');
}
