import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import type { ClaimError } from './claimCaseService';
import { httpStatusOfCode } from '../shared/errorCodes';

export const CLAIM_APPROVAL_ACTION = 'aftersales:claim-disposition';
export const CLAIM_APPROVAL_TARGET = 'ClaimDisposition';
export const CLAIM_LEADER_ROLE_IDS = [SYSTEM_ROLE_IDS.ADMIN, 'role_admin', 'admin'];
export const CLAIM_BOSS_ROLE_IDS = [SYSTEM_ROLE_IDS.SUPER_ADMIN, 'role_super_admin', 'role_owner'];

/** Stable JSON content comparison; lifecycle projections are not business revisions. */
export function canonicalClaimJson(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalClaimJson).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalClaimJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

const decimal = (value: any) => value == null ? null : new Prisma.Decimal(String(value)).toString();
const nullable = (value: any) => value ?? null;

/** All fields come from persisted rows, never a client-provided approval snapshot. */
export function buildClaimApprovalPayload(disposition: any, claimCase: any) {
  const content = {
    disposition: {
      id: disposition.id, claimCaseId: disposition.claimCaseId, kind: disposition.kind,
      materialCode: nullable(disposition.materialCode), quantity: decimal(disposition.quantity),
      unit: nullable(disposition.unit), amount: decimal(disposition.amount), currency: nullable(disposition.currency),
      returnDisposition: nullable(disposition.returnDisposition), notes: nullable(disposition.notes),
      createdAt: String(disposition.createdAt),
    },
    claimCase: {
      id: claimCase.id, caseNumber: claimCase.caseNumber,
      customerRelationId: nullable(claimCase.customerRelationId), customerName: nullable(claimCase.customerName),
      sourceOrderId: nullable(claimCase.sourceOrderId), sourceInvoiceId: nullable(claimCase.sourceInvoiceId),
      category: nullable(claimCase.category), problemDesc: claimCase.problemDesc,
      attachments: nullable(claimCase.attachments), reportedAt: claimCase.reportedAt,
      reportedBy: claimCase.reportedBy, notes: nullable(claimCase.notes), createdAt: String(claimCase.createdAt),
    },
  };
  return {
    schemaVersion: 1,
    claimCaseId: disposition.claimCaseId, kind: disposition.kind,
    amount: content.disposition.amount, currency: content.disposition.currency,
    quantity: content.disposition.quantity, returnDisposition: content.disposition.returnDisposition,
    materialCode: content.disposition.materialCode, unit: content.disposition.unit,
    content,
    contentFingerprint: createHash('sha256').update(canonicalClaimJson(content)).digest('hex'),
  };
}

export class ClaimTransactionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(readonly claimError: ClaimError) {
    super(claimError.message);
    this.code = claimError.code;
    this.statusCode = httpStatusOfCode(claimError.code);
  }
}

export function claimRefusal(message: string): never {
  throw new ClaimTransactionError({ code: 'INVALID_STATE', message });
}

/** A failing Result must escape an interactive transaction, not commit its earlier writes. */
export function requireClaimResult<T>(result: { ok: boolean; data?: T; error?: { code: string; message: string } }): T {
  if (!result.ok) throw new ClaimTransactionError(result.error! as ClaimError);
  return result.data!;
}

export function assertClaimSnapshot(approval: any, disposition: any, claimCase: any) {
  const expected = buildClaimApprovalPayload(disposition, claimCase);
  const payload = approval.payload;
  if (approval.actionType !== CLAIM_APPROVAL_ACTION || approval.targetType !== CLAIM_APPROVAL_TARGET
      || approval.targetId !== disposition.id || disposition.deletedAt || claimCase.deletedAt
      || disposition.claimCaseId !== claimCase.id || claimCase.status === 'Cancelled'
      || payload?.schemaVersion !== 1 || payload?.contentFingerprint !== expected.contentFingerprint
      || canonicalClaimJson(payload?.content) !== canonicalClaimJson(expected.content)
      || ['claimCaseId', 'kind', 'amount', 'currency', 'quantity', 'returnDisposition', 'materialCode', 'unit']
        .some(key => !Object.prototype.hasOwnProperty.call(payload ?? {}, key) || canonicalClaimJson(payload[key]) !== canonicalClaimJson((expected as any)[key]))) {
    claimRefusal('批准事实与当前处置及案件来源不一致，需重新提交审批；旧六字段批准不能自动补造');
  }
  return expected;
}

