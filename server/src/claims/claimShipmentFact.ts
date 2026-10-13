import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { canonicalClaimJson, claimRefusal } from './claimApprovalFact';
import { lockClaimReturnContext } from './claimReturnFulfillmentService';
import { lockClaimRepairContext, readClaimRepairReleaseFact } from './claimRepairFulfillmentService';
import { createInventoryService } from '../inventory/inventoryService';
import { convertLength } from '../lib/unitConversion';

export const CLAIM_STOCK_BOUND = 'CLAIM_SHIPMENT_STOCK_BOUND';
export const CLAIM_SHIPMENT_RELEASED = 'CLAIM_SHIPMENT_RELEASED';
export const claimShipmentDigest = (value: unknown) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');
const newAuditId = () => `alog_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Exact persisted domain links only. No notes, names or caller-provided claim IDs can select this gate. */
export async function lockClaimShipmentSource(tx: any, shipmentId: string) {
  const [replacements, repairs] = await Promise.all([
    tx.claimDisposition.findMany({ where: { replacementShipmentId: shipmentId } }),
    tx.repairWorkOrder.findMany({ where: { reshipmentId: shipmentId } }),
  ]);
  if (!replacements.length && !repairs.length) return null;
  if (replacements.length + repairs.length !== 1) claimRefusal('运单有多个售后来源，不能选其中一个批准事实放行');
  let context: any;
  if (repairs.length) context = { ...(await lockClaimRepairContext(tx, repairs[0].id)), shipmentKind: 'Repair' as const };
  else {
    const d = replacements[0];
    const lines = await tx.returnReceiptLine.findMany({ where: { claimDispositionId: d.id } });
    if (d.kind !== 'Replace' || lines.length !== 1) claimRefusal('补发运单缺少唯一准确换货处置和退货明细');
    context = { ...(await lockClaimReturnContext(tx, lines[0].id)), shipmentKind: 'Replace' as const };
  }
  if (context.shipmentKind === 'Repair' ? context.workOrder.reshipmentId !== shipmentId : context.disposition.replacementShipmentId !== shipmentId) claimRefusal('售后运单来源在取得锁前已变化');
  await tx.$queryRawUnsafe('SELECT id FROM "Shipment" WHERE id = $1 FOR UPDATE', shipmentId);
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment || shipment.deletedAt || shipment.orderId || shipment.customerRelationId !== (context.claimCase.customerRelationId ?? null)
      || shipment.customerName !== (context.claimCase.customerName ?? null)) claimRefusal('售后运单客户或来源不一致，不能计入普通销售订单发货');
  const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId } });
  if (allocations.length) claimRefusal('售后补发或返还不能伪造正常订单分配');
  return { ...context, shipment };
}

export async function assertClaimShipmentLines(tx: any, context: any) {
  const lines = await tx.shipmentLine.findMany({ where: { shipmentId: context.shipment.id } });
  if (lines.length !== 1 || lines[0].orderLineId || lines[0].productCode !== context.disposition.materialCode
      || lines[0].unit !== context.disposition.unit || lines[0].quantity == null
      || !new Prisma.Decimal(lines[0].quantity).equals(context.disposition.quantity)) claimRefusal('售后出运必须有完整等于批准SKU、数量和单位的真实装运行');
  return lines;
}

/** Transferred stock can only return to its actual source order customer. */
export async function readReplacementEntitlement(tx: any, item: any, claimCase: any) {
  if (item.ownership === 'Owned') return null;
  if (item.ownership !== 'Transferred' || !item.orderId || !claimCase.customerRelationId) claimRefusal('补发货权缺少准确客户来源锚，请先核对');
  const order = await tx.order.findUnique({ where: { id: item.orderId } });
  if (!order || order.deletedAt || !order.customerRelationId || order.customerRelationId !== claimCase.customerRelationId) claimRefusal('该客户自有库存的真实订单客户与案件不一致，请先核对');
  return { orderId: order.id, customerRelationId: order.customerRelationId };
}

export async function readClaimReplacementStockFact(tx: any, context: any) {
  const rows = await tx.auditLog.findMany({ where: { targetType: 'Shipment', targetId: context.shipment.id, action: CLAIM_STOCK_BOUND } });
  rows.sort((a: any, b: any) => (b.detail?.claimStock?.revision ?? 0) - (a.detail?.claimStock?.revision ?? 0));
  const row = rows[0], fact = row?.detail?.claimStock;
  if (rows.some((audit: any, index: number) => audit.detail?.claimStock?.revision !== rows.length - index)) claimRefusal('库存选择版本历史不连续或有重复，请先核对');
  if (!fact || !Number.isInteger(fact.revision) || fact.revision < 1 || (rows[1] && rows[1].detail?.claimStock?.revision === fact.revision)
      || fact.schemaVersion !== 1 || fact.actorId !== row.actorId || fact.shipmentId !== context.shipment.id
      || fact.claimDispositionId !== context.disposition.id || fact.contentFingerprint !== context.fact.contentFingerprint
      || !fact.parameters || fact.parameters.expectedRevision !== fact.revision - 1 || !Array.isArray(fact.parameters.items)
      || fact.parametersHash !== claimShipmentDigest(fact.parameters) || fact.bindingFingerprint !== claimShipmentDigest(fact.items)
      || !Array.isArray(fact.items) || !fact.items.length || fact.items.length !== fact.parameters.items.length) claimRefusal('补发缺少唯一当前版本的真实库存批次选择事实');
  let quantity = new Prisma.Decimal(0);
  const seen = new Set<string>();
  for (const [index, selected] of fact.items.entries()) {
    const requested = fact.parameters.items[index];
    if (!requested || requested.itemId !== selected.itemId || requested.quantity !== selected.quantity || requested.unit !== selected.unit) claimRefusal('所选批次与实际请求事实不一致');
    if (seen.has(selected.itemId) || selected.materialCode !== context.line.materialCode || selected.warehouseId !== context.receipt.warehouseId
        || selected.unit !== context.line.unit || !new Prisma.Decimal(selected.quantity).isPositive()) claimRefusal('补发库存批次重复、跨仓、跨SKU或单位不一致');
    seen.add(selected.itemId); quantity = quantity.plus(selected.quantity);
    const item = await tx.inventoryItem.findUnique({ where: { id: selected.itemId } });
    if (!item || item.deletedAt || item.materialCode !== selected.materialCode || item.warehouseId !== selected.warehouseId
        || item.unit !== selected.stockUnit || (item.batchNumber ?? null) !== selected.batchNumber
        || item.ownership !== selected.ownership) claimRefusal('所选补发库存身份、批次或货权已变化');
    if (canonicalClaimJson(await readReplacementEntitlement(tx, item, context.claimCase)) !== canonicalClaimJson(selected.entitlement)) claimRefusal('补发客户自有货来源许可锚已变化');
    const actualQuantity = item.unit === selected.unit ? Number(selected.quantity) : convertLength(Number(selected.quantity), selected.unit, item.unit);
    if (actualQuantity == null || !Number.isFinite(actualQuantity) || actualQuantity <= 0
        || !new Prisma.Decimal(selected.stockQuantity).equals(actualQuantity)) claimRefusal('补发批准单位数量与真实库存单位换算不一致');
  }
  if (!quantity.equals(context.disposition.quantity)) claimRefusal('补发全部实际库存批次数量不等于批准数量');
  return { audit: row, fact };
}

export async function assertClaimShipmentEligible(tx: any, context: any) {
  await assertClaimShipmentLines(tx, context);
  if (context.shipmentKind === 'Repair') return { repair: await readClaimRepairReleaseFact(tx, context), stock: null };
  return { repair: null, stock: await readClaimReplacementStockFact(tx, context) };
}

/** Mandatory exact stock accounting; all units/item identities come from server-owned current facts. */
export async function deductClaimShipmentStockInTx(tx: any, prisma: any, context: any, actorId: string) {
  const eligibility = await assertClaimShipmentEligible(tx, context);
  const selected = context.shipmentKind === 'Repair'
    ? context.batches.map((batch: any) => ({ itemId: batch.item.id, quantity: batch.fact.parameters.quantity, unit: context.line.unit,
      stockQuantity: String(batch.inbound.quantity), stockUnit: batch.item.unit, receivedEventId: batch.audit.id,
      inboundMovementId: batch.inbound.id, holdMovementId: batch.hold.id, batchNumber: batch.item.batchNumber ?? null, ownership: batch.item.ownership }))
    : eligibility.stock!.fact.items;
  const existing = await tx.stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: context.shipment.id, type: 'Outbound' } });
  if (existing.length) claimRefusal('售后运单已有实际出库流水，请先核对已发运事实，不能重复扣账或把半提交当重试');
  const ids = [...new Set<string>(selected.map((item: any) => item.itemId))].sort();
  for (const id of ids) await tx.$queryRawUnsafe('SELECT id FROM "InventoryItem" WHERE id = $1 FOR UPDATE', id);
  const inventory = createInventoryService(prisma);
  const movements: any[] = [], returnReleases: any[] = [];
  for (const chosen of selected) {
    const item = await tx.inventoryItem.findUnique({ where: { id: chosen.itemId } });
    const warehouse = item && await tx.warehouse.findUnique({ where: { id: item.warehouseId } });
    if (!item || item.deletedAt || item.materialCode !== context.line.materialCode || item.warehouseId !== context.receipt.warehouseId
        || item.unit !== chosen.stockUnit || (item.batchNumber ?? null) !== chosen.batchNumber || item.ownership !== chosen.ownership || !warehouse || warehouse.deletedAt || !warehouse.isActive) claimRefusal('实际发运库存批次不存在、跨SKU或不在有效仓库');
    if (context.shipmentKind === 'Replace' && canonicalClaimJson(await readReplacementEntitlement(tx, item, context.claimCase)) !== canonicalClaimJson(chosen.entitlement)) claimRefusal('取得库存锁后补发货权来源发生变化');
    const base = { itemId: chosen.itemId, quantity: Number(chosen.stockQuantity), unit: chosen.stockUnit,
      referenceType: 'Shipment', referenceId: context.shipment.id, reason: `售后实际发运 ${context.shipment.shipmentNumber}` };
    let unlock: any;
    if (context.shipmentKind === 'Repair') {
      const oldRelease = await tx.auditLog.findMany({ where: { targetType: 'ReturnReceiptLine', targetId: context.line.id, action: 'CLAIM_RETURN_DISPOSED' } });
      if (oldRelease.some((row: any) => row.detail?.claimReturn?.parameters?.receivedEventId === chosen.receivedEventId)) claimRefusal('该返修真实退回批次已处置，不可再次解锁发回');
      unlock = await inventory.createStockMovement({ ...base, type: 'Unlock' }, actorId, { tx });
    }
    const outbound = await inventory.createStockMovement({ ...base, type: 'Outbound' }, actorId, { tx });
    if (!new Prisma.Decimal(outbound.quantity).equals(chosen.stockQuantity) || outbound.unit !== chosen.stockUnit
        || outbound.itemId !== chosen.itemId) claimRefusal('售后真实出库流水数量或批次不一致');
    movements.push(outbound);
    if (unlock) {
      await tx.auditLog.create({ data: { id: newAuditId(), actorId, action: 'CLAIM_RETURN_DISPOSED', targetType: 'ReturnReceiptLine', targetId: context.line.id,
        operationType: 'transition', detail: { source: 'claim', claimReturn: { schemaVersion: 1, actorId, outcome: 'RepairedReturned',
          requestId: `shipment:${context.shipment.id}`,
          parameters: { receivedEventId: chosen.receivedEventId, reason: `返修实际发回 ${context.shipment.shipmentNumber}` },
          parametersHash: claimShipmentDigest({ receivedEventId: chosen.receivedEventId, reason: `返修实际发回 ${context.shipment.shipmentNumber}` }),
          receiptId: context.receipt.id, claimDispositionId: context.disposition.id,
          batch: { itemId: item.id, warehouseId: item.warehouseId, materialCode: item.materialCode, quantity: String(outbound.quantity),
            unit: item.unit, batchNumber: item.batchNumber ?? null, ownership: item.ownership },
          contentFingerprint: context.fact.contentFingerprint, lineId: context.line.id, shipmentId: context.shipment.id,
          inboundMovementId: chosen.inboundMovementId, holdMovementId: chosen.holdMovementId,
          unlockMovementId: unlock.id, outboundMovementId: outbound.id, repairWorkOrderId: context.workOrder.id,
          completedEventId: eligibility.repair!.completedEventId, inspectionId: eligibility.repair!.inspectionId,
          inspectionEventId: eligibility.repair!.inspectionEventId } } } });
      returnReleases.push({ receivedEventId: chosen.receivedEventId, unlockMovementId: unlock.id, outboundMovementId: outbound.id });
    }
  }
  await tx.auditLog.create({ data: { id: newAuditId(), actorId, action: CLAIM_SHIPMENT_RELEASED, targetType: 'Shipment', targetId: context.shipment.id,
    operationType: 'transition', detail: { source: 'claim', claimShipment: { schemaVersion: 1, actorId, shipmentId: context.shipment.id,
      claimDispositionId: context.disposition.id, contentFingerprint: context.fact.contentFingerprint,
      stockBindingAuditId: eligibility.stock?.audit.id ?? null, stockRevision: eligibility.stock?.fact.revision ?? null,
      repairBatchFingerprint: context.bindingFingerprint ?? null, repairFact: eligibility.repair,
      movements: movements.map(m => ({ id: m.id, itemId: m.itemId, quantity: String(m.quantity), unit: m.unit })), returnReleases } } } });
  return { movementCount: movements.length, deductedLines: selected.map((row: any) => ({ identity: context.line.materialCode,
    quantity: Number(row.quantity), unit: row.unit, itemId: row.itemId })), skipped: [], alreadyProcessed: false };
}

export async function finalizeClaimShipmentInTx(tx: any, context: any, actorId: string) {
  if (context.shipmentKind !== 'Repair') return;
  const shipment = await tx.shipment.findUnique({ where: { id: context.shipment.id } });
  const released = await tx.auditLog.findMany({ where: { targetType: 'Shipment', targetId: context.shipment.id, action: CLAIM_SHIPMENT_RELEASED } });
  if (!shipment || shipment.status !== 'Shipped' || released.length !== 1 || released[0].actorId !== actorId
      || released[0].detail?.claimShipment?.actorId !== actorId
      || released[0].detail?.claimShipment?.contentFingerprint !== context.fact.contentFingerprint
      || released[0].detail?.claimShipment?.repairBatchFingerprint !== context.bindingFingerprint) claimRefusal('返修尚无准确实际出库和运单放行事实，不可只推Shipped');
  await tx.repairWorkOrder.update({ where: { id: context.workOrder.id }, data: { status: 'Shipped', updatedAt: BigInt(Date.now()) } });
  await tx.returnReceiptLine.update({ where: { id: context.line.id }, data: { status: 'Dispositioned', updatedAt: BigInt(Date.now()) } });
  const { refreshClaimReturnHeader } = await import('./claimReturnFulfillmentService');
  await refreshClaimReturnHeader(tx, context.receipt.id);
  await tx.auditLog.create({ data: { id: newAuditId(), actorId, action: 'CLAIM_REPAIR_RETURNED', targetType: 'RepairWorkOrder', targetId: context.workOrder.id,
    operationType: 'transition', detail: { source: 'claim', fromStatus: 'Completed', toStatus: 'Shipped',
      shipmentId: context.shipment.id, batchFingerprint: context.bindingFingerprint } } });
}
