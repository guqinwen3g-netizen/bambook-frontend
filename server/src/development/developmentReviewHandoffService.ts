import { assertDevelopmentQcMember, developmentQcMember } from './developmentQcRouting';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { exactJsonValue } from '../lib/exactJsonValue';
import { isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { hasActualQcScope } from '../qc/qcExecutionScope';
import { readQcEvidenceInTx, stageQcEvidenceInTx, verifyQcEvidenceBytes, type QcEvidenceFile, type QcEvidenceUpload } from '../qc/qcEvidenceStorage';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { assertReviewSourceCurrent, authorizeDevelopmentQualityExecution, lockDevelopmentQualityReview, serializeDevelopmentQualityReview } from './developmentSampleQualityService';
import type { DevelopmentReviewHandoffInput, DevelopmentReviewHandoffOperation, DevelopmentReviewHandoffHistory, DevelopmentReviewQcUser } from './developmentReviewHandoffContract';
import { businessNowMs } from '../shared/businessClock';

const action = 'development_qc_handoff';
const fail = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const developmentReviewCommandHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export function normalizeDevelopmentReviewHandoff(input: unknown, operation: DevelopmentReviewHandoffOperation, actorId: string): DevelopmentReviewHandoffInput & { toUserId: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_INPUT', '请提交准确任务的认领或转交内容');
  const row = input as Record<string, unknown>;
  const keys = ['requestKey', 'expectedStartedBy', 'expectedUpdatedAt', 'sourceFingerprint', 'reason', ...(operation !== 'claim' ? ['toUserId'] : [])];
  if (Object.keys(row).some(key => !keys.includes(key)) || typeof row.requestKey !== 'string' || !row.requestKey.trim() || row.requestKey.trim() !== row.requestKey || row.requestKey.length > 128
    || !Object.prototype.hasOwnProperty.call(row, 'expectedStartedBy') || row.expectedStartedBy !== null && (typeof row.expectedStartedBy !== 'string' || !row.expectedStartedBy.trim() || row.expectedStartedBy.trim() !== row.expectedStartedBy)
    || typeof row.expectedUpdatedAt !== 'string' || !/^\d+$/.test(row.expectedUpdatedAt)
    || typeof row.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint)
    || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.trim().length > 4000) return fail('INVALID_INPUT', '须核对准确来源、当前执行人和任务修订，并填写原因及稳定原请求键');
  if ((operation === 'claim' || operation === 'assign') && row.expectedStartedBy !== null) return fail('INVALID_INPUT', '已认领任务须由实际执行人正式转交，不能抢占');
  const toUserId = operation === 'claim' ? actorId : row.toUserId;
  if (typeof toUserId !== 'string' || !toUserId.trim() || toUserId.trim() !== toUserId || toUserId.length > 200
    || operation === 'transfer' && toUserId === row.expectedStartedBy) return fail('INVALID_INPUT', '请选择不同的实际接手 QC');
  return { requestKey: row.requestKey, expectedStartedBy: row.expectedStartedBy as string | null, expectedUpdatedAt: row.expectedUpdatedAt,
    sourceFingerprint: row.sourceFingerprint, reason: row.reason.trim(), toUserId };
}

