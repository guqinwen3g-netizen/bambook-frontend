import { QC_REPORT_CONTENT_FIELDS as REPORT_FIELDS, reportContentFingerprint as contentFingerprint } from './qcReportReadProjection';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { qcAssignmentAccess } from './qcAssignmentAccess';
import { hasActualQcScope, qcOrderInspectionScope } from './qcExecutionScope';
import { assertQcAssignmentUser } from './qcAssignmentUsers';
import { qcReportAccess, qcReportOrderAccess, QcReportError, qcReportSourceFingerprint } from './qcReportAuthority';
import { normalizeWidthInputs, type BulkReportInput, type QCAssignmentInput } from './qcService';
import { lockQcCoverage, resolveQcCoverage, requireQcCoverageMatch, type QcCoverageInput } from './qcPhysicalCoverage';
import { appendProductionQcReportFacts } from './productionQcIssueService';
import { normalizeProductionSizeChecks } from './productionQcSizeCoverage';
import { isGarmentChainOrder } from './qcChainService';
import { PRIVATE_FILES_DIR } from '../lib/privateFiles';
import { normalizeQcEvidenceIds, readQcEvidenceInTx } from './qcEvidenceStorage';
import { persistQcReportSourceReturn } from './qcReportSourceReturn';

const snapshot = (value: any) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const invalid = (message: string) => new QcReportError('VALIDATION_FAILED', message);
const conflict = (message: string) => new QcReportError('CONFLICT', message, 'source_changed');
function key(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || value !== value.trim()) throw invalid('须提供稳定的原请求键。');
  return value;
}
const intent = (input: any, fields: readonly string[]) => snapshot(Object.fromEntries(fields.filter(field =>
  Object.prototype.hasOwnProperty.call(input, field)).map(field => [field, input[field]])));
const receipt = (operation: 'create' | 'complete' | 'decision', actorId: string, targetId: string,
  requestKey: string, commandHash: string, commandSnapshot: unknown) => ({ operation, actorId, targetId, requestKey, commandHash, commandSnapshot });
function normalizedReport(input: BulkReportInput) {
  if (!input || (input.result !== 'pass' && input.result !== 'fail')) throw invalid('验货结论须为 pass 或 fail。');
  const date = input.inspectionDate ?? todayLocalKey();
  if (!isValidLocalDateKey(date)) throw invalid('验货日期须为有效的 YYYY-MM-DD。');
  const result: any = { result: input.result, inspectionDate: date };
  for (const field of ['totalUnits', 'passedUnits', 'criticalDefects', 'majorDefects', 'minorDefects'] as const) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw invalid(`${field} 须为非负整数。`);
    result[field] = value;
  }
  for (const field of ['lotSize', 'sampleSize'] as const) {
    const value = input[field] ?? null;
    if (value != null && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)) throw invalid(`${field} 须为非负整数。`);
    result[field] = value;
  }
  if (result.passedUnits > result.totalUnits || result.sampleSize != null && result.lotSize != null && result.sampleSize > result.lotSize) throw invalid('检验计数超出实际总数。');
  for (const field of ['aqlLevel', 'defectSummary', 'notes'] as const) {
    const value = input[field] ?? null;
    if (value != null && typeof value !== 'string') throw invalid(`${field} 须为文本。`);
    result[field] = value;
  }
  result.productionSizeChecks = normalizeProductionSizeChecks(input.productionSizeChecks);
  if (result.result === 'pass' && result.productionSizeChecks?.checks.some((row: { result: string }) => row.result === 'fail')) throw invalid('存在未通过的尺码检验，本次报告不能填写 QC pass。');
  if (result.productionSizeChecks?.checks.reduce((sum: number, row: { inspectedUnits: number }) => sum + row.inspectedUnits, 0) > result.totalUnits) throw invalid('逐尺码实际检验件数合计不能超过本次检验总数。');
  return { report: result, widths: normalizeWidthInputs(input.widthMeasurements) };
}
async function audit(tx: any, actor: TokenPayload, operation: string, targetType: string, targetId: string,
  before: any, after: any) {
  await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:qc:physical-coverage', operation,
    targetType, targetId, before: before == null ? null : snapshot(before), after: snapshot(after), operationType: before == null ? 'create' : 'update' });
}
async function acknowledgement(tx: any, actorId: string, operation: string, targetId: string,
  requestKey: string, commandHash: string) {
  // One assignment may now receive many append-only production reports. Find
  // the receipt for this exact command instead of replaying the assignment's
  // oldest ACK (or incorrectly treating an earlier ACK as the current one).
  const rows = await tx.auditLog.findMany({ where: { actorId, action: operation, targetId }, orderBy: { createdAt: 'asc' } });
  const row = rows.find((candidate: any) => {
    const after = candidate?.detail?.after;
    return candidate?.detail?.source === 'route:qc:physical-coverage'
      && after?.requestKey === requestKey && after?.commandHash === commandHash;
  });
  const detail: any = row?.detail;
  if (!detail?.after) throw conflict('原请求回执无法核验，请保留请求键并刷新记录。');
  return detail.after;
}

