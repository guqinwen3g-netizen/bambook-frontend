import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { assertDevelopmentExpenseAccess } from './developmentExpenseAccess';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { assertDevelopmentVersionReadyForConsumption } from './developmentVersionGate';

export type FabricCommand = { requestKey?: string; expectedRevision?: number; expectedRound?: number };
export type FabricHistoryEvent = {
  id: string; kind: string; round: number; actorId: string; at: string; auditId: string;
  requestKey: string | null; requestFingerprint: string | null;
  commandInput: Record<string, unknown> | null;
  before: Record<string, unknown>; after: Record<string, unknown>;
};
export type FabricHistory = { schemaVersion: 1; revision: number; events: FabricHistoryEvent[] };
const rejected = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
const safe = (value: unknown): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameFact = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Existing JSON is retained. Only this server writer owns fabricHistory. */
export function readFabricHistory(batch: any): FabricHistory {
  const stored = batch.attachments?.fabricHistory;
  if (stored === undefined) return { schemaVersion: 1, revision: 0, events: [] };
  if (stored?.schemaVersion !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 0 || !Array.isArray(stored.events)
    || stored.revision !== stored.events.length || stored.events.some((event: any) => !event?.id || !event.auditId || !event.actorId || !Number.isSafeInteger(event.round) || event.round < 1)) {
    rejected('DEVELOPMENT_SOURCE_CHANGED', '样品轮次历史不完整，请核对原记录后继续');
  }
  return stored;
}

export function fabricBatchEligibility(batch: any) {
  const history = readFabricHistory(batch);
  const negative = batch.sampleType === 'lab-dip' && ['needs_recast', 'rejected'].includes(batch.customerStatus);
  const events = history.events.filter(event => event.round === batch.round);
  const latestApproval = events.reduce((last, event, index) => event.kind === 'approve' ? index : last, -1);
  const latestInvalidation = events.reduce((last, event, index) => event.kind === 'invalidate' || event.kind === 'revise'
    || event.kind === 'feedback' ? index : last, -1);
  // Legacy approval is a recorded action, not a design-confirmation tag.
  const legacyApproval = batch.approvedAt != null && typeof batch.approvedBy === 'string' && !!batch.approvedBy;
  const eligible = !negative && batch.status === 'approved'
    && (latestInvalidation < latestApproval || (latestApproval === -1 && latestInvalidation === -1 && legacyApproval));
  const latestConversion = events.reduce((last, event, index) => event.kind === 'convert' && event.after.convertedProductAssetId === batch.convertedProductAssetId ? index : last, -1);
  const hasCurrentHistory = latestApproval >= 0 || latestInvalidation >= 0 || events.some(event => event.kind === 'start');
  const assetCurrent = eligible && !!batch.convertedProductAssetId
    && (!hasCurrentHistory || latestConversion > Math.max(latestApproval, latestInvalidation));
  return { eligible, assetCurrent, revision: history.revision, approvalAllowed: batch.status === 'sent' && !negative,
    reason: negative ? '客户当前要求重打或已拒绝，原认可不能继续用于确认、封样、转档或转单' : eligible ? null : '本轮尚未完成有效认可' };
}

export function assertFabricBatchEligible(batch: any, requireAsset = false) {
  const current = fabricBatchEligibility(batch);
  if (!current.eligible || (requireAsset && !current.assetCurrent)) rejected('DEVELOPMENT_NOT_READY', current.reason || '本轮认可成果尚未转档，请核对当前样品依据');
}

