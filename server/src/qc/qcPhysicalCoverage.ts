import { Prisma } from '@prisma/client';
import { lockOrderReleaseSources } from '../production/releaseService';
import { QcReportError, qcReportSourceFingerprint } from './qcReportAuthority';
import { isGarmentChainOrder } from './qcChainService';
import { isBusinessError } from '../shared/errorCodes';

export interface QcCoverageInput {
  scopeType: 'whole_order' | 'production_batch';
  productionBatchId?: string | null;
  expectedBatchRevision?: number;
  expectedScopeFingerprint?: string;
}
export interface QcPhysicalCoverage {
  scopeType: QcCoverageInput['scopeType'];
  scopeKey: string;
  productionBatchId: string | null;
  productionBatchRevision: number | null;
  scopeSnapshot: any;
  scopeFingerprint: string;
  factoryRelationId: string | null;
}
const conflict = () => new QcReportError('CONFLICT', '验货范围已变化，请刷新范围后重试。', 'source_changed');

/** Sources -> Order -> Lines -> Batch precedes assignment/report locks. This
 * freezes physical facts; recording a failed bulk inspection is independent of
 * whether a sample currently permits production or shipment. */
export async function lockQcCoverage(tx: any, orderId: string, batchId?: string | null) {
  await lockOrderReleaseSources(tx, orderId);
  const parent = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
  if (!parent.length) throw new QcReportError('NOT_FOUND', '订单不存在或不在当前业务范围。');
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "orderId" = ${orderId} ORDER BY "id" FOR UPDATE`);
  if (batchId) {
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "id" = ${batchId} AND "orderId" = ${orderId} FOR UPDATE`);
    if (!rows.length) throw new QcReportError('NOT_FOUND', '实际生产批次不存在或不属于该订单。');
  }
}

export async function resolveQcCoverage(tx: any, orderId: string, input: QcCoverageInput): Promise<QcPhysicalCoverage> {
  if (input.scopeType !== 'whole_order' && input.scopeType !== 'production_batch') {
    throw new QcReportError('VALIDATION_FAILED', '须明确选择整单或实际生产批次验货。');
  }
  const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null } });
  if (!order) throw new QcReportError('NOT_FOUND', '订单不存在或不在当前业务范围。');
  const lines = await tx.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
  if (!lines.length) throw new QcReportError('VALIDATION_FAILED', '订单没有实际明细行，无法冻结验货范围。');
  for (const line of lines) {
    const quantity = new Prisma.Decimal(line.quantity);
    if (!quantity.isFinite() || quantity.lte(0) || !line.unit?.trim()) {
      throw new QcReportError('CONFLICT', '订单行数量或单位无法核验，请先核对实际验货范围。', 'source_changed');
    }
  }
  const orderFacts = { orderId, customerRelationId: order.customerRelationId ?? null,
    factoryRelationId: order.millRelationId ?? null, sourceCaseId: order.sourceCaseId ?? null };
  const lineFacts = (line: any) => ({ orderLineId: line.id, lineNumber: line.lineNumber, itemNo: line.itemNo ?? null,
    quantity: String(line.quantity), unit: line.unit,
    materialCode: line.materialCode ?? null, description: line.description ?? null,
    width: line.width ?? null, weight: line.weight ?? null, styleNo: line.styleNo ?? null,
    colorName: line.colorName ?? null, sizeBreakdown: line.sizeBreakdown ?? null,
    confirmedSourceType: line.confirmedSourceType ?? null, confirmedSourceId: line.confirmedSourceId ?? null,
    specSnapshot: line.specSnapshot ?? null });
  let snapshot: any, batch: any = null;
  if (input.scopeType === 'production_batch') {
    if (typeof input.productionBatchId !== 'string' || !input.productionBatchId.trim()) {
      throw new QcReportError('VALIDATION_FAILED', '实际生产批次 ID 必填。');
    }
    batch = await tx.productionBatch.findUnique({ where: { id: input.productionBatchId } });
    if (!batch || batch.orderId !== orderId) throw new QcReportError('NOT_FOUND', '实际生产批次不存在或不属于该订单。');
    // The batch domain owns source/range identity; it does not require PP/QC
    // approval to describe physical coverage.
    const { resolveCurrentProductionBatchFacts } = await import('../production/productionBatchService');
    let facts;
    try { facts = await resolveCurrentProductionBatchFacts(tx, batch); }
    catch (error) {
      if (isBusinessError(error) && error.code === 'CONFLICT') throw conflict();
      throw error;
    }
    if (input.expectedBatchRevision !== undefined && input.expectedBatchRevision !== batch.revision) throw conflict();
    snapshot = { ...orderFacts, lines: [lineFacts(facts.line)], batch: { id: batch.id, batchCode: batch.batchCode,
      revision: batch.revision, factoryRelationId: batch.factoryRelationId,
      rangeStart: String(batch.rangeStart), quantity: String(batch.quantity), unit: batch.unit,
      sourceFingerprint: batch.sourceFingerprint } };
  } else {
    if (input.productionBatchId != null || input.expectedBatchRevision !== undefined) {
      throw new QcReportError('VALIDATION_FAILED', '整单验货不可携带批次范围。');
    }
    const batches = await tx.productionBatch.findMany({ where: { orderId, state: 'active' }, orderBy: { id: 'asc' } });
    snapshot = { ...orderFacts, lines: lines.map(lineFacts), batches: batches.map((row: any) => ({
      id: row.id, batchCode: row.batchCode, orderLineId: row.orderLineId, revision: row.revision,
      factoryRelationId: row.factoryRelationId, rangeStart: String(row.rangeStart), quantity: String(row.quantity),
      unit: row.unit, sourceFingerprint: row.sourceFingerprint })) };
  }
  return { scopeType: input.scopeType, scopeKey: batch ? `production_batch:${batch.id}` : 'whole_order',
    productionBatchId: batch?.id ?? null, productionBatchRevision: batch?.revision ?? null,
    factoryRelationId: batch?.factoryRelationId ?? order.millRelationId ?? null,
    scopeSnapshot: snapshot, scopeFingerprint: qcReportSourceFingerprint(snapshot) };
}