/** Called by the common decision kernel, while its ApprovalRequest row is locked. */
export async function assertClaimDecisionAuthority(tx: any, approval: any, actor: { userId: string }, mode: 'normal' | 'boss') {
  const disposition = await tx.claimDisposition.findUnique({ where: { id: approval.targetId } });
  if (!disposition) claimRefusal('索赔审批目标不存在');
  const claimCase = await tx.claimCase.findUnique({ where: { id: disposition.claimCaseId } });
  if (!claimCase) claimRefusal('索赔案件不存在');
  assertClaimSnapshot(approval, disposition, claimCase);
  if (disposition.status !== 'Draft') claimRefusal('处置不再待批，不可生成新的批准决定');
  const account = await tx.userAccount.findFirst({ where: { id: actor.userId, status: 'active', deletedAt: null }, select: { id: true } });
  const rows = account ? await tx.userRole.findMany({ where: { userId: actor.userId }, select: { roleId: true } }) : [];
  const roleIds: string[] = [...new Set<string>(rows.map((row: any) => row.roleId))];
  const required = mode === 'boss' ? CLAIM_BOSS_ROLE_IDS : CLAIM_LEADER_ROLE_IDS;
  if (!roleIds.some(roleId => required.includes(roleId))) {
    const error = Object.assign(new Error('索赔任何金额须总领导批准；普通主管委派与审批标签不能替代领导批准'), { code: 'CLAIM_LEADER_REQUIRED', statusCode: 403 });
    throw error;
  }
  return { userId: actor.userId, roleIds, roles: [mode === 'boss' ? 'owner' : 'admin'], authorizationLoaded: true as const };
}

export async function lockClaimRows(tx: any, dispositionId: string) {
  const initial = await tx.claimDisposition.findUnique({ where: { id: dispositionId } });
  if (!initial || initial.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: `处置 ${dispositionId} 不存在` });
  await tx.$queryRawUnsafe('SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', initial.claimCaseId);
  await tx.$queryRawUnsafe('SELECT id FROM "ClaimDisposition" WHERE id = $1 FOR UPDATE', dispositionId);
  const disposition = await tx.claimDisposition.findUnique({ where: { id: dispositionId } });
  if (!disposition || disposition.deletedAt || disposition.claimCaseId !== initial.claimCaseId) claimRefusal('处置来源已变更，请刷新重试');
  const claimCase = await tx.claimCase.findUnique({ where: { id: disposition.claimCaseId } });
  if (!claimCase || claimCase.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '售后案件不存在' });
  return { disposition, claimCase };
}

/** Exact target + complete content + immutable server decision/audit. Never pick a fuzzy latest approval. */
export async function readClaimApprovedFact(tx: any, disposition: any, claimCase: any) {
  await tx.$queryRawUnsafe('SELECT id FROM "ApprovalRequest" WHERE "actionType" = $1 AND "targetType" = $2 AND "targetId" = $3 FOR UPDATE', CLAIM_APPROVAL_ACTION, CLAIM_APPROVAL_TARGET, disposition.id);
  const rows = await tx.approvalRequest.findMany({ where: { actionType: CLAIM_APPROVAL_ACTION, targetType: CLAIM_APPROVAL_TARGET, targetId: disposition.id } });
  const matching = rows.filter((row: any) => {
    if (row.status !== 'approved') return false;
    try { assertClaimSnapshot(row, disposition, claimCase); return true; } catch (error) { if (error instanceof ClaimTransactionError) return false; throw error; }
  });
  if (matching.length !== 1) claimRefusal('缺少唯一、完整匹配的内核批准事实，请补审或处理重复审批');
  const approval = matching[0];
  if (rows.some((row: any) => row.status === 'pending' || (row.id !== approval.id && new Date(row.createdAt).getTime() >= new Date(approval.createdAt).getTime()))) {
    claimRefusal('存在未决或更新的审批，不能恢复使用历史批准');
  }
  const decisionActorId = approval.bossFinalBypassBy ?? approval.reviewerId;
  const decidedAt = approval.decidedAt instanceof Date ? approval.decidedAt.toISOString() : null;
  if (!decisionActorId || !decidedAt || approval.requesterId === decisionActorId) claimRefusal('批准缺少有效真实决议主体或属于未授权自批');
  const audits = await tx.auditLog.findMany({ where: {
    actorId: decisionActorId,
    OR: [{ targetType: 'ApprovalRequest', targetId: approval.id }, { detail: { path: ['approvalId'], equals: approval.id } }],
  } });
  const expected = buildClaimApprovalPayload(disposition, claimCase);
  const validAudits = audits.filter((audit: any) => {
    const authority = audit.detail?.decisionActorAuthority;
    const fact = audit.detail?.approvalDecisionFact;
    const roles = approval.bossFinalBypassBy ? CLAIM_BOSS_ROLE_IDS : CLAIM_LEADER_ROLE_IDS;
    return authority?.authorizationLoaded === true && authority.userId === decisionActorId
      && Array.isArray(authority.roleIds) && authority.roleIds.some((id: string) => roles.includes(id))
      && fact?.schemaVersion === 1 && fact.status === 'approved' && fact.actionType === CLAIM_APPROVAL_ACTION
      && fact.targetType === CLAIM_APPROVAL_TARGET && fact.targetId === disposition.id
      && fact.contentFingerprint === expected.contentFingerprint && fact.decisionActorId === decisionActorId && fact.decidedAt === decidedAt;
  });
  if (validAudits.length !== 1) claimRefusal('批准缺少唯一、真实领导权威及决定审计，需补审，不能从角色标签猜测');
  return { approval, decisionActorId, decisionAuditId: validAudits[0].id, contentFingerprint: expected.contentFingerprint };
}