export async function assertFabricBatchEvidence(db: any, batch: any, requireAsset = false) {
  if (batch.sampleVersionId) {
    const current = await assertDevelopmentVersionReadyForConsumption(db, batch.developmentCaseId, batch.sampleVersionId);
    if (current.physicalVersion.id !== batch.sampleVersionId || current.version.supplierRelationId !== batch.supplierRelationId)
      rejected('DEVELOPMENT_SOURCE_CHANGED', '当前批次不属于准确工厂版本');
    if (requireAsset) {
      const asset = batch.convertedProductAssetId ? await db.productAsset.findUnique({ where: { id: batch.convertedProductAssetId } }) : null;
      if (!asset || asset.deletedAt != null || asset.sourceDevelopmentCaseId !== batch.developmentCaseId || asset.sourceSampleVersionId !== batch.sampleVersionId)
        rejected('DEVELOPMENT_SOURCE_CHANGED', '当前准确批次没有对应版本的产品档案；不能借其他小版本档案');
    }
    return current;
  }
  assertFabricBatchEligible(batch, requireAsset);
  const events = readFabricHistory(batch).events.filter(event => event.round === batch.round);
  const approval = [...events].reverse().find(event => event.kind === 'approve');
  const conversion = requireAsset ? [...events].reverse().find(event => event.kind === 'convert') : undefined;
  for (const event of [approval, conversion].filter(Boolean) as FabricHistoryEvent[]) {
    const audit = await db.auditLog.findFirst({ where: { id: event.auditId, actorId: event.actorId,
      targetType: event.kind === 'convert' ? 'ProductAsset' : 'SampleBatch',
      targetId: event.kind === 'convert' ? event.after.convertedProductAssetId : batch.id } });
    const fact = audit?.detail?.after?.roundFact;
    if (fact?.kind !== event.kind || !sameFact(fact.before, event.before) || !sameFact(fact.after, event.after)) {
      rejected('DEVELOPMENT_SOURCE_CHANGED', '本轮认可或转档审计依据缺失，请核对原样品记录');
    }
  }
}

export async function assertFabricCurrentWrite(tx: any, caseId: string, actorId: string, trustedActor?: TokenPayload) {
  if (!trustedActor?.userId || trustedActor.userId !== actorId) return rejected('FORBIDDEN', '请使用当前登录身份处理样品');
  const user = await tx.userAccount.findFirst({ where: { id: actorId, status: 'active', deletedAt: null }, select: { id: true } });
  const current = await createPermissionService({ prisma: tx }).getUserPermissionContext(actorId);
  if (!user || !current) return rejected('FORBIDDEN', '账号当前不可处理开发样品');
  const actor: TokenPayload = { ...trustedActor, roles: [], roleIds: current.roleIds, permissions: current.scopes, departmentIds: current.departmentIds, authorizationLoaded: true };
  if (!hasScope(actor, 'products:write')) rejected('FORBIDDEN', '当前账号没有开发样品写入权限');
  await assertDevelopmentExpenseAccess(tx, actor, caseId, 'write');
}

export async function lockFabricBatch(tx: any, batchId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id"=${batchId} FOR UPDATE`);
  return tx.sampleBatch.findFirst({ where: { id: batchId, deletedAt: null } });
}

const SNAPSHOT_FIELDS = ['status', 'round', 'sentDate', 'courier', 'trackingNumber', 'shippingFee', 'feedback', 'feedbackDate',
  'customerStatus', 'customerFeedbackNote', 'customerFeedbackDate', 'approvedAt', 'approvedBy', 'approvedAsSealed',
  'confirmStatus', 'confirmedAt', 'confirmedBy', 'convertedProductAssetId', 'convertedAt'] as const;
export function fabricBatchSnapshot(batch: any): Record<string, unknown> {
  return safe(Object.fromEntries(SNAPSHOT_FIELDS.map(field => [field, batch[field] ?? null])));
}

export function fabricCommandFingerprint(kind: string, input: Record<string, unknown>): string {
  const canonical = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'requestKey' && value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify([kind, safe(canonical)])).digest('hex');
}
export function checkFabricCommand(batch: any, actorId: string, kind: string, input: FabricCommand & Record<string, unknown>) {
  const history = readFabricHistory(batch);
  const commandPresent = input.requestKey !== undefined || input.expectedRevision !== undefined || input.expectedRound !== undefined;
  if (!commandPresent) return null; // Old API syntax retains state checks and append-only audit; no permission fallback.
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 200
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0
    || !Number.isSafeInteger(input.expectedRound) || input.expectedRound! < 1) rejected('INVALID_INPUT', '请携带原请求编号、样品轮次和历史版本');
  const fingerprint = fabricCommandFingerprint(kind, input);
  const prior = history.events.find(event => event.actorId === actorId && event.requestKey === input.requestKey);
  if (prior) {
    if (prior.kind !== kind || prior.requestFingerprint !== fingerprint) rejected('REQUEST_CONFLICT', '原请求编号已用于不同的样品操作，请核对原结果');
    return prior;
  }
  if (history.revision !== input.expectedRevision || batch.round !== input.expectedRound) rejected('DEVELOPMENT_SOURCE_CHANGED', '样品轮次或反馈已变化，请刷新后重新核对');
  return null;
}

