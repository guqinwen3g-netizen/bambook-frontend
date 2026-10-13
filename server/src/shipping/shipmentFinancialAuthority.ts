import { Prisma } from '@prisma/client';
import { currentShipmentFinancialActor, visibleFinancialOrder } from './shipmentFinancialActor';
export { currentShipmentFinancialActor, visibleFinancialOrder } from './shipmentFinancialActor';
import type { TokenPayload } from '../auth/service';
import { isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { isShipmentShipped } from '../shared/shippingLock';
import { lockReleaseSources } from '../production/releaseService';
import { lockShipmentPhysicalConsumer, type ShipmentPhysicalContext } from './shipmentPhysicalConsumerService';
import { originalPhysicalShipmentDispatch, physicalShipmentJson } from './shipmentPhysicalCommand';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { writeRouteAuditLog } from '../audit/routeAudit';

export async function lockFinancialBatchRows(tx: any, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderShipmentBatch"
    WHERE "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`);
}
/** A source set is acquired before any financial Batch or Invoice lock. The
 * same native source/Order/Line/Batch/Shipment sequence is used by cancellation.
 * No shipment capability is borrowed by a Finance actor. */
export async function lockFinancialShipmentSources(tx: any, params: {
  orderIds: string[]; shipmentIds: string[]; actor: TokenPayload; action: 'write' | 'invoice';
}): Promise<Map<string, ShipmentPhysicalContext>> {
  const shipments = [...new Set(params.shipmentIds)].sort();
  const hints = shipments.length ? await tx.shipmentOrderAllocation.findMany({ where: { shipmentId: { in: shipments } }, orderBy: { id: 'asc' } }) : [];
  const headers = shipments.length ? await tx.shipment.findMany({ where: { id: { in: shipments }, deletedAt: null } }) : [];
  if (headers.length !== shipments.length) throw businessError('NOT_FOUND', '原运单不存在或不可查看。');
  const orders = [...new Set<string>([...params.orderIds, ...hints.map((row: any) => row.orderId), ...headers.map((row: any) => row.orderId)].filter(Boolean))].sort();
  const initialActor = await currentShipmentFinancialActor(tx, params.actor, params.action);
  for (const orderId of orders) await visibleFinancialOrder(tx, orderId, initialActor);
  const evidence = orders.length ? await tx.sample.findMany({ where: { sourceOrderId: { in: orders }, type: 'ship', deletedAt: null }, select: { id: true } }) : [];
  await lockReleaseSources(tx, orders, { evidenceSampleIds: evidence.map((row: any) => row.id) });
  const currentEvidence = orders.length ? await tx.sample.findMany({ where: { sourceOrderId: { in: orders }, type: 'ship', deletedAt: null }, select: { id: true } }) : [];
  if (qcReportSourceFingerprint(evidence.map((row: any) => row.id).sort()) !== qcReportSourceFingerprint(currentEvidence.map((row: any) => row.id).sort()))
    throw businessError('CONFLICT', '船样来源集合在取得锁时变化，请刷新重试。');
  const contexts = new Map<string, ShipmentPhysicalContext>();
  for (const shipmentId of shipments) {
    const context = await lockShipmentPhysicalConsumer(tx, { shipmentId, actor: params.actor, mode: 'edit',
      ...(params.action === 'invoice' ? { authority: 'invoice' as const } : {}) });
    if (context.kind === 'claim') throw businessError('CONFLICT', '售后补发须按原案件结算，不能改绑为销售订单出运批次。');
    if (context.orderIds.some(orderId => !orders.includes(orderId))) throw businessError('CONFLICT', '运单来源在取得锁时变化，请读取原记录后重试。');
    contexts.set(shipmentId, context);
  }
  const actor = await currentShipmentFinancialActor(tx, params.actor, params.action);
  for (const orderId of orders) await visibleFinancialOrder(tx, orderId, actor);
  return contexts;
}
export async function verifyFinancialShipmentSource(tx: any, context: ShipmentPhysicalContext, orderId: string) {
  if (!isShipmentShipped(context.shipment.status)) throw businessError('CONFLICT', '原运单尚未实际发运，或已取消，不能确认本批已出运。');
  const allocations = context.allocations.filter((row: any) => row.orderId === orderId && row.status !== 'Cancelled');
  if (!allocations.length || !allocations.some((row: any) => row.actualQty != null && new Prisma.Decimal(row.actualQty).gt(0)))
    throw businessError('CONFLICT', '原运单没有本订单明确的正实际出运数量。');
  if (context.kind !== 'physical') return null;
  const dispatch = await originalPhysicalShipmentDispatch(tx, context);
  const rows = dispatch.stockMovements.filter((row: any) => row.orderId === orderId);
  if (!rows.length || rows.some((row: any) => typeof row.quantity !== 'string' || !new Prisma.Decimal(row.quantity).gt(0)))
    throw businessError('CONFLICT', '原出库回执没有本订单完整实际货物来源。');
  const movements = await tx.stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: context.shipment.id,
    type: { in: ['Outbound', 'Inbound'] } }, orderBy: { id: 'asc' } });
  if (movements.length !== dispatch.stockMovements.length || dispatch.stockMovements.some((row: any) =>
    !movements.some((movement: any) => qcReportSourceFingerprint(physicalShipmentJson(movement)) === qcReportSourceFingerprint(row.movement))))
    throw businessError('CONFLICT', '原出库流水集合已变化或已回冲，不能继续作为出运结算来源。');
  return dispatch;
}
/** Current eligibility is revoked append-only. Historical financial batches,
 * original invoices and settlements are retained verbatim. */