export function requireQcCoverageMatch(scope: QcPhysicalCoverage, expected: unknown) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new QcReportError('VALIDATION_FAILED', '须提供当前验货范围依据，请刷新范围。');
  }
  if (scope.scopeFingerprint !== expected) throw conflict();
}

/** A new physical range never inherits unknown historical coverage. Whole
 * reports apply only to a line/range still within their frozen current facts. */
export async function latestCurrentScopedFinal(tx: any, orderId: string, batchId: string) {
  const coverage = await resolveQcCoverage(tx, orderId, { scopeType: 'production_batch', productionBatchId: batchId });
  const { readProductionQcReleaseCoverage } = await import('./productionQcSizeCoverage');
  const quality = await readProductionQcReleaseCoverage(tx, { orderId, productionBatchId: batchId,
    expectedBatchRevision: coverage.productionBatchRevision ?? undefined });
  if (!quality.satisfied) return null;
  const exact = await tx.inspectionReport.findFirst({ where: { orderId, inspectionType: 'final', scopeKey: coverage.scopeKey }, orderBy: { revision: 'desc' } });
  if (exact) return exact.scopeFingerprint === coverage.scopeFingerprint ? exact : null;
  if (quality.sizeCoverage.applicable) return null;
  const whole = await tx.inspectionReport.findFirst({ where: { orderId, inspectionType: 'final', scopeKey: 'whole_order' }, orderBy: { revision: 'desc' } });
  if (!whole?.scopeFingerprint || !whole.scopeSnapshot) return null;
  const currentWhole = await resolveQcCoverage(tx, orderId, { scopeType: 'whole_order' });
  return whole.scopeFingerprint === currentWhole.scopeFingerprint ? whole : null;
}

/** Whole-order consumers never substitute a passing batch report. A later
 * failed/stale whole revision blocks older approved history. Historical null
 * coverage remains visible but cannot qualify newly introduced batch ranges. */
export async function latestCurrentWholeFinal(tx: any, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { businessLine: true, type: true } });
  if (isGarmentChainOrder(order)) return null;
  const report = await tx.inspectionReport.findFirst({ where: { orderId, inspectionType: 'final', scopeKey: 'whole_order' },
    orderBy: { revision: 'desc' } });
  if (!report) return null;
  if (!report.scopeFingerprint) {
    return await tx.productionBatch.count({ where: { orderId, state: 'active' } }) ? null : report;
  }
  const scope = await resolveQcCoverage(tx, orderId, { scopeType: 'whole_order' });
  return report.scopeFingerprint === scope.scopeFingerprint ? report : null;
}