async function authorizeRead(tx: any, review: any, actor: TokenPayload | null | undefined) {
  // Either a current professional reader or a current source-business reader
  // may read a report. A failed storage/account check never becomes fallback.
  for (const scope of ['qc:read', 'products:read'] as const) {
    try { return await authorizeDevelopmentSource(tx, actor?.userId, actor, review.developmentCaseId, { scope, write: false }); }
    catch (error) { if (!(error instanceof DevelopmentDomainError) || error.code !== 'FORBIDDEN' || scope === 'products:read') throw error; }
  }
  return fail('FORBIDDEN', '当前账号不能读取该准确开发来源');
}
async function recipientFor(tx: any, userId: string, review: any) {
  const user = await loadUserWithRoles(tx, userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) return fail('INVALID_INPUT', '实际接手 QC 不存在或账号已停用');
  const recipient = await buildLoadedAuthTokenPayload(tx, user);
  const { development } = await authorizeDevelopmentQualityExecution(tx, review.developmentCaseId, user.id, recipient);
  await assertDevelopmentQcMember(tx, review, user.id, development.type);
  if (review.requestedBy === user.id) return fail('QC_SELF_REVIEW_BLOCKED', '本次业务发起人不能接手自己的正式 QC 评审');
  return { user, recipient };
}
function publicHistory(row: any): DevelopmentReviewHandoffHistory {
  const before = row.detail?.before, after = row.detail?.after, receipt = after?.receipt;
  const operation = row.action === 'start_development_sample_qc' ? 'start' : row.action === 'complete_development_sample_qc' ? 'complete' : receipt?.operation;
  return { auditId: row.id, operation, actorId: row.actorId, fromUserId: receipt?.fromUserId ?? before?.startedBy ?? null,
    toUserId: receipt?.toUserId ?? after?.startedBy ?? after?.reviewedBy ?? null, reason: receipt?.reason ?? null,
    occurredAt: receipt?.occurredAt ?? after?.startedAt ?? after?.reviewedAt ?? (row.createdAt instanceof Date ? String(row.createdAt.getTime()) : null) };
}
function reportFileIds(review: any): string[] {
  if (!Array.isArray(review.evidence)) return [];
  return review.evidence.filter((file: QcEvidenceFile) => file?.sourceKind === 'development_review' && file.sourceId === review.id
    && file.sourceFingerprint === review.sourceFingerprint && /^qef_[a-f0-9-]{36}$/.test(file.id)).map((file: QcEvidenceFile) => file.id);
}