export async function invalidateFinancialShipmentSourceInTx(tx: any, shipmentId: string, actorId: string, commandHash: string) {
  const hints = await tx.orderShipmentBatch.findMany({ where: { shipmentId, deletedAt: null }, orderBy: { id: 'asc' } });
  await lockFinancialBatchRows(tx, hints.map((row: any) => row.id));
  const current = await tx.orderShipmentBatch.findMany({ where: { shipmentId, deletedAt: null }, orderBy: { id: 'asc' } });
  if (qcReportSourceFingerprint(hints.map((row: any) => [row.id, row.orderId])) !== qcReportSourceFingerprint(current.map((row: any) => [row.id, row.orderId])))
    throw businessError('CONFLICT', '关联结算批次在取消时变化，请重试原请求。');
  for (const batch of current) await writeRouteAuditLog({ prisma: tx, actorId,
    source: 'service:shipping:financial-source', operation: 'invalidate_financial_shipment_source', targetType: 'OrderShipmentBatch', targetId: batch.id,
    operationType: 'transition', before: { shipmentId, status: batch.status },
    after: { shipmentId, status: batch.status, financialSourceEligible: false, cause: 'shipment_cancelled', commandHash } });
}
export function financialFailure(error: any, fallback: string) {
  const classified = isOrderLineStorageConflict(error)
    ? businessError('CONFLICT', '来源正在由另一操作处理，请保留原请求重试。') : error;
  const safe = safeRouteError(classified, { fallbackCode: fallback,
    fallbackMessage: fallback === 'LIST_FAILED'
      ? '出运批次列表暂时无法读取，请刷新后重试。'
      : '出运结算操作未能确认，请核对原请求后重试。' });
  return { ok: false as const, error: { code: safe.code, message: safe.message, status: safe.status,
    ...(safe.details === undefined ? {} : { details: safe.details }) } };
}

/** Native invoice consumers invoke this before taking Invoice/IOA locks.
 * Planned pre-invoicing remains legal; a cancelled actual source never does. */
export async function lockInvoiceFinancialSources(tx: any, allocations: Array<{ orderId: string; batchId?: string | null }>, prior: TokenPayload) {
  const batchIds = [...new Set<string>(allocations.map(row => row.batchId).filter((id): id is string => !!id))].sort();
  const hints = batchIds.length ? await tx.orderShipmentBatch.findMany({ where: { id: { in: batchIds } }, orderBy: { id: 'asc' } }) : [];
  const contexts = await lockFinancialShipmentSources(tx, { orderIds: allocations.map(row => row.orderId),
    shipmentIds: hints.map((row: any) => row.shipmentId).filter(Boolean), actor: prior, action: 'invoice' });
  await lockFinancialBatchRows(tx, batchIds);
  const rows = batchIds.length ? await tx.orderShipmentBatch.findMany({ where: { id: { in: batchIds } }, orderBy: { id: 'asc' } }) : [];
  if (qcReportSourceFingerprint(hints.map((row: any) => [row.id, row.orderId, row.shipmentId, row.deletedAt])) !==
    qcReportSourceFingerprint(rows.map((row: any) => [row.id, row.orderId, row.shipmentId, row.deletedAt])))
    throw businessError('CONFLICT', '结算批次开票来源在取得锁时变化，请刷新重试。');
  for (const batch of rows) {
    if (batch.deletedAt != null || batch.status === 'cancelled') continue; // Existing parser retains its original 400 contract.
    if (batch.shipmentId) {
      const context = contexts.get(batch.shipmentId);
      if (!context || context.shipment.status === 'Cancelled') throw businessError('CONFLICT', '原出运已取消，本批不能继续新增或改绑发票。');
      if (!context.orderIds.includes(batch.orderId)) throw businessError('CONFLICT', '本批原出运没有对应订单来源。');
      if (batch.status === 'shipped') await verifyFinancialShipmentSource(tx, context, batch.orderId);
    }
  }
  const actor = await currentShipmentFinancialActor(tx, prior, 'invoice');
  for (const orderId of [...new Set(allocations.map(row => row.orderId))].sort()) await visibleFinancialOrder(tx, orderId, actor);
  return { actor, contexts, batches: rows };
}
