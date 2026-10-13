/** Exact persisted shipment sources. Navigation/body snapshots are never facts.
 * Reads are authorized using current account/grants, the initiating ceiling and
 * the existing Order L2 policy. No stock, invoice or shipment fact is produced. */
import { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { lockReleaseSources } from '../production/releaseService';
import { exactJsonValue } from '../lib/exactJsonValue';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { physicalShipmentAllocationFingerprint } from './shipmentPhysicalConsumerService';
import { readPhysicalReceiptAllocations } from './shipmentPhysicalAllocationService';
import { isShipmentShipped } from '../shared/shippingLock';
import { verifyFactoryLoadingReceiptInTx } from './factoryLoadingReceiptService';

function conflict(message: string): never { throw businessError('CONFLICT', message); }
function invisible(): never { throw businessError('NOT_FOUND', '来源不存在或不可查看。'); }
const ids = (values: any[]): string[] => [...new Set<string>(values.filter((v): v is string => typeof v === 'string' && !!v))].sort();
export const documentSourceJson = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
export const documentSourceFingerprint = (value: any): string => qcReportSourceFingerprint(documentSourceJson(value));

/** Keep null/zero distinct; never round a source decimal or coerce Infinity. */
export function documentDecimal(value: unknown): string | null {
  if (value == null) return null;
  try {
    const number = new Prisma.Decimal(String(value));
    if (!number.isFinite()) return conflict('原单十进制数值无效。');
    return number.toString();
  } catch (error) { if (isBusinessError(error)) throw error; return conflict('原单十进制数值无效。'); }
}

export async function currentDocumentActor(tx: any, prior: TokenPayload | null | undefined,
  scopes: readonly PermissionScope[]): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前账号读取业务单据。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) { if (isBusinessError(error)) throw error; throw businessError('AUTHORIZATION_UNAVAILABLE', '当前单据权限暂时无法核验。'); }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  for (const scope of scopes) if (!hasScope(actor, scope)) throw businessError('FORBIDDEN', '当前账号没有来源单据权限。');
  return actor;
}
export async function authorizedDocumentOrders(tx: any, actor: TokenPayload, orderIds: string[]): Promise<any[]> {
  if (!orderIds.length) return [];
  const scope = await freshOrderLineScope(tx, actor), orders: any[] = [];
  for (const id of ids(orderIds)) {
    const order = await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, include: { lines: { orderBy: { id: 'asc' } } } });
    if (!order) invisible();
    orders.push(order);
  }
  return orders;
}
export type ShipmentDocumentSource = {
  shipment: any; orders: any[]; orderIds: string[]; allocations: any[]; physical: any[];
  batches: any[]; lines: any[]; cartons: any[]; kind: 'legacy' | 'physical' | 'claim';
  fingerprint: string; allocationFingerprint: string; cartonCoverageComplete: boolean;
};
export interface ShipmentDocumentSourceOptions {
  trustedActor: TokenPayload | null;
  expectedSourceFingerprint?: string;
  extraScopes?: readonly PermissionScope[];
}

