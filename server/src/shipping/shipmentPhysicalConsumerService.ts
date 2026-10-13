import { Prisma } from '@prisma/client';
import { exactJsonValue } from '../lib/exactJsonValue';
import { assertShipmentInvoiceAutomation, type ShipmentInvoiceAutomationSource } from '../events/linkages/shipmentInvoiceAutomationSource';
import { currentShipmentFinancialActor } from './shipmentFinancialActor';
import type { TokenPayload } from '../auth/service';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { lockReleaseSources } from '../production/releaseService';
import { resolveCurrentProductionBatchFacts } from '../production/productionBatchService';
import { resolveQcCoverage } from '../qc/qcPhysicalCoverage';
import { readProductionQcReleaseCoverage } from '../qc/productionQcSizeCoverage';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { businessError } from '../shared/errorCodes';
import { assertPhysicalShipmentWriteAuthority, validatePhysicalAllocationVersion,
  readPhysicalReceiptAllocations, verifyOriginalProductionReceipt } from './shipmentPhysicalAllocationService';
import { verifyFactoryLoadingReceiptInTx } from './factoryLoadingReceiptService';

const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const same = (left: unknown, right: unknown) => qcReportSourceFingerprint(left) === qcReportSourceFingerprint(right);
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
export type PhysicalConsumerMode = 'edit' | 'packing' | 'ship' | 'cancel';
export type ShipmentPhysicalContext = {
  kind: 'legacy' | 'claim' | 'physical'; shipment: any; actor: TokenPayload | null;
  orderIds: string[]; allocations: any[]; physical: any[]; batches: any[]; allocationFingerprint: string;
};
async function sourceHints(tx: any, shipmentId: string, missingShipmentCode: 'NOT_FOUND' | 'SHIPMENT_NOT_FOUND' = 'NOT_FOUND') {
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment || shipment.deletedAt != null) throw businessError(missingShipmentCode, '运单不存在或不可查看。');
  const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
  const orderIds = [...new Set<string>([shipment.orderId, ...allocations.map((row: any) => row.orderId)].filter(Boolean))].sort();
  const claims = await tx.claimDisposition.findMany({ where: { replacementShipmentId: shipmentId }, select: { id: true } });
  const repairs = await tx.repairWorkOrder.findMany({ where: { reshipmentId: shipmentId }, select: { id: true } });
  return { shipment, allocations, orderIds, claimIds: claims.map((row: any) => row.id), repairIds: repairs.map((row: any) => row.id) };
}
const anchors = (hint: Awaited<ReturnType<typeof sourceHints>>) => ({ shipmentId: hint.shipment.id,
  headerOrderId: hint.shipment.orderId, allocations: hint.allocations.map((row: any) => [row.id, row.orderId, row.orderLineId]),
  claimIds: hint.claimIds, repairIds: hint.repairIds });
async function visibleParents(tx: any, ids: string[], actor: TokenPayload) {
  const scope = await freshOrderLineScope(tx, actor);
  for (const id of ids) {
    const order = await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } });
    if (!order) throw businessError('ORDER_NOT_FOUND', '来源订单不存在或不可查看。');
  }
}
async function lockIds(tx: any, table: 'ProductionBatch' | 'ShipmentOrderAllocation' | 'ShipmentProductionAllocation', ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + table + '"')}
    WHERE "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`);
}
export function physicalShipmentAllocationFingerprint(context: Pick<ShipmentPhysicalContext, 'shipment' | 'orderIds' | 'allocations' | 'physical'>): string {
  return qcReportSourceFingerprint({ schemaVersion: 1, shipmentId: context.shipment.id, orderIds: context.orderIds,
    allocations: json(context.allocations), physical: json(context.physical) });
}
/** All ordinary consumers enter here BEFORE taking Shipment or inventory locks.
 * The trusted scalar-actor legacy seam cannot turn a modern source into legacy.
 * Claim consumers retain their separate established parent lock order. */