/** Audit and history remain inside the caller's transaction. Audit failure cannot leave projection or history. */
export async function appendFabricEvent(tx: any, before: any, after: any, kind: string, actorId: string, auditId: string, input: FabricCommand & Record<string, unknown> = {}) {
  const history = readFabricHistory(before);
  const event: FabricHistoryEvent = { id: randomUUID(), kind, round: after.round, actorId, at: String(after.updatedAt), auditId,
    requestKey: input.requestKey ?? null, requestFingerprint: input.requestKey ? fabricCommandFingerprint(kind, input) : null,
    commandInput: input.requestKey ? safe(Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'requestKey' && value !== undefined).sort(([a], [b]) => a.localeCompare(b)))) : null,
    before: fabricBatchSnapshot(before), after: { ...fabricBatchSnapshot(after), ...(kind === 'seal' ? { sealId: input.sealId } : {}) } };
  const recorded = await tx.sampleBatch.update({ where: { id: after.id }, data: { attachments: {
    ...(before.attachments ?? {}), fabricHistory: { schemaVersion: 1, revision: history.revision + 1, events: [...history.events, event] },
  } } });
  return { ...recorded, commandAck: event };
}

export function invalidateFabricProjection() {
  return { approvedAt: null, approvedBy: null, approvedAsSealed: false, confirmStatus: 'unconfirmed', confirmedAt: null, confirmedBy: null };
}

export async function assertFabricSealEligible(db: any, seal: any) {
  const links = await db.sealSampleBatch.findMany({ where: { sealSampleId: seal.id } });
  if (!links.length) rejected('DEVELOPMENT_NOT_READY', '封样缺少真实组合批次，请核对原样品');
  const batches = await db.sampleBatch.findMany({ where: { id: { in: links.map((link: any) => link.sampleBatchId) }, developmentCaseId: seal.developmentCaseId, deletedAt: null } });
  if (batches.length !== links.length) rejected('DEVELOPMENT_NOT_READY', '封样包含已失效或缺失的样品批次');
  const exactVersions = new Map<string, any>();
  for (const batch of batches) {
    const current = await assertFabricBatchEvidence(db, batch);
    if (current) exactVersions.set(batch.id, current.exactDevelopmentVersionProof);
  }
  for (const batch of batches) {
    const history = readFabricHistory(batch);
    if (seal.status === 'draft') continue;
    const events = history.events;
    const sealIndex = events.reduce((last, event, index) => event.kind === 'seal' && event.round === batch.round && event.after.sealId === seal.id ? index : last, -1);
    const invalidationIndex = events.reduce((last, event, index) => event.kind === 'revise' || event.kind === 'invalidate'
      || (event.kind === 'start' && event.before.round !== event.after.round)
      || event.kind === 'feedback' ? index : last, -1);
    if (invalidationIndex > sealIndex) {
      rejected('DEVELOPMENT_NOT_READY', '封样引用的认可已失效，需以本轮有效样品重新封样');
    }
    if (batch.sampleVersionId && sealIndex < 0) rejected('DEVELOPMENT_SOURCE_CHANGED', '历史封样未冻结准确版本的原生封样依据');
    if (sealIndex >= 0) {
      const event = events[sealIndex];
      const audit = await db.auditLog.findFirst({ where: { id: event.auditId, actorId: event.actorId, action: 'seal_sample_confirm', targetType: 'SealSample', targetId: seal.id } });
      const fact = audit?.detail?.after?.batchFacts?.find((row: any) => row.batchId === batch.id);
      if (!fact || !sameFact(fact.snapshot, event.before)) rejected('DEVELOPMENT_SOURCE_CHANGED', '封样的轮次审计依据缺失，请核对原封样记录');
      if (batch.sampleVersionId && (fact.exactDevelopmentVersionProof?.sampleVersionId !== batch.sampleVersionId
        || !sameFact(fact.exactDevelopmentVersionProof?.sourceSnapshot, exactVersions.get(batch.id)?.sourceSnapshot)))
        rejected('DEVELOPMENT_SOURCE_CHANGED', '封样未冻结准确版本的正式 QC 与实际需求方确认，不能使用旧认可代替');
    }
  }
}
