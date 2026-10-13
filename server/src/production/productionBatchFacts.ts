import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { assertManualOrderLineSource } from '../orders/manualOrderLineSource';
import { readBatchProductionLineIdentity } from './productionLineIdentity';

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Intentional neutral source rejection, distinct from a storage error shape. */
export class ProductionBatchFactsError extends Error {
  public readonly code = 'CONFLICT';
  public readonly statusCode: number;
  constructor(message: string) {
    const canonical = businessError('CONFLICT', message);
    super(canonical.message); this.name = 'ProductionBatchFactsError'; this.statusCode = canonical.statusCode;
  }
}
const conflict = (message: string): never => { throw new ProductionBatchFactsError(message); };

export function productionBatchLineFingerprint(order: any, line: any): string {
  return hash({ order: { id: order.id, customerRelationId: order.customerRelationId ?? null, millRelationId: order.millRelationId ?? null, sourceCaseId: order.sourceCaseId ?? null },
  line: { id: line.id, orderId: line.orderId, confirmedSourceType: line.confirmedSourceType ?? null, confirmedSourceId: line.confirmedSourceId ?? null,
      specSnapshot: line.specSnapshot ?? null, sizeBreakdown: line.sizeBreakdown ?? null,
      quantity: new Prisma.Decimal(line.quantity).toString(), unit: line.unit ?? null } });
}
export function productionBatchSourceFingerprint(order: any, line: any, factoryRelationId: string): string {
  // Full line quantity deliberately excluded: increasing it never expands an
  // existing batch range or a QC coverage. Batch quantity/revision is separate.
  return hash({ orderId: order.id, customerRelationId: order.customerRelationId ?? null, sourceCaseId: order.sourceCaseId ?? null,
    orderLineId: line.id, confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId,
    specSnapshot: line.specSnapshot, factoryRelationId, unit: line.unit });
}
export function physicalRange(batch: any, line: any) {
  const start = new Prisma.Decimal(batch.rangeStart), qty = new Prisma.Decimal(batch.quantity), total = new Prisma.Decimal(line.quantity);
  if (!start.isFinite() || start.lt(0) || !qty.isFinite() || qty.lte(0) || start.decimalPlaces() > 4 || qty.decimalPlaces() > 4 || start.plus(qty).gt(total)) return conflict('批次范围与当前订单行数量不一致。');
}
/** Pure persisted identity/factory read, including soft-deleted history. It
 * does not decide sample recognition, PP or production eligibility. */
async function recordedSourceFactory(tx: any, line: any): Promise<string | null> {
  if (line.confirmedSourceType === 'ManualOrderLine') return (await assertManualOrderLineSource(tx, line.id, line.orderId)).factoryRelationId;
  if (line.confirmedSourceType === 'SealSample') {
    const row = await tx.sealSample.findUnique({ where: { id: line.confirmedSourceId } });
    if (!row) return conflict('批次的封样来源身份已不存在。');
    return row.supplierRelationId ?? null;
  }
  if (line.confirmedSourceType === 'Sample') {
    const row = await tx.sample.findUnique({ where: { id: line.confirmedSourceId } });
    if (!row) return conflict('批次的样品来源身份已不存在。');
    return row.supplierRelationId ?? null;
  }
  if (line.confirmedSourceType === 'Asset') {
    const row = await tx.productAsset.findUnique({ where: { id: line.confirmedSourceId }, include: { fabricProfile: true, garmentProfile: true } });
    if (!row) return conflict('批次的商品来源身份已不存在。');
    return String(row.mainCategory).toLowerCase() === 'fabric' ? row.fabricProfile?.millOrganizationId ?? null : row.garmentProfile?.factoryRelationId ?? null;
  }
  return conflict('批次来源身份无法核对。');
}
/** Caller owns Source→Order→Line→Batch locks. This is neutral range/source
 * identity consistency, NOT PP/sample eligibility. QC can record a failed
 * result independently of whether production is currently permitted. */
export async function resolveCurrentProductionBatchFacts(tx: any, supplied: any) {
  const batch = await tx.productionBatch.findUnique({ where: { id: supplied.id } });
  if (!batch || batch.state !== 'active' || batch.revision !== supplied.revision) return conflict('实际生产批次已变化，请读取当前范围。');
  const order = await tx.order.findFirst({ where: { id: batch.orderId, deletedAt: null } });
  const line = await tx.orderLine.findUnique({ where: { id: batch.orderLineId } });
  if (!order || !line || line.orderId !== order.id) return conflict('批次的真实订单或订单行已不可用。');
  physicalRange(batch, line);
  const businessLine = String(order.businessLine ?? order.type ?? '').trim().toLowerCase();
  const isGarment = businessLine === 'garment';
  const sourceFactory = await recordedSourceFactory(tx, line);
  // A garment sample source identifies the approved design/version. The
  // eventual production branch may be assigned to another factory. Fabric
  // production remains fixed to its confirmed single mill.
  if (!isGarment && sourceFactory && sourceFactory !== batch.factoryRelationId) return conflict('批次的真实来源工厂已变化。');
  if (batch.confirmedSourceType !== line.confirmedSourceType || batch.confirmedSourceId !== line.confirmedSourceId
    || hash(batch.specSnapshot) !== hash(line.specSnapshot) || batch.unit !== line.unit
    || (!isGarment && order.millRelationId && order.millRelationId !== batch.factoryRelationId)
    || batch.sourceFingerprint !== productionBatchSourceFingerprint(order, line, batch.factoryRelationId)) return conflict('批次与当前订单行来源、规格、工厂或单位不一致。');
  const productionLineIdentity = await readBatchProductionLineIdentity(tx, batch);
  return { order, line, batch, lineFingerprint: productionBatchLineFingerprint(order, line), productionLineIdentity };
}
