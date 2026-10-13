import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { freshOrderLineScope, isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { qcAssignmentAccess, QcAssignmentError } from './qcAssignmentAccess';
import { assertQcAssignmentUser } from './qcAssignmentUsers';
import { hasActualQcScope, qcOrderInspectionScope } from './qcExecutionScope';
import { qcReportSourceFingerprint } from './qcReportAuthority';
import { lockQcCoverage, resolveQcCoverage, requireQcCoverageMatch } from './qcPhysicalCoverage';

export interface QcHandoffInput { requestKey: string; expectedQcUserId: string | null; expectedUpdatedAt: string;
  expectedScopeFingerprint: string; reason: string; toQcUserId?: string }
const invalid = (text: string) => new QcAssignmentError('VALIDATION_FAILED', text);
const conflict = (text: string) => new QcAssignmentError('CONFLICT', text);
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
export function normalizeQcHandoffInput(input: QcHandoffInput, operation: 'claim' | 'transfer', actorId: string) {
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 160
    || !Object.prototype.hasOwnProperty.call(input, 'expectedQcUserId') || input.expectedQcUserId !== null && typeof input.expectedQcUserId !== 'string'
    || typeof input.expectedUpdatedAt !== 'string' || !/^\d+$/.test(input.expectedUpdatedAt)
    || typeof input.expectedScopeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedScopeFingerprint)
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4000) throw invalid('须核对当前任务、执行人和准确范围，并填写认领/转交原因及稳定请求键。');
  if (operation === 'claim' && input.expectedQcUserId !== null) throw invalid('已分配任务须正式转交，不能抢占认领。');
  const toQcUserId = operation === 'claim' ? actorId : input.toQcUserId;
  if (typeof toQcUserId !== 'string' || !toQcUserId.trim() || operation === 'transfer' && toQcUserId === input.expectedQcUserId) throw invalid('请选择实际接手 QC。');
  return { requestKey: input.requestKey, expectedQcUserId: input.expectedQcUserId, expectedUpdatedAt: input.expectedUpdatedAt,
    expectedScopeFingerprint: input.expectedScopeFingerprint, reason: input.reason.trim(), toQcUserId };
}