async function loadFacts(tx: any, shipmentId: string, actor: TokenPayload): Promise<ShipmentDocumentSource> {
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment || shipment.deletedAt != null) invisible();
  if (shipment.status === 'Cancelled') conflict('原运单已取消，不能重新制单。');
  const [allocations, physical, lines, cartons, claims, repairs]: any[][] = await Promise.all([
    tx.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } }),
    tx.shipmentProductionAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } }),
    tx.shipmentLine.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } }),
    tx.shipmentCarton.findMany({ where: { shipmentId }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    tx.claimDisposition.findMany({ where: { replacementShipmentId: shipmentId }, select: { id: true }, orderBy: { id: 'asc' } }),
    tx.repairWorkOrder.findMany({ where: { reshipmentId: shipmentId }, select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  const lineIds = ids([...lines, ...allocations, ...physical].map(row => row.orderLineId));
  const originalLines: any[] = lineIds.length ? await tx.orderLine.findMany({ where: { id: { in: lineIds } }, orderBy: { id: 'asc' } }) : [];
  if (originalLines.length !== lineIds.length) conflict('原装运订单行已丢失，请核对来源。');
  const orderIds = ids([shipment.orderId, ...allocations.map(row => row.orderId), ...physical.map(row => row.orderId), ...originalLines.map(row => row.orderId)]);
  if (orderIds.length && !hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有原订单读取权限。');
  const orders = await authorizedDocumentOrders(tx, actor, orderIds);
  const batches: any[] = orderIds.length ? await tx.productionBatch.findMany({ where: { orderId: { in: orderIds } }, orderBy: { id: 'asc' } }) : [];
  const kind: ShipmentDocumentSource['kind'] = claims.length || repairs.length ? 'claim' : batches.length || physical.length ? 'physical' : 'legacy';
  const originals = new Map<string, any>(originalLines.map(row => [row.id, row]));
  const actual = new Map<string, Prisma.Decimal>();
  for (const allocation of allocations) {
    if (allocation.shipmentId !== shipmentId || !orderIds.includes(allocation.orderId)) conflict('订单分配归属无效。');
    const ol = allocation.orderLineId ? originals.get(allocation.orderLineId) : null;
    if (allocation.orderLineId && (!ol || ol.orderId !== allocation.orderId)) conflict('订单分配行归属已变化。');
    if (allocation.status === 'Cancelled') continue;
    const quantity = documentDecimal(allocation.actualQty);
    if (quantity !== null && new Prisma.Decimal(quantity).lt(0)) conflict('实际分配数量不能为负。');
    if (ol && quantity !== null) actual.set(ol.id, (actual.get(ol.id) ?? new Prisma.Decimal(0)).plus(quantity));
    if (kind === 'physical' && (!ol || !physical.some(row => row.allocationId === allocation.id))) conflict('物理订单分配缺少准确批次来源。');
  }
  for (const projection of physical) {
    const allocation = allocations.find(row => row.id === projection.allocationId), batch = batches.find(row => row.id === projection.productionBatchId);
    if (!allocation || projection.shipmentId !== shipmentId || projection.orderId !== allocation.orderId || projection.orderLineId !== allocation.orderLineId
      || projection.unit !== allocation.unit || !batch || batch.deletedAt != null || batch.orderId !== projection.orderId || batch.orderLineId !== projection.orderLineId
      || batch.revision !== projection.productionBatchRevision || batch.unit !== projection.unit) conflict('物理批次、订单行与原分配身份不一致。');
    if (allocation.status === 'Cancelled') {
      if (projection.state !== 'released' && projection.state !== 'reversed') conflict('已取消分配仍占用物理来源。');
      continue;
    }
    if (projection.state !== (isShipmentShipped(shipment.status) ? 'shipped' : 'reserved')) conflict('原物理分配状态已变化。');
    const receiptRows = readPhysicalReceiptAllocations(projection);
    for (const row of receiptRows.filter(row => row.factoryLoadingReceiptId)) {
      const fact = await verifyFactoryLoadingReceiptInTx(tx, row.factoryLoadingReceiptId!, batch, row.expectedScopeFingerprint,
        { shipmentId, allocationId: allocation.id });
      const frozen = projection.scopeSnapshot.receiptAllocations.find((item: any) => item.factoryLoadingReceiptId === row.factoryLoadingReceiptId);
      if (Object.entries(fact.identity).some(([key, value]) => frozen?.[key] !== value)
        || row.actualQty === null || new Prisma.Decimal(row.actualQty).gt(fact.receipt.quantity)) conflict('工厂实装凭据或数量与原单据来源不一致。');
    }
    const receiptKnown = receiptRows.every(row => row.actualQty != null);
    const quantity = documentDecimal(projection.actualQty);
    if ((quantity !== null) !== receiptKnown || receiptKnown && !new Prisma.Decimal(quantity!).equals(receiptRows.reduce((sum, row) => sum.plus(row.actualQty!), new Prisma.Decimal(0)))) conflict('物理实际数量与原入库分配明细不一致。');
    if (quantity !== null && new Prisma.Decimal(quantity).lt(0)) conflict('物理实际数量不能为负。');
  }
  for (const allocation of allocations.filter(row => row.status !== 'Cancelled' && kind === 'physical')) {
    const projections = physical.filter(row => row.allocationId === allocation.id), known = projections.every(row => row.actualQty != null);
    const amount = documentDecimal(allocation.actualQty);
    if ((amount !== null) !== known || known && !new Prisma.Decimal(amount!).equals(projections.reduce((sum, row) => sum.plus(documentDecimal(row.actualQty)!), new Prisma.Decimal(0))))
      conflict('物理实际数量与订单行分配不一致。');
  }
  const shippedByLine = new Map<string, Prisma.Decimal>();
  const exactLines = lines.map(sl => {
    if (sl.shipmentId !== shipmentId) conflict('装运行所属运单已变化。');
    const ol = sl.orderLineId ? originals.get(sl.orderLineId) : null;
    if (kind === 'physical' && !ol) conflict('物理装运行缺少稳定原订单行标识。');
    const quantity = documentDecimal(sl.quantity), unit = sl.unit ?? null;
    if (quantity !== null && new Prisma.Decimal(quantity).lt(0)) conflict('装运行数量不能为负。');
    if (ol && quantity !== null) {
      if (ol.unit && unit !== ol.unit) conflict('装运行与原订单行单位不一致。');
      shippedByLine.set(ol.id, (shippedByLine.get(ol.id) ?? new Prisma.Decimal(0)).plus(quantity));
    }
    const price = documentDecimal(ol?.unitPrice), amount = quantity !== null && price !== null
      ? new Prisma.Decimal(quantity).mul(price).toDecimalPlaces(4).toString() : null;
    // Shipment quantities are independent from whole OrderLine.netValue.
    return { ...documentSourceJson(sl), orderId: ol?.orderId ?? null, originalOrderLine: ol ? documentSourceJson(ol) : null,
      productionBatchIds: ids(physical.filter(row => row.orderLineId === ol?.id && allocations.some(a => a.id === row.allocationId && a.status !== 'Cancelled')).map(row => row.productionBatchId)),
      quantity, unit, unitPrice: price, amount };
  });
  for (const [lineId, quantity] of shippedByLine) if (kind === 'physical' && (!actual.has(lineId) || quantity.gt(actual.get(lineId)!))) conflict('装运行超过真实本票实际分配。');
  const byLine = new Map<string, any>(exactLines.map(row => [row.id, row])), packed = new Map<string, Prisma.Decimal>();
  const exactCartons = cartons.map(carton => ({ ...documentSourceJson(carton), items: carton.items.map((item: any) => {
    const line = byLine.get(item.shipmentLineId), quantity = documentDecimal(item.quantity);
    if (item.cartonId !== carton.id || !line || quantity === null || !new Prisma.Decimal(quantity).gt(0)) conflict('箱内原装运行关联或数量无效。');
    packed.set(line.id, (packed.get(line.id) ?? new Prisma.Decimal(0)).plus(quantity));
    return { ...documentSourceJson(item), orderId: line.orderId, orderLineId: line.orderLineId ?? null, quantity, unit: line.unit };
  }) }));
  for (const [lineId, quantity] of packed) if (byLine.get(lineId).quantity === null || quantity.gt(byLine.get(lineId).quantity)) conflict('箱内累计数量超过原装运行。');
  const cartonCoverageComplete = exactLines.length > 0 && exactLines.every(row => row.quantity !== null && (packed.get(row.id) ?? new Prisma.Decimal(0)).equals(row.quantity));
  const facts = { shipment: documentSourceJson(shipment), orders: documentSourceJson(orders), orderIds, allocations: documentSourceJson(allocations),
    physical: documentSourceJson(physical), batches: documentSourceJson(batches), lines: exactLines, cartons: exactCartons, kind,
    cartonCoverageComplete, claims: documentSourceJson(claims), repairs: documentSourceJson(repairs) };
  return { ...facts, fingerprint: documentSourceFingerprint(facts), allocationFingerprint: physicalShipmentAllocationFingerprint({ shipment, allocations, physical, orderIds }) };
}
export async function shipmentDocumentSourceInTx(tx: any, shipmentId: string, options: ShipmentDocumentSourceOptions): Promise<ShipmentDocumentSource> {
  const scopes: PermissionScope[] = ['shipments:read', ...(options.extraScopes ?? [])];
  const actor = await currentDocumentActor(tx, options.trustedActor, scopes), source = await loadFacts(tx, shipmentId, actor);
  if (options.expectedSourceFingerprint !== undefined && source.fingerprint !== options.expectedSourceFingerprint) conflict('原运单制单来源已变化，请重新核对。');
  const finalScopes: PermissionScope[] = [...scopes, ...(source.orderIds.length ? ['orders:read' as const] : [])];
  const finalActor = await currentDocumentActor(tx, options.trustedActor, finalScopes);
  await authorizedDocumentOrders(tx, finalActor, source.orderIds);
  await currentDocumentActor(tx, options.trustedActor, finalScopes);
  return source;
}
export async function readShipmentDocumentSource(prisma: PrismaClient, shipmentId: string, options: ShipmentDocumentSourceOptions): Promise<ShipmentDocumentSource> {
  return prisma.$transaction(tx => shipmentDocumentSourceInTx(tx, shipmentId, options), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Pure source locks in the canonical native order. No capability is borrowed
 * from an invoice writer, and no authoritative fact is written. */
export async function lockShipmentDocumentSourcesInTx(tx: any, shipmentIds: string[], options: ShipmentDocumentSourceOptions,
  additionalOrderIds: string[] = []): Promise<ShipmentDocumentSource[]> {
  const before = await Promise.all(ids(shipmentIds).map(id => shipmentDocumentSourceInTx(tx, id, options)));
  const orders = ids([...additionalOrderIds, ...before.flatMap(source => source.orderIds)]);
  const actor = await currentDocumentActor(tx, options.trustedActor, [...(orders.length ? ['orders:read' as const] : []), ...(options.extraScopes ?? [])]);
  await authorizedDocumentOrders(tx, actor, orders);
  const evidence = orders.length ? await tx.sample.findMany({ where: { sourceOrderId: { in: orders }, type: 'ship', deletedAt: null }, select: { id: true } }) : [];
  await lockReleaseSources(tx, orders, { evidenceSampleIds: evidence.map((row: any) => row.id) });
  const nowEvidence = orders.length ? await tx.sample.findMany({ where: { sourceOrderId: { in: orders }, type: 'ship', deletedAt: null }, select: { id: true } }) : [];
  if (documentSourceFingerprint(ids(evidence.map((row: any) => row.id))) !== documentSourceFingerprint(ids(nowEvidence.map((row: any) => row.id)))) conflict('船样来源在取得锁时变化。');
  const lock = async (table: string, rowIds: string[]) => {
    const sorted = ids(rowIds);
    if (sorted.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + table + '"')} WHERE "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`);
  };
  await lock('ProductionBatch', before.flatMap(source => source.batches.map(row => row.id)));
  await lock('Shipment', ids(shipmentIds));
  await lock('ShipmentOrderAllocation', before.flatMap(source => source.allocations.map(row => row.id)));
  await lock('ShipmentProductionAllocation', before.flatMap(source => source.physical.map(row => row.id)));
  await lock('ShipmentLine', before.flatMap(source => source.lines.map(row => row.id)));
  await lock('ShipmentCarton', before.flatMap(source => source.cartons.map(row => row.id)));
  await lock('ShipmentCartonItem', before.flatMap(source => source.cartons.flatMap(row => row.items.map((item: any) => item.id))));
  const after = await Promise.all(ids(shipmentIds).map(id => shipmentDocumentSourceInTx(tx, id, options)));
  if (before.some((source, index) => source.fingerprint !== after[index].fingerprint)) conflict('运单、原分配或箱内关联在取得锁时变化。');
  return after;
}
