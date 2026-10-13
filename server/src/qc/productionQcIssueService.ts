import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { authorizeOrderLineWrite } from '../orders/orderLineWriteAccess';
import { resolveQcCoverage, requireQcCoverageMatch } from './qcPhysicalCoverage';
import { businessError } from '../shared/errorCodes';
import { QcReportError } from './qcReportAuthority';
import { assertProductionSizeRetest, normalizeProductionSizeChecks } from './productionQcSizeCoverage';
import { reportContentFingerprint } from './qcReportReadProjection';
import { isGarmentChainOrder } from './qcChainService';

const id = () => `PQI__${randomUUID()}`;
const eventId = () => `PQIE__${randomUUID()}`;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeKey = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 160) {
    throw businessError('INVALID_INPUT', '须提供稳定的生产 QC 请求键。');
  }
  return value;
};
const latestEvent = (events: any[]) => [...events].sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id))).at(-1);
// Event IDs are random, so they cannot break same-millisecond timestamp ties.
// Advance the append timestamp past the issue's last fact to preserve ordering
// even when QC and business commands land within one clock tick.
const nextEventTime = (events: any[], now = BigInt(Date.now())) => {
  const last = events.reduce((max, event) => {
    const value = BigInt(event.createdAt ?? 0);
    return value > max ? value : max;
  }, BigInt(0));
  return now > last ? now : last + BigInt(1);
};

export type ProductionQcIssueStatus = 'open' | 'waiting_business_resume' | 'resumed' | 'unknown';
export type ProductionQcIssueProjection = {
  available: boolean;
  issues: Array<{ issueId: string; productionBatchRevision: number; failedReportId: string; reason: string | null;
    failedSizes?: string[];
    createdBy: string; createdAt: string; status: ProductionQcIssueStatus; latestReportId: string | null;
    latestReportResult: string | null; latestEventAt: string | null }>;
  error?: string;
};

/** Read the exact issue lifecycle for one immutable branch revision. If the
 * issue or report authority cannot be read, callers must render the state as
 * unavailable and keep continuation/shipment actions locked. */