export function createQcAssignmentHandoffService(db: PrismaClient) {
  async function mutate(id: string, input: QcHandoffInput, prior: TokenPayload, operation: 'claim' | 'transfer') {
    const command = normalizeQcHandoffInput(input, operation, prior.userId);
    const commandHash = qcReportSourceFingerprint({ assignmentId: id, actorId: prior.userId, operation, ...command });
    try { return await db.$transaction(async (tx: any) => {
      const hint = await tx.qCAssignment.findUnique({ where: { id } });
      if (!hint || hint.deletedAt != null) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在。');
      await lockQcCoverage(tx, hint.orderId, hint.productionBatchId);
      // Replay authorizes the current professional account and actual source;
      // it does not require still being the assignee after a successful transfer.
      const access = await qcAssignmentAccess(tx, prior, { orderId: hint.orderId, assignmentId: id, mode: 'claim', lock: true });
      const { actor, assignment, order } = access;
      const original = await tx.auditLog.findFirst({ where: { actorId: actor.userId, action: 'qc_assignment_handoff',
        detail: { path: ['after', 'requestKey'], equals: command.requestKey } } });
      if (original) {
        const after = original.detail?.after;
        if (original.targetId !== id || after?.commandHash !== commandHash || !after?.receipt || !after?.item) throw conflict('该请求键已经用于不同的认领或转交。');
        return { ok: true, item: after.item, receipt: after.receipt, replayed: true };
      }
      if (!['Assigned', 'InProgress'].includes(assignment.status)) throw conflict('任务已完结，不能认领或转交。');
      if (assignment.qcUserId !== command.expectedQcUserId || String(assignment.updatedAt) !== command.expectedUpdatedAt) throw conflict('任务执行人或内容已变化，请刷新后重新核对。');
      if (operation === 'claim' && assignment.qcUserId !== null) throw conflict('任务已经被其他 QC 认领。');
      if (operation === 'transfer' && assignment.qcUserId !== actor.userId) throw new QcAssignmentError('FORBIDDEN', '只有当前实际执行 QC 可以转交自己的任务。');
      const coverage = await resolveQcCoverage(tx, assignment.orderId, { scopeType: assignment.scopeType,
        productionBatchId: assignment.productionBatchId, expectedBatchRevision: assignment.productionBatchRevision ?? undefined });
      requireQcCoverageMatch(coverage, assignment.scopeFingerprint);
      requireQcCoverageMatch(coverage, command.expectedScopeFingerprint);
      await assertQcAssignmentUser(tx, command.toQcUserId, qcOrderInspectionScope(order));
      const user = await loadUserWithRoles(tx, command.toQcUserId);
      const recipient = await buildLoadedAuthTokenPayload(tx, user!);
      if (!await tx.order.findFirst({ where: { id: order.id, deletedAt: null, AND: [await freshOrderLineScope(tx, recipient)] } })) throw invalid('接手 QC 当前没有该来源订单的数据访问范围。');
      const now = BigInt(Date.now());
      const changed = await tx.qCAssignment.updateMany({ where: { id, qcUserId: command.expectedQcUserId, updatedAt: assignment.updatedAt, deletedAt: null,
        status: { in: ['Assigned', 'InProgress'] } }, data: { qcUserId: command.toQcUserId, updatedAt: now } });
      if (changed.count !== 1) throw conflict('任务刚刚被处理，请重新读取实际接手人。');
      const item = await tx.qCAssignment.findUnique({ where: { id } });
      const receipt = { operation, actorId: actor.userId, assignmentId: id, requestKey: command.requestKey, commandHash,
        fromQcUserId: assignment.qcUserId, toQcUserId: command.toQcUserId, reason: command.reason, occurredAt: String(now), scopeFingerprint: coverage.scopeFingerprint };
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'api:qc-handoff', operation: 'qc_assignment_handoff',
        targetType: 'QCAssignment', targetId: id, before: snapshot({ qcUserId: assignment.qcUserId, status: assignment.status, reportId: assignment.reportId }),
        after: snapshot({ requestKey: command.requestKey, commandHash, item, receipt, operation, fromQcUserId: assignment.qcUserId,
          toQcUserId: command.toQcUserId, reason: command.reason, occurredAt: String(now) }) });
      await tx.notification.create({ data: { id: `n_qch_${auditId}`, userId: command.toQcUserId, type: 'qc_assignment_handoff',
        title: operation === 'claim' ? '已认领生产检验' : '生产检验已正式转交给你', body: `${order.code || order.poNumber || order.id} · ${command.reason}`,
        level: 'info', link: `/qc?assignmentId=${encodeURIComponent(id)}`, metadata: { target: { kind: 'qc-assignment', assignmentId: id, orderId: order.id }, assignmentId: id, auditId, fromQcUserId: assignment.qcUserId, actualActorId: actor.userId } } });
      return snapshot({ ok: true, item, receipt, replayed: false });
    }, { isolationLevel: 'Serializable' }); }
    catch (error) { if (isOrderLineStorageConflict(error)) throw conflict('任务正在被认领或转交，请保留原请求并读回实际执行人。'); throw error; }
  }
  async function candidates(id: string, prior: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const task = await tx.qCAssignment.findUnique({ where: { id } });
      if (!task) throw new QcAssignmentError('NOT_FOUND', '验货任务不存在。');
      const { actor, order } = await qcAssignmentAccess(tx, prior, { orderId: task.orderId, assignmentId: id, mode: 'inspect' });
      const chain = qcOrderInspectionScope(order);
      const users = [];
      for (const row of await tx.userAccount.findMany({ where: { status: 'active', deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })) {
        const user = await loadUserWithRoles(tx, row.id);
        if (!user || user.status !== 'active' || user.deletedAt != null) continue;
        const recipient = await buildLoadedAuthTokenPayload(tx, user);
        if (!chain || !hasActualQcScope(recipient, chain) || !hasActualQcScope(recipient, 'qc:inspect') || !hasActualQcScope(recipient, 'qc:read')) continue;
        if (await tx.order.findFirst({ where: { id: order.id, deletedAt: null, AND: [await freshOrderLineScope(tx, recipient)] } }))
          users.push({ id: user.id, displayName: user.displayName || '未命名员工', departmentName: user.primaryDepartment?.name ?? null });
      }
      await qcAssignmentAccess(tx, actor, { orderId: task.orderId, assignmentId: id, mode: 'inspect' });
      return { ok: true, users };
    });
  }
  return { claim: (id: string, input: QcHandoffInput, actor: TokenPayload) => mutate(id, input, actor, 'claim'),
    transfer: (id: string, input: QcHandoffInput, actor: TokenPayload) => mutate(id, input, actor, 'transfer'), candidates };
}
