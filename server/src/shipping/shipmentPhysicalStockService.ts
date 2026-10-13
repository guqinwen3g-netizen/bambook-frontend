import { Prisma } from '@prisma/client';
import { createInventoryService } from '../inventory/inventoryService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { businessError } from '../shared/errorCodes';
import { todayLocalKey } from '../shared/localDate';
import { serializeSettlementValue } from '../lib/serializeSettlementValue';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { assertPhysicalShipmentWriteAuthority, verifyOriginalProductionReceipt } from './shipmentPhysicalAllocationService';
import { validateReservedPhysicalShipment, type ShipmentPhysicalContext, type VerifiedPhysicalShipment } from './shipmentPhysicalConsumerService';
import { verifyFactoryLoadingReceiptInTx, type FactoryLoadingReceiptIdentity } from './factoryLoadingReceiptService';

export interface PhysicalShipmentStockMovement {
  physicalAllocationId: string;
  allocationId: string;
  orderId: string;
  orderLineId: string;
  productionBatchId: string;
  productionBatchRevision: string;
  stockReceiptId: string;
  inventoryItemId: string;
  warehouseId: string;
  inboundStockMovementId: string;
  receivedQuantity: string;
  receiptScopeFingerprint: string;
  receiptCommandHash: string;
  unit: string;
  quantity: string;
  /** Full native row, including exact balances/cost and string BigInt fields.
   * Internal server proof; a public DTO must respect cost-read permissions. */
  movement: Record<string, unknown>;
}
export interface PhysicalShipmentStockReversal extends PhysicalShipmentStockMovement {
  originalOutboundId: string;
}
export interface PhysicalShipmentFactoryLoading extends FactoryLoadingReceiptIdentity {
  physicalAllocationId: string; allocationId: string; orderId: string; orderLineId: string; productionBatchId: string; quantity: string;
}
export interface PhysicalShipmentShipProof { stockMovements: PhysicalShipmentStockMovement[]; factoryLoadings?: PhysicalShipmentFactoryLoading[] }

const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const same = (left: unknown, right: unknown) => qcReportSourceFingerprint(serializeSettlementValue(left)) === qcReportSourceFingerprint(serializeSettlementValue(right));
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return conflict('原实物库存证明缺少准确身份，请核对原记录。');
  return value;
}
function decimal(value: unknown, positive = false): Prisma.Decimal {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value)) return conflict('原实物数量无法精确核验，请核对原记录。');
  const amount = new Prisma.Decimal(value);
  if (!amount.isFinite() || (positive && amount.lte(0))) return conflict('实际出运数量必须为明确的正数，不能使用计划或零数量。');
  return amount;
}
const ordered = (rows: any[]) => [...rows].sort((a, b) => JSON.stringify([a.stockReceiptId, a.physicalAllocationId, a.allocationId])
  .localeCompare(JSON.stringify([b.stockReceiptId, b.physicalAllocationId, b.allocationId])));