/** Native QC observations and their immutable revisions. Existing assignment,
 * current grants/L2 and actual business responsibility stay authoritative. */
export function createQcScopedService(db: PrismaClient, options: { privateFilesDir?: string } = {}) {
  const privateFilesDir = options.privateFilesDir ?? PRIVATE_FILES_DIR;
  async function scopes(orderId: string, actor: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      const { order } = await qcReportOrderAccess(tx, actor, orderId);
      const whole = await resolveQcCoverage(tx, orderId, { scopeType: 'whole_order' });
      const batches = await tx.productionBatch.findMany({ where: { orderId, state: 'active' }, orderBy: { batchCode: 'asc' } });
      const items = isGarmentChainOrder(order) ? [] : [whole];
      for (const batch of batches) items.push({ ...await resolveQcCoverage(tx, orderId,
        { scopeType: 'production_batch', productionBatchId: batch.id }), batchCode: batch.batchCode } as any);
      return { ok: true, scopes: items };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async function create(input: QCAssignmentInput & QcCoverageInput & { requestKey: string }, prior: TokenPayload) {
    if (typeof input.orderId !== 'string' || !input.orderId.trim()
      || input.qcUserId != null && (typeof input.qcUserId !== 'string' || !input.qcUserId.trim())) throw invalid('订单必填，指定 QC 时须选择实际人员。');
    if (!['midline', 'final'].includes(input.inspectionType)) throw invalid('验货类型须为 midline 或 final。');
    if (input.dueDate != null && !isValidLocalDateKey(input.dueDate)) throw invalid('要求完成日期须为有效的 YYYY-MM-DD。');
    const requestKey = key(input.requestKey), commandHash = qcReportSourceFingerprint({
      orderId: input.orderId, inspectionType: input.inspectionType, qcUserId: input.qcUserId ?? null,
      scopeType: input.scopeType, productionBatchId: input.productionBatchId ?? null,
      expectedBatchRevision: input.expectedBatchRevision ?? null, expectedScopeFingerprint: input.expectedScopeFingerprint,
      locationId: input.locationId ?? null, dueDate: input.dueDate ?? null, notes: input.notes ?? null });
    return db.$transaction(async (tx: any) => {
      await lockQcCoverage(tx, input.orderId, input.productionBatchId);
      const { actor } = await qcAssignmentAccess(tx, prior, { orderId: input.orderId, mode: 'manage' });
      const existing = await tx.qCAssignment.findUnique({ where: { assignedById_requestKey: { assignedById: actor.userId, requestKey } } });
      if (existing) {
        if (existing.orderId !== input.orderId || existing.commandHash !== commandHash) throw conflict('该请求键已用于其他验货参数。');
        const ack = await acknowledgement(tx, actor.userId, 'create_scoped_assignment', existing.id, requestKey, commandHash);
        return { item: ack.item, receipt: ack.receipt, replayed: true };
      }
      const scope = await resolveQcCoverage(tx, input.orderId, input);
      requireQcCoverageMatch(scope, input.expectedScopeFingerprint);
      const order = await tx.order.findUnique({ where: { id: input.orderId }, select: { businessLine: true, type: true } });
      if (isGarmentChainOrder(order) && input.scopeType !== 'production_batch') throw invalid('成衣生产检验须选择准确工厂分支，不能以整单计划代替实际范围。');
      if (input.qcUserId) await assertQcAssignmentUser(tx, input.qcUserId, qcOrderInspectionScope(order));
      if (input.locationId && !await tx.qCLocation.findFirst({ where: { id: input.locationId, deletedAt: null } })) throw invalid('驻地不存在或已停用。');
      const duplicate = await tx.qCAssignment.findFirst({ where: { orderId: input.orderId, inspectionType: input.inspectionType,
        scopeKey: scope.scopeKey, deletedAt: null, status: { in: ['Assigned', 'InProgress'] } } });
      if (duplicate) throw conflict('该验货范围已有进行中任务，请先核对当前任务。');
      const ts = BigInt(Date.now());
      const item = await tx.qCAssignment.create({ data: { id: `QCA__${randomUUID()}`, orderId: input.orderId,
        inspectionType: input.inspectionType, qcUserId: input.qcUserId ?? null, ...scope, requestKey, commandHash,
        locationId: input.locationId ?? null, status: 'Assigned', dueDate: input.dueDate ?? null, notes: input.notes ?? null,
        assignedById: actor.userId, assignedAt: ts, createdAt: ts, updatedAt: ts } });
      const commandReceipt = receipt('create', actor.userId, item.id, requestKey, commandHash, intent(input,
        ['orderId', 'inspectionType', 'qcUserId', 'scopeType', 'productionBatchId', 'expectedBatchRevision',
          'expectedScopeFingerprint', 'locationId', 'dueDate', 'notes']));
      if (input.qcUserId) await assertQcAssignmentUser(tx, input.qcUserId, qcOrderInspectionScope(order));
      await qcAssignmentAccess(tx, prior, { orderId: input.orderId, mode: 'manage' });
      await audit(tx, actor, 'create_scoped_assignment', 'QCAssignment', item.id, null, { item, requestKey, commandHash, receipt: commandReceipt });
      return snapshot({ item, receipt: commandReceipt, replayed: false });
    });
  }
  async function complete(id: string, input: { report: BulkReportInput; expectedScopeFingerprint: string; requestKey: string }, prior: TokenPayload) {
    const requestKey = key(input.requestKey), normalized = normalizedReport(input.report);
    const attachmentIds = normalizeQcEvidenceIds(input.report.attachmentIds);
    const resolveIssueIds = input.report.resolvesProductionQcIssueIds ?? [];
    if (!Array.isArray(resolveIssueIds) || resolveIssueIds.length > 100
      || resolveIssueIds.some(value => typeof value !== 'string' || !value.trim())
      || new Set(resolveIssueIds).size !== resolveIssueIds.length) throw invalid('生产 QC 待解除问题须为不重复的 ID 列表。');
    const commandHash = qcReportSourceFingerprint({ assignmentId: id, expectedScopeFingerprint: input.expectedScopeFingerprint,
      report: { ...normalized.report, inspectionDate: input.report.inspectionDate ?? null }, widths: normalized.widths,
      resolvesProductionQcIssueIds: [...resolveIssueIds].sort(), ...(input.report.attachmentIds !== undefined ? { attachmentIds } : {}) });
    return db.$transaction(async (tx: any) => {
      const hint = await tx.qCAssignment.findUnique({ where: { id } });
      if (!hint || hint.deletedAt != null) throw new QcReportError('NOT_FOUND', '验货任务不存在。');
      await lockQcCoverage(tx, hint.orderId, hint.productionBatchId);
      const replayAccess = await qcAssignmentAccess(tx, prior,
        { orderId: hint.orderId, assignmentId: id, mode: 'claim', lock: true });
      const { assignment, actor } = replayAccess;
      if (!hasActualQcScope(actor, 'qc:inspect')) throw new QcReportError('FORBIDDEN', '当前账号没有专业 QC 检验权限。');
      if (!assignment.scopeFingerprint) throw invalid('历史任务没有明确覆盖范围，请先建立当前验货任务。');
      const existing = await tx.inspectionReport.findUnique({ where: { inspectedBy_requestKey: { inspectedBy: actor.userId, requestKey } } });
      if (existing) {
        if (existing.commandHash !== commandHash) throw conflict('该请求键已用于其他报告参数。');
        const ack = await acknowledgement(tx, actor.userId, 'complete_scoped_assignment', assignment.id, requestKey, commandHash);
        if (ack.report?.id !== existing.id) throw conflict('原请求回执与验货报告不一致，请保留请求键并刷新记录。');
        return { item: ack.item, report: ack.report, receipt: ack.receipt, replayed: true };
      }
      const { delegated } = await qcAssignmentAccess(tx, prior, { orderId: hint.orderId, assignmentId: id, mode: 'inspect' });
      if (!['Assigned', 'InProgress'].includes(assignment.status)) throw conflict('任务已完结，请核对原报告或建立复验任务。');
      const scope = await resolveQcCoverage(tx, assignment.orderId, { scopeType: assignment.scopeType,
        productionBatchId: assignment.productionBatchId, expectedBatchRevision: assignment.productionBatchRevision ?? undefined });
      requireQcCoverageMatch(scope, assignment.scopeFingerprint);
      requireQcCoverageMatch(scope, input.expectedScopeFingerprint);
      const order = await tx.order.findUnique({ where: { id: assignment.orderId }, select: { businessLine: true, type: true } });
      const garment = isGarmentChainOrder(order);
      if (garment && (assignment.scopeType !== 'production_batch' || !normalized.report.productionSizeChecks)) throw invalid('成衣生产检验须绑定准确工厂分支并填写实际逐尺码检验与证据。');
      if (!garment && normalized.report.productionSizeChecks) throw invalid('面料检验不使用成衣逐尺码质量事实。');
      const allowedLines = new Set(scope.scopeSnapshot.lines.map((row: any) => row.orderLineId));
      if (normalized.widths.some(row => !allowedLines.has(row.orderLineId))) throw invalid('幅宽实测行不属于本次实际验货范围。');
      const previous = await tx.inspectionReport.findFirst({ where: { orderId: assignment.orderId,
        inspectionType: assignment.inspectionType, scopeKey: scope.scopeKey }, orderBy: { revision: 'desc' } });
      const lastVisit = await tx.inspectionReport.findFirst({ where: { orderId: assignment.orderId, scopeKey: scope.scopeKey },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      const now = BigInt(Date.now()), lastTime = BigInt(lastVisit?.createdAt ?? previous?.createdAt ?? 0);
      const ts = lastTime >= now ? lastTime + BigInt(1) : now;
      const reportId = `INR__${randomUUID()}`;
      const evidenceFiles = attachmentIds.length ? await readQcEvidenceInTx(tx, { root: privateFilesDir, sourceKind: 'assignment', sourceId: id,
        sourceFingerprint: scope.scopeFingerprint, ids: attachmentIds }) : null;
      const { factoryRelationId: _factory, ...reportScope } = scope;
      let report = await tx.inspectionReport.create({ data: { id: reportId, orderId: assignment.orderId,
        inspectionType: assignment.inspectionType, ...reportScope, ...normalized.report, ...(evidenceFiles ? { evidenceFiles } : {}), inspectedBy: actor.userId,
        revision: (previous?.revision ?? 0) + 1, supersedesId: previous?.id ?? null, requestKey, commandHash,
        approvedByBusiness: false, createdAt: ts, updatedAt: ts } });
      if (normalized.widths.length) await tx.inspectionWidthMeasurement.createMany({ data: normalized.widths.map(row => ({
        id: `IWM__${randomUUID()}`, reportId, orderId: assignment.orderId, ...row, createdAt: ts, updatedAt: ts })) });
      report = await tx.inspectionReport.update({ where: { id: reportId }, data: { contentFingerprint: await contentFingerprint(tx, report) } });
      const productionQcNotifications = [...await appendProductionQcReportFacts(tx, { assignment, report, actorId: actor.userId, requestKey, commandHash,
        resolvesIssueIds: resolveIssueIds }), ...await persistQcReportSourceReturn(tx, { assignment, report, actorId: actor.userId })];
      // The immutable issue events are the resolution authority. Preserve their
      // exact IDs in this command's audited receipt, not in a mutable report flag.
      if (resolveIssueIds.length) report = { ...report, resolvesProductionQcIssueIds: [...resolveIssueIds] };
      const persistentProductionInspection = assignment.scopeType === 'production_batch';
      const item = await tx.qCAssignment.update({ where: { id }, data: {
        // A production inspection is a durable QC work item. Each submission
        // appends a report, but does not close the branch's ongoing inspection.
        // Sample/one-off scoped reviews keep their existing completion behavior.
        status: persistentProductionInspection ? 'InProgress' : 'Completed', reportId,
        completedAt: persistentProductionInspection ? null : ts, updatedAt: ts,
      } });
      const commandReceipt = receipt('complete', actor.userId, id, requestKey, commandHash, {
        report: intent(input.report, [...REPORT_FIELDS.filter(field => field !== 'evidenceFiles'), 'attachmentIds', 'widthMeasurements', 'resolvesProductionQcIssueIds']), expectedScopeFingerprint: input.expectedScopeFingerprint });
      await audit(tx, actor, 'complete_scoped_assignment', 'QCAssignment', id, assignment,
        { item, report, requestKey, commandHash, receipt: commandReceipt, actualActorId: actor.userId, assignedQcUserId: assignment.qcUserId, delegated });
      return snapshot({ item, report, receipt: commandReceipt, productionQcNotifications, replayed: false });
    });
  }
  async function decision(reportId: string, input: { expectedRevision: number; expectedScopeFingerprint: string;
    expectedContentFingerprint: string; decision: 'approved' | 'rejected'; requestKey: string; reason: string }, prior: TokenPayload) {
    const requestKey = key(input.requestKey);
    if (!['approved', 'rejected'].includes(input.decision) || typeof input.reason !== 'string' || !input.reason.trim()) throw invalid('须明确批准或拒绝并填写真实决定说明。');
    const commandHash = qcReportSourceFingerprint({ reportId, ...input, reason: input.reason.trim() });
    return db.$transaction(async (tx: any) => {
      const hint = await tx.inspectionReport.findUnique({ where: { id: reportId } });
      if (!hint) throw new QcReportError('NOT_FOUND', '验货报告不存在。');
      await lockQcCoverage(tx, hint.orderId, hint.productionBatchId);
      const { actor, report } = await qcReportAccess(tx, prior, reportId, { scope: 'qc:write', lock: true, signRole: 'business' });
      const previous = await tx.auditLog.findFirst({ where: { actorId: actor.userId, action: 'decide_scoped_report', targetId: reportId } });
      if (previous) {
        const ack: any = (previous.detail as any)?.after;
        if (ack?.requestKey === requestKey && ack.commandHash === commandHash) return { item: ack.item, receipt: ack.receipt, replayed: true };
        throw conflict('本报告已有业务决定，修正须建立新复验修订。');
      }
      const latest = await tx.inspectionReport.findFirst({ where: { orderId: report.orderId,
        inspectionType: report.inspectionType, scopeKey: report.scopeKey }, orderBy: { revision: 'desc' } });
      if (latest?.id !== report.id || report.revision !== input.expectedRevision) throw conflict('已有新的验货修订，请核对当前报告。');
      const scope = await resolveQcCoverage(tx, report.orderId, { scopeType: report.scopeType,
        productionBatchId: report.productionBatchId, expectedBatchRevision: report.productionBatchRevision ?? undefined });
      requireQcCoverageMatch(scope, report.scopeFingerprint);
      requireQcCoverageMatch(scope, input.expectedScopeFingerprint);
      const actualContent = await contentFingerprint(tx, report);
      if (!report.contentFingerprint || report.contentFingerprint !== actualContent || input.expectedContentFingerprint !== actualContent) throw conflict('报告内容或证据已变化，请重新核对。');
      if (report.approvedAt != null || report.approvedByBusiness) throw conflict('原业务批准已留痕，不能覆盖。');
      const ts = BigInt(Date.now()), item = await tx.inspectionReport.update({ where: { id: reportId }, data: {
        approvedByBusiness: input.decision === 'approved', businessApprover: actor.userId, approvedAt: ts, updatedAt: ts } });
      const commandReceipt = receipt('decision', actor.userId, reportId, requestKey, commandHash, intent({ ...input, reason: input.reason.trim() },
        ['expectedRevision', 'expectedScopeFingerprint', 'expectedContentFingerprint', 'decision', 'reason']));
      await audit(tx, actor, 'decide_scoped_report', 'InspectionReport', reportId, report,
        { item, requestKey, commandHash, receipt: commandReceipt, decision: input.decision, reason: input.reason.trim(), revision: report.revision,
          contentFingerprint: actualContent, scopeFingerprint: scope.scopeFingerprint });
      return snapshot({ item, receipt: commandReceipt, replayed: false });
    });
  }
  return { scopes, create, complete, decision };
}
