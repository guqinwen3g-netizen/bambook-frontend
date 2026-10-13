import type { TokenPayload } from '../auth/service';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { qcReportReadWhere, currentQcReportActor, QcReportError, qcReportSourceFingerprint } from './qcReportAuthority';
import { readProductionQcSizeCoverage } from './productionQcSizeCoverage';

/** The exact native complete/decision content binding, shared with readers.
 * No locks, writes or transactions; the caller owns the consistent read. */
export const QC_REPORT_CONTENT_FIELDS = ['result', 'inspectionDate', 'totalUnits', 'passedUnits', 'lotSize', 'sampleSize', 'aqlLevel',
  'criticalDefects', 'majorDefects', 'minorDefects', 'defectSummary', 'notes', 'productionSizeChecks', 'evidenceFiles'] as const;
export async function reportContentFingerprint(tx: any, report: any) {
  const widths = await tx.inspectionWidthMeasurement.findMany({ where: { reportId: report.id }, orderBy: { orderLineId: 'asc' },
    select: { orderLineId: true, measuredWidthCm: true, basisWidthCm: true, note: true } });
  // Preserve pre-size-check hashes for unchanged fabric/legacy reports. A real
  // native size observation joins the content binding as soon as it exists.
  return qcReportSourceFingerprint({ ...Object.fromEntries(QC_REPORT_CONTENT_FIELDS
    .filter(field => !['productionSizeChecks', 'evidenceFiles'].includes(field) || report[field] != null)
    .map(field => [field, report[field] ?? null])), widths });
}

export async function attachReportCoverageContext(tx: any, rows: any[], actor: TokenPayload) {
    const scoped = rows.filter(row => row.scopeFingerprint);
    if (!scoped.length) return rows;
    const canWrite = hasScope({ ...actor, roles: [] }, 'qc:write');
    const visible = canWrite ? await tx.order.findMany({ where: { deletedAt: null,
      id: { in: [...new Set(scoped.map(row => row.orderId))] }, AND: [await freshOrderLineScope(tx, actor)] } }) : [];
    const visibleById = new Map<string, any>(visible.map((row: any) => [row.id, row]));
    const { resolveQcCoverage } = await import('./qcPhysicalCoverage');
    const sizeCoverageByBatch = new Map<string, ReturnType<typeof readProductionQcSizeCoverage>>();
    return Promise.all(rows.map(async report => {
      if (!report.scopeFingerprint) return report;
      const latest = await tx.inspectionReport.findFirst({ where: { orderId: report.orderId,
        inspectionType: report.inspectionType, scopeKey: report.scopeKey }, orderBy: { revision: 'desc' }, select: { id: true } });
      let coverageCurrent = false;
      try {
        const coverage = await resolveQcCoverage(tx, report.orderId, { scopeType: report.scopeType,
          productionBatchId: report.productionBatchId, expectedBatchRevision: report.productionBatchRevision ?? undefined });
        coverageCurrent = coverage.scopeFingerprint === report.scopeFingerprint;
      } catch (error) {
        if (!(error instanceof QcReportError) || !['NOT_FOUND', 'CONFLICT', 'VALIDATION_FAILED'].includes(error.code)) throw error;
      }
      const order = visibleById.get(report.orderId);
      let responsible = !!order && order.ownerId === actor.userId;
      if (order?.departmentId && !responsible) {
        const department = await tx.department.findUnique({ where: { id: order.departmentId } });
        responsible = department?.status === 'active' && department.headId === actor.userId;
      }
      const isCurrentRevision = latest?.id === report.id;
      const contentCurrent = typeof report.contentFingerprint === 'string' && report.contentFingerprint === await reportContentFingerprint(tx, report);
      let productionSizeCoverage;
      if (report.scopeType === 'production_batch' && coverageCurrent) {
        const key = `${report.orderId}:${report.productionBatchId}:${report.productionBatchRevision}:${report.scopeFingerprint}`;
        if (!sizeCoverageByBatch.has(key)) sizeCoverageByBatch.set(key, readProductionQcSizeCoverage(tx, {
          orderId: report.orderId, productionBatchId: report.productionBatchId, expectedBatchRevision: report.productionBatchRevision }));
        productionSizeCoverage = await sizeCoverageByBatch.get(key);
      }
      return { ...report, coverageCurrent, isCurrentRevision, contentCurrent,
        ...(productionSizeCoverage ? { productionSizeCoverage } : {}),
        canBusinessDecide: responsible && isCurrentRevision && coverageCurrent && contentCurrent && report.approvedAt == null && !report.approvedByBusiness };
    }));
  }


/** Existing report responsibility, not an invented Task/ApprovalRequest queue.
 * Only actual owner/active department head with QC read/write and current Order
 * L2 can receive a business-decision item. Invalid source remains an explicit
 * risk item; unknown storage failures propagate to the complete group stamp. */
export async function pendingQcBusinessReports(tx: any, prior: TokenPayload) {
  const actor = await currentQcReportActor(tx, prior, 'qc:read');
  if (!hasScope({ ...actor, roles: [] }, 'qc:write')) return [];
  const departments = await tx.department.findMany({ where: { status: 'active', headId: actor.userId }, select: { id: true } });
  const orders = await tx.order.findMany({ where: { deletedAt: null, AND: [await freshOrderLineScope(tx, actor),
    { OR: [{ ownerId: actor.userId }, { departmentId: { in: departments.map((row: any) => row.id) } }] }] } });
  if (!orders.length) return [];
  const authorized = await qcReportReadWhere(tx, actor);
  const rows = await tx.inspectionReport.findMany({ where: { approvedAt: null, approvedByBusiness: false,
    AND: [authorized.where, { orderId: { in: orders.map((row: any) => row.id) } }] }, orderBy: { id: 'asc' } });
  const enriched = await attachReportCoverageContext(tx, rows, actor);
  const byId = new Map<string, any>(orders.map((row: any) => [row.id, row]));
  // Legacy unscoped reports keep their original reader/signing contract. This
  // new queue does not pretend that they carry native scoped decision inputs.
  return enriched.filter(row => row.scopeFingerprint).map(report => ({ report,
    responsibility: { kind: byId.get(report.orderId)?.ownerId === actor.userId ? 'owned-by-me' as const : 'scope-visible' as const,
      userId: actor.userId } }));
}