export async function readProductionQcIssueProjection(tx: any, params: {
  orderId: string; orderLineId: string; productionBatchId: string; productionBatchRevision: number;
}): Promise<ProductionQcIssueProjection> {
  if (!tx.productionQcIssue?.findMany || !tx.productionQcIssueEvent?.findMany || !tx.inspectionReport?.findUnique) {
    return { available: false, issues: [], error: '生产 QC 问题台账暂不可读取。' };
  }
  let issues: any[];
  try {
    issues = await tx.productionQcIssue.findMany({ where: params, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  } catch {
    return { available: false, issues: [], error: '生产 QC 问题台账读取失败。' };
  }
  const projections: ProductionQcIssueProjection['issues'] = [];
  const order = tx.order?.findUnique ? await tx.order.findUnique({ where: { id: params.orderId }, select: { businessLine: true, type: true } }) : null;
  const garment = isGarmentChainOrder(order);
  for (const issue of issues) {
    if (issue.orderId !== params.orderId || issue.orderLineId !== params.orderLineId
      || issue.productionBatchId !== params.productionBatchId || issue.productionBatchRevision !== params.productionBatchRevision
      || typeof issue.id !== 'string' || typeof issue.failedReportId !== 'string') {
      return { available: false, issues: [], error: '生产 QC 问题来源与当前工厂分支不一致。' };
    }
    let failedReport: any;
    try { failedReport = await tx.inspectionReport.findUnique({ where: { id: issue.failedReportId } }); }
    catch { return { available: false, issues: [], error: '生产 QC 原始失败报告读取失败。' }; }
    if (!failedReport || failedReport.orderId !== params.orderId || failedReport.scopeType !== 'production_batch'
      || failedReport.productionBatchId !== params.productionBatchId || failedReport.productionBatchRevision !== params.productionBatchRevision
      || failedReport.result !== 'fail') {
      return { available: false, issues: [], error: '生产 QC 问题缺少有效的原始失败报告。' };
    }
    let failedSizes: string[] = [];
    if (failedReport.productionSizeChecks != null) {
      try {
        const checks = normalizeProductionSizeChecks(failedReport.productionSizeChecks)!;
        failedSizes = checks.checks.filter(row => row.result === 'fail').map(row => row.size);
        if (!failedSizes.length) failedSizes = checks.actualSizes;
        if (!failedReport.contentFingerprint || failedReport.contentFingerprint !== await reportContentFingerprint(tx, failedReport))
          return { available: false, issues: [], error: '原始失败报告的逐尺码内容或证据已变化。' };
      } catch { return { available: false, issues: [], error: '原始失败报告的逐尺码事实无法核验。' }; }
    }
    let events: any[];
    try {
      events = await tx.productionQcIssueEvent.findMany({ where: { issueId: issue.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    } catch {
      return { available: false, issues: [], error: '生产 QC 问题变更历史读取失败。' };
    }
    events = [...events].sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
    let status: ProductionQcIssueStatus = 'unknown';
    let latestReportId: string | null = null, latestReportResult: string | null = null, latestEventAt: string | null = null;
    let valid = events.length > 0;
    for (let index = 0; index < events.length && valid; index++) {
      const event = events[index];
      if (event.issueId !== issue.id || event.orderId !== params.orderId || event.orderLineId !== params.orderLineId
        || event.productionBatchId !== params.productionBatchId || event.productionBatchRevision !== params.productionBatchRevision) {
        valid = false; break;
      }
      latestEventAt = String(event.createdAt);
      if (index === 0) {
        if (event.kind !== 'opened' || event.fromStatus !== null || event.toStatus !== 'open' || event.reportId !== issue.failedReportId) { valid = false; break; }
        status = 'open';
        latestReportId = event.reportId;
        latestReportResult = failedReport.result;
        continue;
      }
      if (event.kind === 'qc_resolved' && status === 'open' && event.fromStatus === 'open' && event.toStatus === 'resolved' && event.reportId) {
        let report: any;
        try { report = await tx.inspectionReport.findUnique({ where: { id: event.reportId } }); }
        catch { return { available: false, issues: [], error: '生产 QC 复验报告读取失败。' }; }
        if (!report || report.orderId !== params.orderId || report.scopeType !== 'production_batch'
          || report.productionBatchId !== params.productionBatchId || report.productionBatchRevision !== params.productionBatchRevision
          || report.result !== 'pass') { valid = false; break; }
        try {
          assertProductionSizeRetest(failedReport.productionSizeChecks, report.productionSizeChecks, garment || failedReport.productionSizeChecks != null);
          if (report.productionSizeChecks != null && (!report.contentFingerprint || report.contentFingerprint !== await reportContentFingerprint(tx, report))) { valid = false; break; }
        } catch { valid = false; break; }
        status = 'waiting_business_resume'; latestReportId = report.id; latestReportResult = report.result;
        continue;
      }
      if (event.kind === 'business_resumed' && status === 'waiting_business_resume'
        && event.fromStatus === 'waiting_business_resume' && event.toStatus === 'resumed'
        && event.reportId === latestReportId) {
        status = 'resumed';
        continue;
      }
      valid = false;
    }
    if (!valid) status = 'unknown';
    projections.push({ issueId: issue.id, productionBatchRevision: issue.productionBatchRevision,
      failedReportId: issue.failedReportId, failedSizes, reason: issue.reason ?? null, createdBy: issue.createdBy,
      createdAt: String(issue.createdAt), status, latestReportId, latestReportResult, latestEventAt });
  }
  return { available: true, issues: projections };
}

async function productionQcBusinessRecipients(tx: any, orderId: string): Promise<string[]> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { ownerId: true, departmentId: true } });
  if (!order) throw new QcReportError('CONFLICT', '生产 QC 问题找不到对应订单责任，不能投递业务待办。');
  if (order.ownerId) {
    const owner = await tx.userAccount.findUnique({ where: { id: order.ownerId }, select: { id: true, status: true, deletedAt: true } });
    if (owner?.status === 'active' && owner.deletedAt == null) return [owner.id];
  }
  if (order.departmentId) {
    const department = await tx.department.findUnique({ where: { id: order.departmentId }, select: { headId: true } });
    if (department?.headId) {
      const head = await tx.userAccount.findUnique({ where: { id: department.headId }, select: { id: true, status: true, deletedAt: true } });
      if (head?.status === 'active' && head.deletedAt == null) return [head.id];
    }
  }
  return [];
}

async function persistProductionQcNotification(tx: any, params: { eventId: string; orderId: string; orderLineId: string;
  productionBatchId: string; issueId: string; reportId: string; recipientIds: string[]; state: 'open' | 'waiting_business_resume'; reason: string | null }) {
  if (!params.recipientIds.length) return [];
  const failed = params.state === 'open';
  const type = failed ? 'production_qc_issue' : 'production_qc_resume_needed';
  const title = failed ? '生产检验发现问题，工厂分支已暂停' : '生产 QC 复验通过，等待业务确认继续';
  const body = failed
    ? `${params.orderLineId} · ${params.productionBatchId}：${params.reason || '请查看 QC 报告中的问题说明。'}`
    : `${params.orderLineId} · ${params.productionBatchId} 的复验已通过，请在订单生产分支明确确认是否继续。`;
  const link = `/orders?id=${encodeURIComponent(params.orderId)}&tab=production`;
  await tx.notification.createMany({ data: params.recipientIds.map(userId => ({
    id: `ntf_${params.eventId}_${userId}`, userId, type, title, body,
    level: failed ? 'critical' : 'warning', link,
    metadata: { eventId: params.eventId, eventType: type, orderId: params.orderId,
      orderLineId: params.orderLineId, productionBatchId: params.productionBatchId,
      productionQcIssueId: params.issueId, reportId: params.reportId },
  })), skipDuplicates: true });
  return [{ type, title, body, level: (failed ? 'critical' : 'warning') as 'critical' | 'warning', link,
    eventId: params.eventId, eventType: type, orderId: params.orderId, recipientIds: params.recipientIds,
    metadata: { orderLineId: params.orderLineId, productionBatchId: params.productionBatchId, productionQcIssueId: params.issueId, reportId: params.reportId } }];
}

/** A failing scoped report creates an immutable exact batch/revision issue.
 * A passing retest resolves only explicitly named issues; the issue itself is
 * never overwritten and requires a later business-resume command. */
export async function appendProductionQcReportFacts(tx: any, params: { assignment: any; report: any; actorId: string;
  requestKey: string; commandHash: string; resolvesIssueIds?: string[] }) {
  const { assignment, report, actorId } = params;
  const batchId = assignment.scopeType === 'production_batch' ? assignment.productionBatchId : null;
  const issueIds = params.resolvesIssueIds ?? [];
  const notifications: any[] = [];
  if (!Array.isArray(issueIds) || issueIds.some(value => typeof value !== 'string' || !value.trim())
    || new Set(issueIds).size !== issueIds.length) throw new QcReportError('VALIDATION_FAILED', '生产 QC 问题 ID 不能重复或为空。');
  if (issueIds.length && (!batchId || report.result !== 'pass'))
    throw new QcReportError('VALIDATION_FAILED', '只有准确生产批次的 QC pass 复验报告可以解除指定生产 QC 问题。');
  if (report.result === 'fail' && batchId) {
    const batch = await tx.productionBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.orderId !== assignment.orderId || batch.revision !== assignment.productionBatchRevision
      || report.scopeType !== 'production_batch' || report.productionBatchId !== batch.id
      || report.productionBatchRevision !== batch.revision) {
      throw new QcReportError('CONFLICT', 'QC 报告对应的生产批次修订已变化，不能生成问题事实。');
    }
    const lineId = batch.orderLineId;
    if (!lineId) throw new QcReportError('CONFLICT', '生产 QC 报告缺少准确订单行。');
    const issueId = id(), now = BigInt(Date.now());
    await tx.productionQcIssue.create({ data: { id: issueId, orderId: assignment.orderId, orderLineId: lineId,
      productionBatchId: batch.id, productionBatchRevision: batch.revision, failedReportId: report.id,
      reason: report.defectSummary || report.notes || null, createdBy: actorId, createdAt: now } });
    const openedEventId = eventId();
    await tx.productionQcIssueEvent.create({ data: { id: openedEventId, issueId, orderId: assignment.orderId, orderLineId: lineId,
      productionBatchId: batch.id, productionBatchRevision: batch.revision, kind: 'opened', fromStatus: null, toStatus: 'open',
      actorId, reportId: report.id, requestKey: `qc-open:${params.requestKey}`, commandHash: params.commandHash,
      note: report.defectSummary || report.notes || null, payload: { schemaVersion: 1, failedReportId: report.id }, createdAt: now } });
    if (tx.order?.findUnique && tx.userAccount?.findUnique && tx.notification?.createMany) {
      const recipientIds = await productionQcBusinessRecipients(tx, assignment.orderId);
      notifications.push(...await persistProductionQcNotification(tx, { eventId: openedEventId, orderId: assignment.orderId,
        orderLineId: lineId, productionBatchId: batch.id, issueId, reportId: report.id, recipientIds,
        state: 'open', reason: report.defectSummary || report.notes || null }));
    }
  }

  if (!issueIds.length) return notifications;
  const batch = await tx.productionBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.orderId !== assignment.orderId || batch.revision !== assignment.productionBatchRevision
    || report.scopeType !== 'production_batch' || report.productionBatchId !== batch.id
    || report.productionBatchRevision !== batch.revision)
    throw new QcReportError('CONFLICT', '复验报告不是当前生产批次修订。');
  const issues = await tx.productionQcIssue.findMany({ where: { id: { in: issueIds }, orderId: assignment.orderId,
    orderLineId: batch.orderLineId, productionBatchId: batchId, productionBatchRevision: batch.revision }, orderBy: [{ id: 'asc' }] });
  if (issues.length !== issueIds.length) throw new QcReportError('CONFLICT', '待解除问题不属于本报告当前订单行、批次和修订。');
  const coverage = await resolveQcCoverage(tx, assignment.orderId, { scopeType: 'production_batch', productionBatchId: batchId,
    expectedBatchRevision: batch.revision });
  if (report.scopeFingerprint !== coverage.scopeFingerprint || report.productionBatchRevision !== batch.revision)
    throw new QcReportError('CONFLICT', '复验报告范围不是当前生产批次的有效范围。');
  const order = await tx.order.findUnique({ where: { id: assignment.orderId }, select: { businessLine: true, type: true } });
  const garment = isGarmentChainOrder(order);
  for (const issue of issues) {
    const events = await tx.productionQcIssueEvent.findMany({ where: { issueId: issue.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const current = latestEvent(events);
    if (current?.kind !== 'opened' || current.toStatus !== 'open')
      throw new QcReportError('CONFLICT', '只有仍为 open 的生产 QC 问题可由当前 pass 复验解除。');
    const failedReport = await tx.inspectionReport.findUnique({ where: { id: issue.failedReportId } });
    if (!failedReport || failedReport.result !== 'fail' || failedReport.orderId !== issue.orderId
      || failedReport.productionBatchId !== batch.id || failedReport.productionBatchRevision !== batch.revision
      || failedReport.scopeFingerprint !== coverage.scopeFingerprint) throw new QcReportError('CONFLICT', '原始失败报告不属于当前工厂分支有效范围。');
    assertProductionSizeRetest(failedReport.productionSizeChecks, report.productionSizeChecks, garment);
    if (failedReport.productionSizeChecks != null && failedReport.contentFingerprint !== await reportContentFingerprint(tx, failedReport)) throw new QcReportError('CONFLICT', '原始失败报告的逐尺码证据已变化。');
    if (report.productionSizeChecks != null && report.contentFingerprint !== await reportContentFingerprint(tx, report)) throw new QcReportError('CONFLICT', '本次复验的逐尺码证据已变化。');
    const now = nextEventTime(events), resolvedEventId = eventId();
    await tx.productionQcIssueEvent.create({ data: { id: resolvedEventId, issueId: issue.id, orderId: issue.orderId,
      orderLineId: issue.orderLineId, productionBatchId: issue.productionBatchId,
      productionBatchRevision: issue.productionBatchRevision, kind: 'qc_resolved', fromStatus: 'open', toStatus: 'resolved',
      actorId, reportId: report.id, requestKey: `qc-resolve:${params.requestKey}:${issue.id}`,
      commandHash: sha({ base: params.commandHash, issueId: issue.id, reportId: report.id }),
      note: '当前生产批次 QC pass 复验，等待业务员确认继续。',
      payload: { schemaVersion: 1, scopeFingerprint: coverage.scopeFingerprint }, createdAt: now } });
    if (tx.order?.findUnique && tx.userAccount?.findUnique && tx.notification?.createMany) {
      const recipientIds = await productionQcBusinessRecipients(tx, issue.orderId);
      notifications.push(...await persistProductionQcNotification(tx, { eventId: resolvedEventId, orderId: issue.orderId,
        orderLineId: issue.orderLineId, productionBatchId: batch.id, issueId: issue.id, reportId: report.id,
        recipientIds, state: 'waiting_business_resume', reason: null }));
    }
  }
  return notifications;
}

/** Business explicitly resumes a batch after all current QC issues have valid
 * pass resolutions. This command appends a separate event and never changes
 * the ProductionBatch or order workflow status. */
export async function resumeProductionQcIssues(params: { prisma: PrismaClient; productionBatchId: string;
  actor: TokenPayload | null; input: unknown }) {
  const input: any = params.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['orderLineId', 'expectedRevision', 'requestKey'].includes(key))
    || typeof input.orderLineId !== 'string' || !input.orderLineId.trim()
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw businessError('INVALID_INPUT', '业务恢复须明确订单行、当前生产批次修订和请求键。');
  }
  const requestKey = safeKey(input.requestKey);
  if (!params.actor?.userId) throw businessError('UNAUTHORIZED', '请使用当前业务账号确认继续生产。');
  return params.prisma.$transaction(async (tx: any) => {
    const hint = await tx.productionBatch.findUnique({ where: { id: params.productionBatchId } });
    if (!hint || hint.state !== 'active' || hint.orderLineId !== input.orderLineId)
      throw businessError('NOT_FOUND', '当前有效生产工厂分支不存在或订单行不符。');
    const { actor, order } = await authorizeOrderLineWrite(tx, hint.orderId, params.actor, 'update');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "id" = ${hint.id} AND "orderId" = ${hint.orderId} FOR UPDATE`);
    const batch = await tx.productionBatch.findUnique({ where: { id: hint.id } });
    if (!batch || batch.state !== 'active' || batch.orderLineId !== input.orderLineId || batch.revision !== input.expectedRevision)
      throw businessError('CONFLICT', '生产批次或修订已变化，请刷新后再确认继续。');
    const commandHash = sha({ orderId: order.id, orderLineId: batch.orderLineId, productionBatchId: batch.id,
      productionBatchRevision: batch.revision, requestKey, action: 'business-resume' });
    const prior = await tx.productionQcIssueEvent.findFirst({ where: { actorId: actor.userId, requestKey, kind: 'business_resumed' } });
    if (prior) {
      if (prior.commandHash !== commandHash || prior.productionBatchId !== batch.id || prior.productionBatchRevision !== batch.revision)
        throw businessError('CONFLICT', '生产恢复请求键已绑定另一条命令。');
      const issueIds = Array.isArray(prior.payload?.issueIds) ? prior.payload.issueIds : [];
      return { orderId: order.id, orderLineId: batch.orderLineId, productionBatchId: batch.id,
        productionBatchRevision: batch.revision, issueIds, resumedAt: String(prior.createdAt), replayed: true };
    }
    const issues = await tx.productionQcIssue.findMany({ where: { orderId: order.id, orderLineId: batch.orderLineId,
      productionBatchId: batch.id, productionBatchRevision: batch.revision }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!issues.length) throw businessError('INVALID_STATE', '当前批次没有需要业务恢复的生产 QC 问题。');
    const resolved: any[] = [];
    for (const issue of issues) {
      const events = await tx.productionQcIssueEvent.findMany({ where: { issueId: issue.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const current = latestEvent(events);
      if (current?.kind === 'business_resumed' && current.toStatus === 'resumed') continue;
      if (current?.kind !== 'qc_resolved' || current.toStatus !== 'resolved' || !current.reportId)
        throw businessError('GATE_BLOCKED', '当前工厂批次仍有未通过 QC 复验的问题，不能确认继续生产。');
      const report = await tx.inspectionReport.findUnique({ where: { id: current.reportId } });
      if (!report || report.orderId !== order.id || report.scopeType !== 'production_batch' || report.productionBatchId !== batch.id
        || report.productionBatchRevision !== batch.revision || report.result !== 'pass')
        throw businessError('GATE_BLOCKED', '生产 QC 复验报告缺失、失效或不是当前批次 pass，不能确认继续生产。');
      const coverage = await resolveQcCoverage(tx, order.id, { scopeType: 'production_batch', productionBatchId: batch.id,
        expectedBatchRevision: batch.revision });
      requireQcCoverageMatch(coverage, report.scopeFingerprint);
      const failedReport = await tx.inspectionReport.findUnique({ where: { id: issue.failedReportId } });
      if (!failedReport || failedReport.result !== 'fail' || failedReport.scopeFingerprint !== coverage.scopeFingerprint
        || failedReport.productionBatchId !== batch.id || failedReport.productionBatchRevision !== batch.revision)
        throw businessError('GATE_BLOCKED', '原始失败报告不属于当前分支有效依据，不能恢复。');
      assertProductionSizeRetest(failedReport.productionSizeChecks, report.productionSizeChecks,
        isGarmentChainOrder(order));
      for (const evidenceReport of [failedReport, report]) if (evidenceReport.productionSizeChecks != null
        && evidenceReport.contentFingerprint !== await reportContentFingerprint(tx, evidenceReport))
        throw businessError('GATE_BLOCKED', '生产 QC 逐尺码内容或证据已变化，不能恢复。');
      resolved.push({ issue, report, current, scopeFingerprint: coverage.scopeFingerprint });
    }
    if (!resolved.length) throw businessError('INVALID_STATE', '当前工厂批次没有等待业务确认继续的生产 QC 问题。');
    const issueIds = resolved.map(row => row.issue.id).sort();
    let resumedAt = BigInt(0);
    for (const { issue, current, scopeFingerprint } of resolved) {
      const now = nextEventTime(await tx.productionQcIssueEvent.findMany({ where: { issueId: issue.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
      if (now > resumedAt) resumedAt = now;
      await tx.productionQcIssueEvent.create({ data: { id: eventId(), issueId: issue.id, orderId: order.id,
        orderLineId: batch.orderLineId, productionBatchId: batch.id, productionBatchRevision: batch.revision,
        kind: 'business_resumed', fromStatus: 'waiting_business_resume', toStatus: 'resumed', actorId: actor.userId,
        reportId: current.reportId, requestKey, commandHash,
        note: '业务负责人明确确认继续推进该工厂生产分支。', payload: { schemaVersion: 1, issueIds, scopeFingerprint }, createdAt: now } });
    }
    return { orderId: order.id, orderLineId: batch.orderLineId, productionBatchId: batch.id,
      productionBatchRevision: batch.revision, issueIds, resumedAt: String(resumedAt), replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