function identity(row: any): Omit<PhysicalShipmentStockMovement, 'quantity' | 'movement'> {
  if (!Number.isSafeInteger(row.productionBatchRevision) || row.productionBatchRevision < 0) return conflict('原收货修订无法核验。');
  decimal(id(row.receivedQuantity), true);
  for (const key of ['receiptScopeFingerprint', 'receiptCommandHash']) {
    if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key])) return conflict('原收货依据不完整，请核对原记录。');
  }
  return { physicalAllocationId: id(row.physicalAllocationId), allocationId: id(row.allocationId), orderId: id(row.orderId),
    orderLineId: id(row.orderLineId), productionBatchId: id(row.productionBatchId), productionBatchRevision: String(row.productionBatchRevision),
    stockReceiptId: id(row.stockReceiptId), inventoryItemId: id(row.inventoryItemId), warehouseId: id(row.warehouseId),
    inboundStockMovementId: id(row.stockMovementId), receivedQuantity: row.receivedQuantity,
    receiptScopeFingerprint: row.receiptScopeFingerprint, receiptCommandHash: row.receiptCommandHash, unit: id(row.unit) };
}
async function lockRows(tx: any, table: 'ProductionStockReceipt' | 'FactoryLoadingReceipt' | 'Warehouse' | 'InventoryItem', values: string[]) {
  const ids = [...new Set(values.map(id))].sort();
  if (!ids.length) return conflict('本票没有可执行的准确库存身份。');
  const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + table + '"')}
    WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`);
  if (rows.length !== ids.length || ids.some(value => !rows.some((row: any) => row.id === value))) return conflict('原收货、仓库或库存已不存在，请核对原记录。');
}
async function lockStock(tx: any, rows: Array<Pick<PhysicalShipmentStockMovement, 'stockReceiptId' | 'warehouseId' | 'inventoryItemId'>>) {
  // Source -> Orders/Lines/Batch -> Shipment/SOA/SPA are already held by the
  // consumer. Never reacquire source parents after these later stock locks.
  await lockRows(tx, 'ProductionStockReceipt', rows.map(row => row.stockReceiptId));
  await lockRows(tx, 'Warehouse', rows.map(row => row.warehouseId));
  await lockRows(tx, 'InventoryItem', rows.map(row => row.inventoryItemId));
}
async function authority(tx: any, context: ShipmentPhysicalContext, actorId: string, rows: Array<{ orderId: string }>) {
  if (context.kind !== 'physical' || !context.actor?.userId || context.actor.userId !== actorId) {
    throw businessError('FORBIDDEN', '当前执行主体与原实物出运请求不一致。');
  }
  const actor = await assertPhysicalShipmentWriteAuthority(tx, context.actor);
  if (actor.userId !== actorId) throw businessError('FORBIDDEN', '当前执行主体与原实物出运请求不一致。');
  const scope = await freshOrderLineScope(tx, actor);
  for (const orderId of [...new Set([...context.orderIds, ...rows.map(row => row.orderId)])].sort()) {
    if (!context.orderIds.includes(orderId)) return conflict('原出库证明的来源订单与本票不一致。');
    let order;
    try { order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] }, select: { id: true } }); }
    catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验原实物出运的订单范围。'); }
    if (!order) throw businessError('ORDER_NOT_FOUND', '原实物出运来源订单不存在或不可查看。');
  }
}
async function shipmentMovements(tx: any, shipmentId: string) {
  return tx.stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: shipmentId,
    type: { in: ['Outbound', 'Inbound'] } }, orderBy: { id: 'asc' } });
}
function assertUniqueRows(rows: Array<{ physicalAllocationId: string; stockReceiptId: string }>) {
  const identities = rows.map(row => JSON.stringify([row.physicalAllocationId, row.stockReceiptId]));
  if (!rows.length || new Set(identities).size !== rows.length) return conflict('本票原收货分配身份缺失或重复，请核对原记录。');
}
/** Direct loading is a physical source, never a warehouse stock movement. */
export function physicalShipmentFactoryLoadings(verified: VerifiedPhysicalShipment): PhysicalShipmentFactoryLoading[] {
  return verified.rows.filter(row => row.factoryLoadingReceiptId).map(row => ({
    sourceKind: 'factory_direct' as const, factoryLoadingReceiptId: id(row.factoryLoadingReceiptId),
    physicalAllocationId: id(row.physicalAllocationId), allocationId: id(row.allocationId), orderId: id(row.orderId), orderLineId: id(row.orderLineId),
    productionBatchId: id(row.productionBatchId), productionBatchRevision: row.productionBatchRevision, factoryRelationId: id(row.factoryRelationId),
    handoffId: id(row.handoffId), shipmentId: id(row.shipmentId), loadedQuantity: decimal(row.loadedQuantity).toString(), unit: id(row.unit),
    loadingScopeFingerprint: id(row.loadingScopeFingerprint), loadingCommandHash: id(row.loadingCommandHash), quantity: decimal(row.actualQty, true).toString(),
  })).sort((a, b) => a.factoryLoadingReceiptId.localeCompare(b.factoryLoadingReceiptId));
}

export async function validateHistoricalFactoryLoadings(tx: any, context: ShipmentPhysicalContext, proof: PhysicalShipmentFactoryLoading[]): Promise<void> {
  const expected = context.physical.flatMap((projection: any) => (projection.scopeSnapshot?.receiptAllocations ?? [])
    .filter((row: any) => row.factoryLoadingReceiptId && row.actualQty != null && new Prisma.Decimal(row.actualQty).gt(0))
    .map((row: any) => ({ sourceKind: 'factory_direct', factoryLoadingReceiptId: row.factoryLoadingReceiptId,
      physicalAllocationId: projection.id, allocationId: projection.allocationId, orderId: projection.orderId, orderLineId: projection.orderLineId,
      productionBatchId: projection.productionBatchId, productionBatchRevision: projection.productionBatchRevision,
      factoryRelationId: row.factoryRelationId, handoffId: row.handoffId, shipmentId: row.shipmentId, loadedQuantity: row.loadedQuantity,
      unit: row.unit, loadingScopeFingerprint: row.loadingScopeFingerprint, loadingCommandHash: row.loadingCommandHash, quantity: row.actualQty })))
    .sort((a: any, b: any) => a.factoryLoadingReceiptId.localeCompare(b.factoryLoadingReceiptId));
  if (!Array.isArray(proof) || !same(expected, [...proof].sort((a, b) => a.factoryLoadingReceiptId.localeCompare(b.factoryLoadingReceiptId))))
    return conflict('原工厂直出凭据集合与原实际发运分配不一致。');
  if (proof.length) await lockRows(tx, 'FactoryLoadingReceipt', proof.map(row => row.factoryLoadingReceiptId));
  for (const row of proof) {
    const historical = { id: row.productionBatchId, orderId: row.orderId, orderLineId: row.orderLineId,
      revision: row.productionBatchRevision, factoryRelationId: row.factoryRelationId, unit: row.unit };
    const fact = await verifyFactoryLoadingReceiptInTx(tx, row.factoryLoadingReceiptId, historical, row.loadingScopeFingerprint,
      { shipmentId: context.shipment.id, allocationId: row.allocationId, handoffId: row.handoffId });
    if (Object.entries(fact.identity).some(([key, value]) => row[key as keyof PhysicalShipmentFactoryLoading] !== value)
      || decimal(row.quantity, true).gt(fact.receipt.quantity)) return conflict('原工厂直出核验事实或数量已变化。');
  }
}
function assertMovement(movement: any, source: Omit<PhysicalShipmentStockMovement, 'movement'>, shipmentId: string, type: 'Outbound' | 'Inbound', actorId?: string) {
  if (!movement || !movement.id || movement.type !== type || movement.itemId !== source.inventoryItemId
    || movement.warehouseId !== source.warehouseId || movement.unit !== source.unit
    || movement.referenceType !== 'Shipment' || movement.referenceId !== shipmentId
    || actorId !== undefined && movement.operator !== actorId
    || !decimal(String(movement.quantity), true).equals(decimal(source.quantity, true))) return conflict('实际库存流水与原实物分配不一致。');
  const before = decimal(String(movement.balanceBefore)), after = decimal(String(movement.balanceAfter));
  const expected = type === 'Outbound' ? before.minus(source.quantity) : before.plus(source.quantity);
  if (!expected.equals(after)) return conflict('原库存流水的准确余额变化不一致。');
}

/** New execution only. Immutable Shipping command replay belongs to the caller;
 * any existing ledger row is a conflict, never evidence of idempotency here.
 * Errors escape the external tx so movement/CAS/audits all roll back together. */
export async function deductPhysicalShipmentStockInTx(tx: any, prisma: any, verified: VerifiedPhysicalShipment, actorId: string): Promise<PhysicalShipmentStockMovement[]> {
  const context = verified.context, shipmentId = id(context.shipment.id);
  const factoryLoadings = physicalShipmentFactoryLoadings(verified);
  const hinted = ordered(verified.rows.filter(row => !row.factoryLoadingReceiptId)).map(row => ({ ...identity(row), quantity: decimal(row.actualQty, true).toString() }));
  if (factoryLoadings.length) await lockRows(tx, 'FactoryLoadingReceipt', factoryLoadings.map(row => row.factoryLoadingReceiptId));
  if (hinted.length) { assertUniqueRows(hinted); await lockStock(tx, hinted); }
  if (!hinted.length && !factoryLoadings.length) return conflict('本票没有经过核实的实际货物。');
  await authority(tx, context, actorId, [...hinted, ...factoryLoadings]);
  const current = await validateReservedPhysicalShipment(tx, context, true);
  const rows = ordered(current.rows.filter(row => !row.factoryLoadingReceiptId));
  const now = rows.map(row => ({ ...identity(row), quantity: decimal(row.actualQty, true).toString() }));
  if (!same(hinted, now) || !same(factoryLoadings, physicalShipmentFactoryLoadings(current))) return conflict('原实物分配在取得来源锁时变化，请核对原请求。');
  if ((await shipmentMovements(tx, shipmentId)).length) return conflict('本票已有出入库历史，请先核对原出运回执，不能另做一次库存执行。');
  const totals = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const batch = context.batches.find(value => value.id === row.productionBatchId);
    if (!batch) return conflict('本票实际生产批次来源缺失。');
    const receipt = await verifyOriginalProductionReceipt(tx, row.stockReceiptId, batch, row.receiptScopeFingerprint);
    if (!same(identity({ ...row, ...receipt.identity }), identity(row))) return conflict('原收货库存身份在取得锁时变化。');
    const total = (totals.get(row.stockReceiptId) ?? new Prisma.Decimal(0)).plus(decimal(row.actualQty, true));
    if (total.gt(receipt.available) || total.gt(decimal(receipt.identity.receivedQuantity, true))) return conflict('原收货库存可用数量不足或本票超过原实收数量。');
    totals.set(row.stockReceiptId, total);
  }
  const inventory = createInventoryService(prisma), movements: PhysicalShipmentStockMovement[] = [];
  for (const row of now) {
    // quantity is an unused legacy-number adapter slot. The exact native branch
    // consumes ONLY opts.exactQuantity, never this zero or a Number conversion.
    const movement = await inventory.createStockMovement({ itemId: row.inventoryItemId, type: 'Outbound', quantity: 0,
      unit: row.unit, referenceType: 'Shipment', referenceId: shipmentId, movementDate: todayLocalKey(),
      reason: '实际批次出运扣减' }, actorId, { tx, exactQuantity: decimal(row.quantity, true) });
    assertMovement(movement, row, shipmentId, 'Outbound', actorId);
    movements.push({ ...row, movement: serializeSettlementValue(movement) });
  }
  const actual = await shipmentMovements(tx, shipmentId);
  if (actual.length !== movements.length || movements.some(row => !actual.some((movement: any) => same(movement, row.movement)))) return conflict('本票出库流水集合与本次实际执行不一致。');
  await writeRouteAuditLog({ prisma: tx, actorId, source: 'service:shipping:physical-stock', operation: 'deduct_physical_shipment_stock',
    targetType: 'Shipment', targetId: shipmentId, operationType: 'decrement', after: { schemaVersion: 1, shipmentId, stockMovements: movements, factoryLoadings } });
  return movements;
}

/** Cancellation consumes frozen historical movements, not current Batch/QC
 * eligibility. Root must first verify the immutable ship-command receipt.
 * Only the caller may replay an already committed cancellation ACK. */
export async function reversePhysicalShipmentStockInTx(tx: any, prisma: any, context: ShipmentPhysicalContext,
  originalShipProof: PhysicalShipmentShipProof, actorId: string): Promise<PhysicalShipmentStockReversal[]> {
  const shipmentId = id(context.shipment.id);
  if (!Array.isArray(originalShipProof?.stockMovements) || !originalShipProof.stockMovements.length && !originalShipProof.factoryLoadings?.length) return conflict('原出运缺少完整实际货物回执。');
  const factoryLoadings = originalShipProof.factoryLoadings ?? [];
  await validateHistoricalFactoryLoadings(tx, context, factoryLoadings);
  const rows = ordered(originalShipProof.stockMovements);
  if (rows.length) assertUniqueRows(rows);
  const outboundIds = rows.map(row => id(row.movement?.id));
  if (new Set(outboundIds).size !== rows.length) return conflict('原出库流水身份重复，请核对原记录。');
  for (const row of rows) {
    decimal(row.quantity, true);
    for (const key of ['physicalAllocationId', 'allocationId', 'orderId', 'orderLineId', 'productionBatchId', 'stockReceiptId', 'inventoryItemId', 'warehouseId', 'unit']) id(row[key]);
    assertMovement(row.movement, row, shipmentId, 'Outbound');
  }
  if (rows.length) await lockStock(tx, rows);
  await authority(tx, context, actorId, [...rows, ...factoryLoadings]);
  const actual = await shipmentMovements(tx, shipmentId);
  if (actual.length !== rows.length || actual.some((movement: any) => movement.type !== 'Outbound')
    || rows.some(row => !actual.some((movement: any) => same(movement, row.movement)))) return conflict('原出库流水集合不完整或本票已有未核清回冲，请核对原回执。');
  for (const row of rows) {
    const persisted = await tx.stockMovement.findUnique({ where: { id: row.movement.id } });
    if (!same(persisted, row.movement)) return conflict('原冻结出库流水已变化，请核对原记录。');
    const receipt = await tx.productionStockReceipt.findUnique({ where: { id: row.stockReceiptId } });
    if (!receipt || receipt.productionBatchId !== row.productionBatchId || receipt.orderId !== row.orderId || receipt.orderLineId !== row.orderLineId
      || String(receipt.productionBatchRevision) !== row.productionBatchRevision) return conflict('原出库对应的真实收货来源不一致。');
    // Deliberately use the immutable receipt's historical revision/scope. Do
    // not resolveCurrentProductionBatchFacts or qualify the current batch.
    const historical = { id: receipt.productionBatchId, orderId: receipt.orderId, orderLineId: receipt.orderLineId,
      revision: receipt.productionBatchRevision, unit: receipt.unit };
    const original = await verifyOriginalProductionReceipt(tx, receipt.id, historical, row.receiptScopeFingerprint);
    const recovered = identity({ ...row, ...original.identity, stockMovementId: original.identity.stockMovementId,
      productionBatchRevision: original.identity.productionBatchRevision });
    const { quantity: _quantity, movement: _movement, ...frozenIdentity } = row;
    if (!same(recovered, frozenIdentity)) return conflict('原出库的准确收货、仓库、库存或单位身份不一致。');
  }
  const inventory = createInventoryService(prisma), reversals: PhysicalShipmentStockReversal[] = [];
  for (const row of rows) {
    const originalOutboundId = id(row.movement.id);
    const movement = await inventory.createStockMovement({ itemId: row.inventoryItemId, type: 'Inbound', quantity: 0,
      unit: row.unit, referenceType: 'Shipment', referenceId: shipmentId, movementDate: todayLocalKey(),
      reason: '实际批次出运取消回冲' }, actorId, { tx, exactQuantity: decimal(row.quantity, true) });
    assertMovement(movement, row, shipmentId, 'Inbound', actorId);
    reversals.push({ ...row, movement: serializeSettlementValue(movement), originalOutboundId });
  }
  const after = await shipmentMovements(tx, shipmentId);
  if (after.length !== rows.length + reversals.length || [...rows, ...reversals].some(row => !after.some((movement: any) => same(movement, row.movement)))) return conflict('实际回冲流水集合与原出库不一致。');
  await writeRouteAuditLog({ prisma: tx, actorId, source: 'service:shipping:physical-stock', operation: 'reverse_physical_shipment_stock',
    targetType: 'Shipment', targetId: shipmentId, operationType: 'increment', after: { schemaVersion: 1, shipmentId,
      originalOutboundIds: outboundIds, stockMovements: reversals, factoryLoadings, releasedFactoryLoadingReceiptIds: factoryLoadings.map(row => row.factoryLoadingReceiptId) } });
  return reversals;
}