export async function lockShipmentPhysicalConsumer(tx: any, params: {
  shipmentId: string; actor?: TokenPayload | null; mode: PhysicalConsumerMode; authority?: 'invoice';
  /** Preserve each public consumer's missing-target contract without remapping missing parent/source errors. */
  missingShipmentCode?: 'NOT_FOUND' | 'SHIPMENT_NOT_FOUND';
  automation?: ShipmentInvoiceAutomationSource;
}): Promise<ShipmentPhysicalContext> {
  const automating = params.automation !== undefined;
  if (automating) {
    if (params.actor !== undefined || params.authority !== 'invoice') return conflict('自动开票来源不能替代人工授权。');
    assertShipmentInvoiceAutomation(tx, params.automation!, params.shipmentId);
  }
  const before = await sourceHints(tx, params.shipmentId, params.missingShipmentCode);
  if (before.claimIds.length || before.repairIds.length) return { kind: 'claim', ...before, actor: params.actor ?? null,
    physical: [], batches: [], allocationFingerprint: '' };
  const currentAuthority = () => automating
    ? (assertShipmentInvoiceAutomation(tx, params.automation!, params.shipmentId), null)
    : params.authority === 'invoice'
    ? currentShipmentFinancialActor(tx, params.actor, 'invoice') : assertPhysicalShipmentWriteAuthority(tx, params.actor ?? null, before.orderIds.length > 0);
  let actor = params.actor === undefined ? null : await currentAuthority();
  if (actor) await visibleParents(tx, before.orderIds, actor);
  // DR-054: the active S/S producer is Sample(type=ship, sourceOrderId),
  // not the retired FabricShipmentSample table. Native writers take
  // DevelopmentCase -> Sample -> Order, including the Order lock on insert.
  const evidence = before.orderIds.length ? await tx.sample.findMany({ where: {
    sourceOrderId: { in: before.orderIds }, type: 'ship', deletedAt: null,
  }, select: { id: true } }) : [];
  await lockReleaseSources(tx, before.orderIds, { evidenceSampleIds: evidence.map((row: any) => row.id) });
  const currentEvidence = before.orderIds.length ? await tx.sample.findMany({ where: {
    sourceOrderId: { in: before.orderIds }, type: 'ship', deletedAt: null,
  }, select: { id: true } }) : [];
  if (!same(evidence.map((row: any) => row.id).sort(), currentEvidence.map((row: any) => row.id).sort()))
    return conflict('船样集合在取得来源锁时变化，请刷新后重试。');
  const batches = await tx.productionBatch.findMany({ where: { orderId: { in: before.orderIds } }, orderBy: { id: 'asc' } });
  await lockIds(tx, 'ProductionBatch', batches.map((row: any) => row.id));
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id"=${params.shipmentId} FOR UPDATE`);
  const current = await sourceHints(tx, params.shipmentId, params.missingShipmentCode);
  if (!same(anchors(before), anchors(current))) return conflict('运单来源在取得锁时变化，请读取当前运单后重试原请求。');
  await lockIds(tx, 'ShipmentOrderAllocation', current.allocations.map((row: any) => row.id));
  const physical = await tx.shipmentProductionAllocation.findMany({ where: { shipmentId: params.shipmentId }, orderBy: { id: 'asc' } });
  await lockIds(tx, 'ShipmentProductionAllocation', physical.map((row: any) => row.id));
  const currentBatches = await tx.productionBatch.findMany({ where: { orderId: { in: current.orderIds } }, orderBy: { id: 'asc' } });
  if (!same(batches.map((row: any) => [row.id, row.orderId, row.orderLineId]), currentBatches.map((row: any) => [row.id, row.orderId, row.orderLineId])))
    return conflict('生产批次集合在取得来源锁时变化，请重试原请求。');
  const modern = !!(currentBatches.length || physical.length);
  if (modern || params.actor !== undefined) {
    actor = await currentAuthority();
    if (actor) await visibleParents(tx, current.orderIds, actor);
  }
  const context: ShipmentPhysicalContext = { kind: modern ? 'physical' : 'legacy', ...current, actor,
    physical: await tx.shipmentProductionAllocation.findMany({ where: { shipmentId: params.shipmentId }, orderBy: { id: 'asc' } }), batches: currentBatches,
    allocationFingerprint: '' };
  context.allocationFingerprint = physicalShipmentAllocationFingerprint(context);
  return context;
}
function amount(value: unknown): Prisma.Decimal | null {
  if (value === null) return null;
  if (value === undefined || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(String(value))) return conflict('原物理分配数量无法精确核验。');
  return new Prisma.Decimal(String(value));
}
export type VerifiedPhysicalShipment = {
  context: ShipmentPhysicalContext; rows: any[]; physicalBatchIdsByOrder: Record<string, string[]>;
};
/** Reserved current source proof. A plan never becomes actual goods. This
 * verifies source identity; inventory is revalidated again under its later locks. */