export function createDevelopmentReviewHandoffService(db: PrismaClient, root: string) {
  async function context(reviewId: string, prior: TokenPayload | null | undefined) {
    return db.$transaction(async (tx: any) => {
      const review = await tx.developmentSampleQualityReview.findUnique({ where: { id: reviewId } });
      if (!review) return fail('NOT_FOUND', '开发样品 QC 任务不存在');
      const access = await authorizeRead(tx, review, prior);
      const chain = access.development.type === 'fabric' ? 'qc:fabric_chain:write' : 'qc:garment_chain:write';
      const professional = hasActualQcScope(access.actor, 'qc:inspect') && hasActualQcScope(access.actor, chain);
      const users: DevelopmentReviewQcUser[] = [];
      if (professional && ['queued', 'in_progress'].includes(review.status)) {
        for (const row of await tx.userAccount.findMany({ where: { status: 'active', deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })) {
          try {
            const { user } = await recipientFor(tx, row.id, review);
            users.push({ id: user.id, displayName: user.displayName || '未命名员工', departmentName: user.primaryDepartment?.name ?? null });
          } catch (error) {
            if (error instanceof DevelopmentDomainError && ['FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'QC_SELF_REVIEW_BLOCKED', 'UNAUTHORIZED'].includes(error.code)) continue;
            throw error;
          }
        }
      }
      let ids = reportFileIds(review);
      if (professional && review.startedBy === access.actor.userId && ['queued', 'in_progress'].includes(review.status)) {
        const uploads = await tx.auditLog.findMany({ where: { action: 'upload_qc_evidence', targetType: 'DevelopmentSampleQualityReview', targetId: review.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        ids = uploads.map((row: any) => row.detail?.after?.file).filter((file: QcEvidenceFile | undefined) => file?.sourceKind === 'development_review'
          && file.sourceId === review.id && file.sourceFingerprint === review.sourceFingerprint).map((file: QcEvidenceFile) => file.id);
      }
      const files = ids.length ? await readQcEvidenceInTx(tx, { root, sourceKind: 'development_review', sourceId: review.id, sourceFingerprint: review.sourceFingerprint, ids }) : [];
      const history = (await tx.auditLog.findMany({ where: { targetType: 'DevelopmentSampleQualityReview', targetId: review.id,
        action: { in: [action, 'start_development_sample_qc', 'complete_development_sample_qc'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(publicHistory);
      const executor = review.startedBy ? await tx.userAccount.findFirst({ where: { id: review.startedBy }, select: { id: true, displayName: true } }) : null;
      const current = await authorizeRead(tx, review, prior);
      const sameTeam = !review.routingTeamId || !!await developmentQcMember(tx, { caseId: review.developmentCaseId, type: current.development.type, teamId: review.routingTeamId, userId: current.actor.userId, requesterId: review.requestedBy });
      const currentProfessional = sameTeam && hasActualQcScope(current.actor, 'qc:inspect') && hasActualQcScope(current.actor, chain);
      const active = ['queued', 'in_progress'].includes(review.status), own = review.startedBy === current.actor.userId;
      let sourceCurrent = !!review.sampleVersionId;
      const lifecycle = await tx.developmentLifecycleEvent.findFirst({ where: { developmentCaseId: review.developmentCaseId }, orderBy: { revision: 'desc' } });
      if (lifecycle && lifecycle.state !== 'active') sourceCurrent = false;
      if (sourceCurrent && active) {
        try { await assertReviewSourceCurrent(tx, review); }
        catch (error) { if (error instanceof DevelopmentDomainError && error.code === 'DEVELOPMENT_SOURCE_CHANGED') sourceCurrent = false; else throw error; }
      }
      return { item: serializeDevelopmentQualityReview(review, current.development.type), actorId: current.actor.userId,
        expectedUpdatedAt: String(review.updatedAt), currentExecutor: review.startedBy ? { id: review.startedBy, displayName: executor?.displayName ?? null } : null,
        canClaim: currentProfessional && active && review.startedBy == null && review.requestedBy !== current.actor.userId && sourceCurrent,
        canAssign: currentProfessional && active && review.startedBy == null && review.responsibleHeadId === current.actor.userId && sourceCurrent,
        canStart: currentProfessional && review.status === 'queued' && own && sourceCurrent,
        canTransfer: currentProfessional && active && (own || review.responsibleHeadId === current.actor.userId) && review.startedBy != null && sourceCurrent,
        canExecute: currentProfessional && review.status === 'in_progress' && own && sourceCurrent,
        users: currentProfessional ? users : [], history, files };
    });
  }

  async function mutate(reviewId: string, input: unknown, prior: TokenPayload | null | undefined, operation: DevelopmentReviewHandoffOperation, ip?: string | null) {
    if (!prior?.userId) return fail('UNAUTHORIZED', '请使用当前真实登录账号认领或转交');
    const command = normalizeDevelopmentReviewHandoff(input, operation, prior.userId);
    const parameterHash = developmentReviewCommandHash({ reviewId, actorId: prior.userId, operation, command });
    try { return await db.$transaction(async (tx: any) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`development-qc-handoff:${prior.userId}:${command.requestKey}`}, 0))::text`);
      const { review, actor } = await lockDevelopmentQualityReview(tx, { reviewId, actorId: prior.userId, trustedActor: prior, historyReplay: true });
      const original = await tx.auditLog.findFirst({ where: { actorId: actor.userId, action, targetType: 'DevelopmentSampleQualityReview', detail: { path: ['after', 'requestKey'], equals: command.requestKey } } });
      if (original) {
        const after = original.detail?.after;
        if (original.targetId !== reviewId || after?.parameterHash !== parameterHash || !after?.item || !after?.receipt)
          return fail('REQUEST_CONFLICT', '原请求编号已用于不同的开发 QC 认领或转交');
        return { item: after.item, receipt: { ...after.receipt, auditId: original.id }, replayed: true };
      }
      if (!['queued', 'in_progress'].includes(review.status)) return fail('INVALID_TRANSITION', '正式报告已提交，不能改写其执行人；复评须另建准确版本任务');
      await assertDevelopmentOperationalWrite(tx, review.developmentCaseId, 'sample');
      if ((review.startedBy ?? null) !== command.expectedStartedBy || String(review.updatedAt) !== command.expectedUpdatedAt || review.sourceFingerprint !== command.sourceFingerprint)
        return fail('REQUEST_CONFLICT', '当前任务执行人、来源或修订已变化，请刷新后重新核对');
      if ((operation === 'claim' || operation === 'assign') && review.startedBy != null) return fail('REQUEST_CONFLICT', '任务已被认领，请由实际执行人正式转交');
      if (operation === 'assign' && review.responsibleHeadId !== actor.userId) return fail('FORBIDDEN', '仅本任务负责 QC 团队负责人可以分配执行人');
      if (operation === 'transfer' && review.startedBy !== actor.userId && review.responsibleHeadId !== actor.userId) return fail('FORBIDDEN', '只有当前实际执行 QC 可以转交自己的任务');
      await assertReviewSourceCurrent(tx, review);
      await recipientFor(tx, command.toUserId, review);
      await authorizeDevelopmentQualityExecution(tx, review.developmentCaseId, actor.userId, prior);
      const occurredAt = BigInt(businessNowMs()), now = BigInt(Math.max(Date.now(), Number(review.updatedAt) + 1));
      const changed = await tx.developmentSampleQualityReview.updateMany({ where: { id: reviewId, startedBy: command.expectedStartedBy,
        updatedAt: review.updatedAt, sourceFingerprint: command.sourceFingerprint, status: { in: ['queued', 'in_progress'] } },
        data: { status: operation === 'assign' && command.toUserId !== actor.userId ? 'queued' : 'in_progress', startedBy: command.toUserId, startedAt: operation === 'assign' && command.toUserId !== actor.userId ? null : occurredAt, updatedAt: now } });
      if (changed.count !== 1) return fail('REQUEST_CONFLICT', '任务刚被另一位 QC 处理，请保留原请求并读取实际执行人');
      const updated = await tx.developmentSampleQualityReview.findUnique({ where: { id: reviewId } });
      const item = exactJsonValue(serializeDevelopmentQualityReview(updated));
      const receipt = { protocolVersion: 1, operation, requestKey: command.requestKey, parameterHash, actorId: actor.userId, reviewId,
        developmentCaseId: review.developmentCaseId, sampleBatchId: review.sampleBatchId, sampleVersionId: review.sampleVersionId,
        sourceFingerprint: review.sourceFingerprint, fromUserId: review.startedBy ?? null, toUserId: command.toUserId, reason: command.reason, occurredAt: String(occurredAt) };
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'api:development-qc-handoff', operation: action,
        targetType: 'DevelopmentSampleQualityReview', targetId: reviewId, before: { status: review.status, startedBy: review.startedBy ?? null, startedAt: review.startedAt == null ? null : String(review.startedAt) },
        after: { requestKey: command.requestKey, parameterHash, item, receipt }, ip: ip ?? null });
      await tx.notification.create({ data: { id: `n_devqc_${randomUUID()}`, userId: command.toUserId, type: 'development_sample_qc_handoff',
        title: operation === 'claim' ? '已认领开发样品评审' : operation === 'assign' ? '开发样品评审已分配给你' : '开发样品评审已转交给你', body: command.reason, level: 'info',
        link: `/qc?developmentReviewId=${encodeURIComponent(reviewId)}`, metadata: { reviewId, developmentCaseId: review.developmentCaseId,
          sampleVersionId: review.sampleVersionId, sampleBatchId: review.sampleBatchId, auditId, actualActorId: actor.userId, fromUserId: review.startedBy ?? null } } });
      return { item, receipt: { ...receipt, auditId }, replayed: false };
    }, { isolationLevel: 'Serializable' }); }
    catch (error) { if (isOrderLineStorageConflict(error)) return fail('REQUEST_CONFLICT', '任务正在被处理，请保留原请求并重新核对实际结果'); throw error; }
  }

  async function upload(reviewId: string, input: { requestKey: string; sourceFingerprint: string; file: QcEvidenceUpload }, prior: TokenPayload | null | undefined) {
    if (!prior?.userId) return fail('UNAUTHORIZED', '请使用当前真实登录账号上传');
    let created: string | undefined;
    try { return await db.$transaction(async (tx: any) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qc-evidence:${prior.userId}:${input.requestKey}`}, 0))::text`);
      const { review, actor } = await lockDevelopmentQualityReview(tx, { reviewId, actorId: prior.userId, trustedActor: prior, historyReplay: true });
      if (!review.sampleVersionId || review.sourceFingerprint !== input.sourceFingerprint) return fail('REQUEST_CONFLICT', '附件须绑定本任务的准确版本和来源指纹');
      const original = await tx.auditLog.findFirst({ where: { actorId: actor.userId, action: 'upload_qc_evidence', detail: { path: ['after', 'requestKey'], equals: input.requestKey } } });
      if (!original) {
        await assertDevelopmentOperationalWrite(tx, review.developmentCaseId, 'sample');
        if (review.status !== 'in_progress' || review.startedBy !== actor.userId) return fail('FORBIDDEN', '只有本任务当前实际执行 QC 可以上传新报告附件');
        await assertReviewSourceCurrent(tx, review);
      }
      // An original upload ACK may be recovered after a successful handoff.
      const result = await stageQcEvidenceInTx(tx, { root, actorId: actor.userId, sourceKind: 'development_review', sourceId: reviewId,
        sourceFingerprint: review.sourceFingerprint, requestKey: input.requestKey, file: input.file }, absolute => { created = absolute; });
      return result;
    }, { isolationLevel: 'Serializable' }); }
    catch (error) { if (created) await fs.unlink(created).catch(() => {}); throw error; }
  }

  async function download(reviewId: string, fileId: string, prior: TokenPayload | null | undefined) {
    return db.$transaction(async (tx: any) => {
      const review = await tx.developmentSampleQualityReview.findUnique({ where: { id: reviewId } });
      if (!review) return fail('NOT_FOUND', '开发样品 QC 报告不存在');
      const { actor, development } = await authorizeRead(tx, review, prior);
      const actualExecutor = review.status === 'in_progress' && review.startedBy === actor.userId
        && hasActualQcScope(actor, 'qc:inspect') && hasActualQcScope(actor, development.type === 'fabric' ? 'qc:fabric_chain:write' : 'qc:garment_chain:write');
      if (!actualExecutor && !reportFileIds(review).includes(fileId)) return fail('NOT_FOUND', '该准确开发 QC 报告没有此附件');
      const [file] = await readQcEvidenceInTx(tx, { root, sourceKind: 'development_review', sourceId: reviewId, sourceFingerprint: review.sourceFingerprint, ids: [fileId] });
      if (!actualExecutor) {
        const stored = review.evidence.find((row: QcEvidenceFile) => row.id === fileId);
        if (canonical(stored) !== canonical(file)) return fail('REQUEST_CONFLICT', '正式报告附件与原上传回执不一致');
      }
      const audit = await tx.auditLog.findFirst({ where: { action: 'upload_qc_evidence', targetType: 'DevelopmentSampleQualityReview', targetId: reviewId,
        detail: { path: ['after', 'file', 'id'], equals: fileId } } });
      const verified = await verifyQcEvidenceBytes(root, file, audit.detail.after.relativePath);
      await authorizeRead(tx, review, prior);
      return { file, bytes: verified.bytes };
    });
  }
  return { context, claim: (id: string, input: unknown, actor: TokenPayload | null | undefined, ip?: string | null) => mutate(id, input, actor, 'claim', ip),
    transfer: (id: string, input: unknown, actor: TokenPayload | null | undefined, ip?: string | null) => mutate(id, input, actor, 'transfer', ip),
    assign: (id: string, input: unknown, actor: TokenPayload | null | undefined, ip?: string | null) => mutate(id, input, actor, 'assign', ip), upload, download };
}
