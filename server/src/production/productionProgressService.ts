
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { currentDocumentActor } from '../shipping/shipmentDocumentSource';
import { readOrderLineProductionCompletion } from './productionCompletionService';
import { readProductionQcReleaseCoverage } from '../qc/productionQcSizeCoverage';
import { latestCurrentScopedFinal } from '../qc/qcPhysicalCoverage';
import { reportContentFingerprint } from '../qc/qcReportReadProjection';
import { hasScope } from '../auth/permissionService';
import { documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { businessError } from '../shared/errorCodes';
import type { ProductionProgressBoard, ProductionProgressItem, ProductionProgressLine, ProductionProgressBranch } from './productionProgressContract';
import { todayLocalKey } from '../shared/localDate';


/** Reuses the exact completion and QC consumers. Plans are displayed separately
 * from actual completions; a good report never silently resumes a NOK branch. */
export async function readProductionProgressBoard(prisma: PrismaClient, prior: TokenPayload | null | undefined): Promise<ProductionProgressBoard> {
  return prisma.$transaction(async tx => {
    const actor = await currentDocumentActor(tx, prior, ['production:read', 'orders:read']);
    const scope = await freshOrderLineScope(tx, actor);
    const orders = await tx.order.findMany({ where: { deletedAt: null, status: { notIn: ['Cancelled', 'Archived'] }, AND: [scope] }, orderBy: [{ importedAt: 'desc' }, { id: 'asc' }] });
    const orderIds = orders.map(order => order.id);
    const allLines = orderIds.length ? await tx.orderLine.findMany({ where: { orderId: { in: orderIds } }, orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] }) : [];
    const items: ProductionProgressItem[] = [];
    const today = todayLocalKey();
    for (const order of orders) {
      const lines: ProductionProgressLine[] = [];
      for (const line of allLines.filter(candidate => candidate.orderId === order.id)) {
        const completion = await readOrderLineProductionCompletion(tx, order, line), branches: ProductionProgressBranch[] = [];
        for (const branch of completion.branches) {
          const canReadQc = hasScope(actor, 'qc:read');
          const quality = canReadQc ? await readProductionQcReleaseCoverage(tx, { orderId: order.id, productionBatchId: branch.productionBatchId, expectedBatchRevision: branch.productionBatchRevision }) : null;
          const issues = quality?.productionQcIssues;
          const final = quality?.satisfied ? await latestCurrentScopedFinal(tx, order.id, branch.productionBatchId) : null;
          const finalContentCurrent = final ? typeof final.contentFingerprint === 'string' && final.contentFingerprint === await reportContentFingerprint(tx, final) : false;
          const unknown = !quality || !quality.sizeCoverage.available || !issues?.available || issues.issues.some(issue => issue.status === 'unknown') || (!!final && !finalContentCurrent);
          const paused = issues?.issues.some(issue => issue.status === 'open');
          const waiting = issues?.issues.some(issue => issue.status === 'waiting_business_resume');
          const finalPassed = !!final && finalContentCurrent && final.result === 'pass';
          const factory = await tx.relation.findFirst({ where: { id: branch.factoryRelationId, deletedAt: null }, select: { name: true } });
          branches.push({ productionBatchId: branch.productionBatchId, productionBatchRevision: branch.productionBatchRevision,
            factoryRelationId: branch.factoryRelationId, factoryName: factory?.name ?? null, plannedQty: branch.plannedQty, actualQty: branch.actualQty,
            unit: branch.unit, completionId: branch.completionId, completedAt: branch.completedAt,
            qcState: unknown ? 'unknown' : paused ? 'paused' : waiting ? 'waiting_business_resume' : finalPassed && quality?.satisfied ? 'clear' : 'incomplete',
            qcReportId: finalContentCurrent ? final.id : null,
            businessDecision: unknown ? 'unknown' : !final || final.approvedAt == null ? 'pending' : final.approvedByBusiness ? 'accepted' : 'rejected',
            qcReasons: unknown ? ['当前质量依据暂不可核实。'] : !final && quality?.satisfied ? ['尚无覆盖本分支的当前正式 Final 检验报告。'] : quality?.failureReasons ?? [],
            qualityCoverage: quality?.sizeCoverage.available ? { applicable: quality.sizeCoverage.applicable,
              actualSizes: quality.sizeCoverage.actualSizes, missingSizes: quality.sizeCoverage.missingSizes, failedSizes: quality.sizeCoverage.failedSizes } : null });
        }
        lines.push({ orderLineId: line.id, description: line.description ?? line.itemNo ?? line.id, contractQty: completion.contractQty, unit: completion.unit,
          status: completion.status as ProductionProgressLine['status'], productionComplete: completion.productionComplete, actualQty: completion.actualQty,
          quantityDecisionState: completion.tolerance.status, branches, blockers: completion.blockers.map(blocker => ({ code: blocker.code,
            message: blocker.code === 'PRODUCTION_COMPLETION_SOURCE_STALE' ? '当前准确生产来源或完工依据暂不可核实。' : blocker.message })) });
      }
      const branches = lines.flatMap(line => line.branches);
      const state: ProductionProgressItem['state'] = !lines.length ? 'no_items'
        : lines.some(line => line.status === 'unresolved' && !line.productionComplete) ? 'source_unknown'
          : lines.every(line => line.productionComplete) ? 'production_complete'
            : !branches.length ? 'not_started' : 'in_progress';
      items.push({ order: { id: order.id, code: order.code, poNumber: order.poNumber, customer: order.customer,
        businessLine: order.businessLine ?? order.type, dueDate: order.dueDate ?? null,
        productionDeadline: order.productionDate || allLines.filter(line => line.orderId === order.id).map(line => line.deliveryDate).filter(Boolean).sort()[0] || null,
        exMillDate: order.clientDate || allLines.filter(line => line.orderId === order.id).map(line => line.exMillDate).filter(Boolean).sort()[0] || null }, state, lines,
        blockedBranchCount: branches.filter(branch => ['paused', 'waiting_business_resume'].includes(branch.qcState)).length,
        unknownBranchCount: branches.filter(branch => branch.qcState === 'unknown').length });
    }
    const finalActor = await currentDocumentActor(tx, prior, ['production:read', 'orders:read']);
    if (documentSourceFingerprint(finalActor) !== documentSourceFingerprint(actor)
      || documentSourceFingerprint(await freshOrderLineScope(tx, finalActor)) !== documentSourceFingerprint(scope))
      throw businessError('CONFLICT', '生产范围或当前授权在读取时变化，请刷新后重试。');
    const stageDistribution = { no_items: 0, not_started: 0, in_progress: 0, production_complete: 0, source_unknown: 0 };
    items.forEach(item => stageDistribution[item.state]++);
    const branches = items.flatMap(item => item.lines.flatMap(line => line.branches));
    return { schemaVersion: 1, items, stats: { totalActive: items.length, fullyCompleted: stageDistribution.production_complete,
      overdueCount: items.filter(item => item.state !== 'production_complete' && item.order.productionDeadline && item.order.productionDeadline < today).length,
      stageDistribution, actualBranchCount: branches.length, completedBranchCount: branches.filter(branch => branch.completionId !== null).length,
      pausedBranchCount: items.reduce((sum, item) => sum + item.blockedBranchCount, 0), unknownBranchCount: items.reduce((sum, item) => sum + item.unknownBranchCount, 0) } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 });
}

export async function readProductionProgressOrder(prisma: PrismaClient, actor: TokenPayload | null | undefined, orderId: string) {
  const board = await readProductionProgressBoard(prisma, actor);
  const item = board.items.find(candidate => candidate.order.id === orderId);
  if (!item) throw businessError('NOT_FOUND', '订单不存在或不在当前业务范围。');
  return item;
}

/** Actual due dates and unresolved quality issues, without invented seven-day
 * plan deadlines or conclusions inferred from opening a workspace. */
export async function readProductionProgressAlerts(prisma: PrismaClient, actor: TokenPayload | null | undefined) {
  const board = await readProductionProgressBoard(prisma, actor);
  const today = todayLocalKey();
  const alerts = board.items.flatMap(item => {
    const base = { orderId: item.order.id, poNumber: item.order.poNumber, customer: item.order.customer };
    const rows: Array<typeof base & { alertType: string; deadline: string | null; message: string; severity: 'high' | 'critical' }> = [];
    if (item.state !== 'production_complete' && item.order.productionDeadline && item.order.productionDeadline < today)
      rows.push({ ...base, alertType: 'production_due_overdue', deadline: item.order.productionDeadline, message: `已过生产交期 ${item.order.productionDeadline}，实际生产完工尚未齐备。`, severity: 'high' });
    if (item.blockedBranchCount) rows.push({ ...base, alertType: 'production_qc_paused', deadline: null,
      message: `${item.blockedBranchCount} 个准确生产分支存在未解除 QC 问题或等待业务明确恢复。`, severity: 'critical' });
    if (item.unknownBranchCount || item.state === 'source_unknown') rows.push({ ...base, alertType: 'production_facts_unknown', deadline: null,
      message: '当前生产或质量依据尚不可核实，请打开准确条目检查。', severity: 'high' });
    return rows;
  }).sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.orderId.localeCompare(b.orderId));
  return { alerts, total: alerts.length };
}