export async function validateReservedPhysicalShipment(tx: any, context: ShipmentPhysicalContext, requireActual: boolean): Promise<VerifiedPhysicalShipment> {
  if (context.kind !== 'physical') return conflict('本票没有可核验的实际批次来源。');
  const rows: any[] = [], groups: Record<string, string[]> = {};
  const qualityCheckedBatches = new Set<string>();
  for (const allocation of context.allocations.filter((row: any) => row.status !== 'Cancelled')) {
    const planned = amount(allocation.plannedQty), actual = amount(allocation.actualQty);
    if (planned?.isZero() && actual?.isZero()) continue;
    const projections = context.physical.filter((row: any) => row.allocationId === allocation.id);
    if (!projections.length || !allocation.orderLineId) return conflict('本票仍有未核清实际批次来源的原分配，请先补齐原关联。');
    await validatePhysicalAllocationVersion(tx, allocation, projections);
    let sumPlanned = new Prisma.Decimal(0), sumActual = new Prisma.Decimal(0), unknownPlan = false, unknownActual = false;
    for (const projection of projections) {
      if (projection.state !== 'reserved' || projection.shipmentId !== context.shipment.id || projection.orderId !== allocation.orderId
        || projection.orderLineId !== allocation.orderLineId || projection.unit !== allocation.unit) return conflict('本票物理预留状态或归属与原分配不一致。');
      const batch = context.batches.find((row: any) => row.id === projection.productionBatchId);
      if (!batch || batch.orderId !== allocation.orderId || batch.orderLineId !== allocation.orderLineId
        || batch.revision !== projection.productionBatchRevision || batch.unit !== allocation.unit) return conflict('本票实际批次与当前订单行不一致。');
      await resolveCurrentProductionBatchFacts(tx, batch);
      const coverage = await resolveQcCoverage(tx, batch.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
      if (projection.scopeSnapshot?.scopeFingerprint !== coverage.scopeFingerprint) return conflict('本票实际批次范围已变化，请先核对原分配。');
      for (const row of readPhysicalReceiptAllocations(projection)) {
        if (row.plannedQty === null) unknownPlan = true; else sumPlanned = sumPlanned.plus(row.plannedQty);
        if (row.actualQty === null) unknownActual = true; else sumActual = sumActual.plus(row.actualQty);
        if (requireActual && row.actualQty === null) return conflict('实际出运数量尚未明确，计划数量不能代替实际货物。');
        if (row.actualQty !== null && new Prisma.Decimal(row.actualQty).gt(0)) {
          if (!row.stockReceiptId && !row.factoryLoadingReceiptId) return conflict('实际货物缺少原生收货或工厂实装凭据。');
          const receipt = row.factoryLoadingReceiptId
            ? await verifyFactoryLoadingReceiptInTx(tx, row.factoryLoadingReceiptId, batch, coverage.scopeFingerprint,
              { shipmentId: context.shipment.id, allocationId: allocation.id })
            : await verifyOriginalProductionReceipt(tx, row.stockReceiptId!, batch, coverage.scopeFingerprint);
          if (row.factoryLoadingReceiptId && new Prisma.Decimal(row.actualQty).gt(receipt.receipt.quantity)) return conflict('工厂直出实际量超过原核验凭据。');
          const stored = projection.scopeSnapshot.receiptAllocations.find((item: any) => item.stockReceiptId === row.stockReceiptId
            && (item.factoryLoadingReceiptId ?? null) === (row.factoryLoadingReceiptId ?? null));
          if (!stored || Object.entries(receipt.identity).some(([key, value]) => stored[key] !== value)) return conflict('实际货物凭据的来源身份已变化，请核对原收货或工厂实装记录。');
          // Both warehouse goods and factory-direct goods consume the same
          // exact branch quality facts. Neither a loading receipt nor an Order
          // exception supplies missing size observations or business resumption.
          if (!qualityCheckedBatches.has(batch.id)) {
            const quality = await readProductionQcReleaseCoverage(tx, { orderId: batch.orderId,
              productionBatchId: batch.id, expectedBatchRevision: batch.revision });
            if (!quality.satisfied) throw businessError('GATE_BLOCKED',
              `生产分支 ${batch.id} 暂不能继续出运：${quality.failureReasons.join('；')}`);
            qualityCheckedBatches.add(batch.id);
          }
          rows.push({ allocationId: allocation.id, physicalAllocationId: projection.id, orderId: batch.orderId, orderLineId: batch.orderLineId,
            ...row, ...receipt.identity });
          (groups[batch.orderId] ??= []).push(batch.id);
        }
      }
    }
    if ((planned === null) !== unknownPlan || (actual === null) !== unknownActual
      || planned !== null && !planned.equals(sumPlanned) || actual !== null && !actual.equals(sumActual)) return conflict('本票批次数量与原订单行分配合计不一致。');
  }
  if (requireActual && !rows.length) return conflict('本票没有明确的实际货物，不能使用计划或零数量发运。');
  return { context, rows, physicalBatchIdsByOrder: Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, [...new Set(ids)].sort()])) };
}
