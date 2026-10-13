import crypto from 'crypto';
import type { TokenPayload } from '../auth/service';
import { loadOrderQueryReadAccess } from './orderQueryReadAccess';
import { businessError } from '../shared/errorCodes';

export type FrozenOrderEvidenceStatus = 'verified' | 'legacy_verified' | 'legacy_unverifiable';
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const orderMainSnapshotFingerprint = (value: unknown) => digest(canonical(json(value)));

/** JSONB key order cannot authenticate a legacy JSON.stringify fingerprint.
 * Reconstruct only the original Prisma scalar ordering, then require a real
 * digest match. We never rewrite or mark an unverifiable old snapshot verified. */
export function verifyOrderMainFrozenEvidence(approval: any, currentOrder: any): FrozenOrderEvidenceStatus {
  const payload = approval.payload;
  const snapshot = payload?.snapshot;
  if (!snapshot?.order || snapshot.order.id !== approval.targetId || !Array.isArray(snapshot.order.lines)
    || !['fabric', 'garment'].includes(payload.businessLine) || snapshot.businessLine !== payload.businessLine
    || typeof payload.contentFingerprint !== 'string') throw businessError('CONFLICT', '审批冻结订单原件不完整，无法安全审阅。');
  if (payload.contentFingerprintAlgorithm === 'canonical_v1') {
    if (orderMainSnapshotFingerprint(snapshot) !== payload.contentFingerprint) throw businessError('CONFLICT', '审批冻结原件的指纹不匹配，已阻止审阅与决定。');
    return 'verified';
  }
  if (payload.contentFingerprintAlgorithm != null) throw businessError('CONFLICT', '审批冻结原件使用未知指纹格式。');
  const ordered = (frozen: any, live: any) => {
    if (!live) return frozen;
    const keys = [...Object.keys(live).filter(key => Object.prototype.hasOwnProperty.call(frozen, key)), ...Object.keys(frozen).filter(key => !Object.prototype.hasOwnProperty.call(live, key))];
    return Object.fromEntries(keys.map(key => [key, frozen[key]]));
  };
  const source = ordered(snapshot.order, currentOrder);
  source.lines = snapshot.order.lines.map((line: any) => ordered(line, currentOrder?.lines?.find((row: any) => row.id === line.id) ?? currentOrder?.lines?.[0]));
  return digest({ order: source, businessLine: snapshot.businessLine }) === payload.contentFingerprint ? 'legacy_verified' : 'legacy_unverifiable';
}

export async function readOrderMainRejection(tx: any, approval: any) {
  if (approval.status !== 'rejected') return { rejectionReason: null, requestedChanges: null };
  const audit = await tx.auditLog.findFirst({ where: { targetType: 'ApprovalRequest', targetId: approval.id,
    action: 'reject_order_main_approval', actorId: approval.reviewerId }, orderBy: { createdAt: 'desc' } });
  const values = audit?.detail?.after;
  return { rejectionReason: typeof values?.rejectionReason === 'string' ? values.rejectionReason : null,
    requestedChanges: typeof values?.requestedChanges === 'string' ? values.requestedChanges : null };
}

export async function readOrderMainWithdrawal(tx: any, approval: any) {
  const unknown = { withdrawnBy: null, withdrawnAt: null, withdrawalReason: null };
  if (approval.status !== 'cancelled') return unknown;
  const audit = await tx.auditLog.findFirst({ where: { targetType: 'ApprovalRequest', targetId: approval.id,
    action: 'withdraw_order_main_approval' }, orderBy: { createdAt: 'desc' } });
  const after = audit?.detail?.after;
  if (!after || after.withdrawnBy !== audit.actorId || after.commandAck?.approvalId !== approval.id
    || after.commandAck?.actorId !== audit.actorId || after.commandAck?.status !== 'cancelled') return unknown;
  return { withdrawnBy: audit.actorId as string, withdrawnAt: audit.createdAt instanceof Date ? String(audit.createdAt.getTime()) : String(audit.createdAt),
    withdrawalReason: typeof after.reason === 'string' ? after.reason : null };
}

/** A frozen recipient ID never grants current source read or approval rights.
 * Ordinary business readers retain their current orders:read + L2 contract. */
export async function readOrderMainApprovalAccess(tx: any, approval: any, prior: TokenPayload,
  eligible: (tx: any, businessLine: 'fabric' | 'garment') => Promise<string[]>) {
  const access = await loadOrderQueryReadAccess(tx, { actor: prior });
  const order = await tx.order.findFirst({ where: { id: approval.targetId, deletedAt: null, AND: [access.orderWhere] },
    include: { lines: { orderBy: { lineNumber: 'asc' } } } });
  if (!order) throw businessError('NOT_FOUND', '关联订单不存在或已不在当前可读范围。');
  const frozenEvidenceStatus = verifyOrderMainFrozenEvidence(approval, order);
  const frozenIds: string[] = Array.isArray(approval.eligibleReviewerIds) ? approval.eligibleReviewerIds : [];
  let currentIds: string[] = [];
  try { currentIds = await eligible(tx, approval.payload.businessLine); }
  catch (error: any) { if (error?.code !== 'ORDER_APPROVAL_AUTHORITY_MISSING') throw error; }
  const businessReader = approval.requesterId === access.actor?.userId || order.ownerId === access.actor?.userId || !frozenIds.includes(prior.userId);
  if (!businessReader && !currentIds.includes(prior.userId)) throw businessError('FORBIDDEN', '当前账号已不具备该业务域的主单审批资格。');
  const blockers: string[] = [];
  if (approval.status !== 'pending') blockers.push('该审批已处理，不能重复决定。');
  if (!access.can('orders:write') || !frozenIds.includes(prior.userId) || !currentIds.includes(prior.userId)) blockers.push('当前账号没有本次主单的有效审批资格。');
  if (frozenEvidenceStatus === 'legacy_unverifiable') blockers.push('历史冻结依据无法核验；请撤回后重新提交准确快照。');
  if (approval.status === 'pending' && orderMainSnapshotFingerprint({ order, businessLine: approval.payload.businessLine })
    !== orderMainSnapshotFingerprint(approval.payload.snapshot)) blockers.push('当前订单已偏离冻结原件，请撤回并重新核对提交。');
  return { actor: access.actor!, order, frozenEvidenceStatus, canApprove: blockers.length === 0, approvalBlockers: blockers,
    ...(await readOrderMainRejection(tx, approval)), ...(await readOrderMainWithdrawal(tx, approval)) };
}
