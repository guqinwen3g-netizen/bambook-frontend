import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { parsePositiveDecimal } from '../shared/moneyInput';
import { coerceShippingMethodForWrite } from '../shared/shippingMethod';
import { convertLength } from '../lib/unitConversion';
import { createShipment } from '../shipping/shipmentMutationService';
import { replaceShipmentLinesTx } from '../shipping/shipmentPackingService';
import type { ClaimResult } from './claimCaseService';
import { canonicalClaimJson, ClaimTransactionError, claimRefusal } from './claimApprovalFact';
import { lockClaimRepairContext, readClaimRepairReleaseFact } from './claimRepairFulfillmentService';
import { CLAIM_STOCK_BOUND, claimShipmentDigest, lockClaimShipmentSource, assertClaimShipmentLines, readReplacementEntitlement, readClaimReplacementStockFact } from './claimShipmentFact';

const REPAIR_RETURN_DRAFT = 'CLAIM_REPAIR_RETURN_SHIPMENT_CREATED';
const editable = new Set(['Draft', 'Booked', 'Loading']);
const newId = () => `alog_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
function invalid(message: string): never { throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message }); }
function request(input: any, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) invalid('售后物流参数含未开放的来源、状态或批准范围字段');
  if (typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim() || input.clientRequestId.length > 200) invalid('须使用稳定 clientRequestId（1–200字符）');
}
function positive(value: any) {
  const parsed = parsePositiveDecimal(value, '补发实际批次数量');
  if (!parsed.ok) invalid(parsed.message);
  const decimal = new Prisma.Decimal(parsed.value);
  if (!Number.isFinite(Number(decimal)) || !decimal.equals(String(Number(decimal)))) invalid('实际批次数量超出库存引擎可精确处理的范围');
  return decimal.toString();
}
function retry(rows: any[], key: string, actorId: string, params: any, fingerprint: string) {
  const matches = rows.filter(row => row.detail?.claimStock?.requestId === key || row.detail?.claimRepairShipment?.requestId === key);
  if (!matches.length) return null;
  const row = matches[0], fact = row.detail?.claimStock ?? row.detail?.claimRepairShipment;
  if (matches.length !== 1 || row.actorId !== actorId || fact.actorId !== actorId || fact.schemaVersion !== 1
      || fact.parametersHash !== claimShipmentDigest(params) || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(params)
      || fact.contentFingerprint !== fingerprint) claimRefusal('相同物流请求的实际调用者、完整参数或批准范围不同');
  return { row, fact };
}
export interface CreateClaimRepairReturnShipmentInput {
  clientRequestId: string; shippingMethod?: string | null; sourceShipmentId?: string | null; notes?: string | null;
}
export async function createClaimRepairReturnShipment(prisma: PrismaClient, workOrderId: string,
  input: CreateClaimRepairReturnShipmentInput, actorId: string): Promise<ClaimResult<any>> {
  try {
    request(input, ['clientRequestId', 'shippingMethod', 'sourceShipmentId', 'notes']);
    for (const key of ['shippingMethod', 'sourceShipmentId', 'notes']) if ((input as any)[key] != null && typeof (input as any)[key] !== 'string') invalid('运输方式、原票和备注须为文本');
    const method = coerceShippingMethodForWrite(input.shippingMethod);
    if (!method.ok) invalid(method.message);
    const parameters = { shippingMethod: method.value ?? null, sourceShipmentId: input.sourceShipmentId ?? null, notes: input.notes ?? null };
    return await prisma.$transaction(async (tx: any) => {
      const context = await lockClaimRepairContext(tx, workOrderId);
      const audits = await tx.auditLog.findMany({ where: { targetType: 'RepairWorkOrder', targetId: workOrderId, action: REPAIR_RETURN_DRAFT } });
      const previous = retry(audits, input.clientRequestId, actorId, parameters, context.fact.contentFingerprint);
      if (previous) {
        const source = await lockClaimShipmentSource(tx, previous.fact.shipmentId);
        if (!source || source.workOrder?.id !== workOrderId || context.workOrder.reshipmentId !== source.shipment.id
            || previous.fact.batchFingerprint !== context.bindingFingerprint) claimRefusal('重试返还草稿的真实运单或批次关联已变化');
        await assertClaimShipmentLines(tx, source);
        return { ok: true, data: { shipment: source.shipment, returnShipmentEventId: previous.row.id,
          batchFingerprint: context.bindingFingerprint, scope: { materialCode: context.line.materialCode, quantity: String(context.line.expectedQuantity), unit: context.line.unit }, replayed: true } };
      }
      if (context.workOrder.reshipmentId || audits.length) claimRefusal('返修已建立返还运单，请使用原请求标识核对，不可另建重复票');
      const release = await readClaimRepairReleaseFact(tx, context);
      const sourceId = parameters.sourceShipmentId ?? context.workOrder.sourceShipmentId ?? null;
      const src = sourceId ? await tx.shipment.findUnique({ where: { id: sourceId } }) : null;
      if (sourceId && (!src || src.deletedAt)) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '返还引用的原运单不存在' });
      if (src && (src.customerRelationId !== (context.claimCase.customerRelationId ?? null) || src.customerName !== (context.claimCase.customerName ?? null))) claimRefusal('返还原票客户与真实案件不一致');
      const created = await createShipment({ prisma, tx, actorId, auditSource: 'claim:repair-return', input: {
        type: src?.type ?? 'Export', status: 'Draft', shippingMethod: parameters.shippingMethod ?? src?.shippingMethod ?? 'Sea',
        customerRelationId: context.claimCase.customerRelationId ?? null, customerName: context.claimCase.customerName ?? null,
        consigneeRelationId: src?.consigneeRelationId ?? null, consigneeName: src?.consigneeName ?? null,
        businessLine: src?.businessLine ?? null, notes: parameters.notes,
      } });
      // A failed producer Result must escape the caller transaction, even if its
      // implementation swallowed an operational exception after writing a header.
      if (!created.ok) throw new Error('返修返还运单生产服务未完成');
      const shipmentId = created.data!.shipment.id;
      await replaceShipmentLinesTx(tx, shipmentId, [{ productCode: context.line.materialCode,
        quantity: String(context.line.expectedQuantity), unit: context.line.unit }], actorId, undefined, { auditPrisma: prisma });
      await tx.repairWorkOrder.update({ where: { id: workOrderId }, data: { reshipmentId: shipmentId, updatedAt: BigInt(Date.now()) } });
      const audit = await tx.auditLog.create({ data: { id: newId(), actorId, action: REPAIR_RETURN_DRAFT, targetType: 'RepairWorkOrder', targetId: workOrderId,
        operationType: 'create', detail: { source: 'claim', claimRepairShipment: { schemaVersion: 1, actorId, requestId: input.clientRequestId,
          parameters, parametersHash: claimShipmentDigest(parameters), shipmentId, contentFingerprint: context.fact.contentFingerprint,
          batchFingerprint: context.bindingFingerprint, releaseFact: release, sourceShipmentId: sourceId } } } });
      return { ok: true, data: { shipment: await tx.shipment.findUnique({ where: { id: shipmentId } }), returnShipmentEventId: audit.id,
        batchFingerprint: context.bindingFingerprint, scope: { materialCode: context.line.materialCode, quantity: String(context.line.expectedQuantity), unit: context.line.unit }, replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}

export interface BindClaimShipmentStockInput {
  clientRequestId: string; expectedRevision: number; items: Array<{ itemId: string; quantity: string | number; unit: string }>;
}

/** Read the persisted current selection, never a notes-derived claim label.
 * An empty first selection is explicitly revision 0; this is not shipment eligibility.
 */
export async function getClaimShipmentStockBinding(prisma: PrismaClient, shipmentId: string): Promise<ClaimResult<any>> {
  try {
    return await prisma.$transaction(async (tx: any) => {
      const context = await lockClaimShipmentSource(tx, shipmentId);
      if (!context || context.shipmentKind !== 'Replace') claimRefusal('运单不属于准确已执行的换货补发处置，不能读取其他运单的库存选择');
      await assertClaimShipmentLines(tx, context);
      const scope = { claimCaseId: context.claimCase.id, claimDispositionId: context.disposition.id,
        materialCode: context.line.materialCode, quantity: String(context.line.expectedQuantity), unit: context.line.unit,
        warehouseId: context.receipt.warehouseId, contentFingerprint: context.fact.contentFingerprint };
      const audits = await tx.auditLog.findMany({ where: { targetType: 'Shipment', targetId: shipmentId, action: CLAIM_STOCK_BOUND } });
      if (!audits.length) return { ok: true, data: { shipmentId, shipmentStatus: context.shipment.status, currentRevision: 0, revision: 0,
        stockBindingEventId: null, scope, items: [] } };
      const current = await readClaimReplacementStockFact(tx, context);
      return { ok: true, data: { shipmentId, shipmentStatus: context.shipment.status, currentRevision: current.fact.revision, revision: current.fact.revision,
        stockBindingEventId: current.audit.id, scope, items: current.fact.items } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}

/** Explicit physical batches only; a revision append keeps the previous selection history. */
export async function bindClaimShipmentStock(prisma: PrismaClient, shipmentId: string, input: BindClaimShipmentStockInput,
  actorId: string): Promise<ClaimResult<any>> {
  try {
    request(input, ['clientRequestId', 'expectedRevision', 'items']);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) invalid('expectedRevision须为当前库存选择版本（首次0）');
    if (!Array.isArray(input.items) || !input.items.length) invalid('须选择明确实际库存批次');
    const items = input.items.map(row => {
      if (!row || typeof row !== 'object' || Object.keys(row).some(key => !['itemId', 'quantity', 'unit'].includes(key))
          || typeof row.itemId !== 'string' || !row.itemId.trim() || typeof row.unit !== 'string' || !row.unit.trim()) invalid('实际批次必须有准确itemId、数量和单位');
      return { itemId: row.itemId, quantity: positive(row.quantity), unit: row.unit };
    }).sort((a, b) => a.itemId.localeCompare(b.itemId));
    if (new Set(items.map(row => row.itemId)).size !== items.length) invalid('实际库存批次不可重复');
    const parameters = { expectedRevision: input.expectedRevision, items };
    return await prisma.$transaction(async (tx: any) => {
      const context = await lockClaimShipmentSource(tx, shipmentId);
      if (!context || context.shipmentKind !== 'Replace') claimRefusal('仅准确已执行的换货补发运单可选择新货批次');
      await assertClaimShipmentLines(tx, context);
      const audits = await tx.auditLog.findMany({ where: { targetType: 'Shipment', targetId: shipmentId, action: CLAIM_STOCK_BOUND } });
      const revisions = audits.map((row: any) => row.detail?.claimStock?.revision);
      if (revisions.some((n: any) => !Number.isInteger(n) || n < 1) || new Set(revisions).size !== revisions.length
          || [...revisions].sort((a, b) => a - b).some((n, i) => n !== i + 1)) claimRefusal('库存选择版本历史损坏，请先对账');
      const currentRevision = revisions.length ? Math.max(...revisions) : 0;
      const previous = retry(audits, input.clientRequestId, actorId, parameters, context.fact.contentFingerprint);
      if (previous && (!Array.isArray(previous.fact.items) || previous.fact.bindingFingerprint !== claimShipmentDigest(previous.fact.items)
          || previous.fact.shipmentId !== shipmentId || previous.fact.claimDispositionId !== context.disposition.id)) claimRefusal('原库存选择审计关联或批次事实已损坏');
      if (previous) return { ok: true, data: { shipmentId, revision: previous.fact.revision, currentRevision,
        stockBindingEventId: previous.row.id, scope: { materialCode: context.line.materialCode, quantity: String(context.line.expectedQuantity), unit: context.line.unit },
        items: previous.fact.items, replayed: true } };
      if (!editable.has(context.shipment.status)) claimRefusal('货已发出或运单已取消，不可再改库存批次');
      if (currentRevision !== input.expectedRevision) claimRefusal('实际库存选择版本已变，请刷新后重新核对');
      const warehouse = await tx.warehouse.findUnique({ where: { id: context.receipt.warehouseId } });
      if (!warehouse || warehouse.deletedAt || !warehouse.isActive) claimRefusal('补发仓库不存在或已停用');
      let total = new Prisma.Decimal(0);
      const binding = [];
      for (const selected of items) {
        await tx.$queryRawUnsafe('SELECT id FROM "InventoryItem" WHERE id = $1 FOR UPDATE', selected.itemId);
        const item = await tx.inventoryItem.findUnique({ where: { id: selected.itemId } });
        if (!item || item.deletedAt || item.warehouseId !== context.receipt.warehouseId || item.materialCode !== context.line.materialCode
            || selected.unit !== context.line.unit) claimRefusal('补发实际批次跨仓、跨SKU、单位不符或货权不适用');
        const entitlement = await readReplacementEntitlement(tx, item, context.claimCase);
        const stockQuantity = item.unit === selected.unit ? Number(selected.quantity) : convertLength(Number(selected.quantity), selected.unit, item.unit);
        if (stockQuantity == null || !Number.isFinite(stockQuantity) || stockQuantity <= 0) claimRefusal('补发实际库存单位无法按唯一换算口径处理');
        if (item.quantity == null || item.lockedQuantity == null) claimRefusal('实际库存或锁定数量尚未确认，不能将未知锁定量视为零');
        const actual = new Prisma.Decimal(item.quantity), locked = new Prisma.Decimal(item.lockedQuantity);
        if (!actual.isFinite() || !locked.isFinite() || actual.isNegative() || locked.isNegative() || locked.gt(actual)) claimRefusal('实际库存或锁定数量不完整，请核对库存流水');
        if (actual.minus(locked).lt(stockQuantity)) claimRefusal('所选实际批次可用库存不足，不能预选退回锁定坏货');
        total = total.plus(selected.quantity);
        binding.push({ ...selected, stockQuantity: String(stockQuantity), stockUnit: item.unit, warehouseId: item.warehouseId,
          materialCode: item.materialCode, batchNumber: item.batchNumber ?? null, ownership: item.ownership, entitlement });
      }
      if (!total.equals(context.disposition.quantity)) claimRefusal('补发实际批次合计必须完整等于准确批准数量');
      const revision = currentRevision + 1;
      const audit = await tx.auditLog.create({ data: { id: newId(), actorId, action: CLAIM_STOCK_BOUND, targetType: 'Shipment', targetId: shipmentId,
        operationType: 'update', detail: { source: 'claim', claimStock: { schemaVersion: 1, actorId, requestId: input.clientRequestId,
          parameters, parametersHash: claimShipmentDigest(parameters), revision, shipmentId, claimDispositionId: context.disposition.id,
          contentFingerprint: context.fact.contentFingerprint, items: binding, bindingFingerprint: claimShipmentDigest(binding) } } } });
      return { ok: true, data: { shipmentId, revision, currentRevision: revision, stockBindingEventId: audit.id,
        scope: { materialCode: context.line.materialCode, quantity: String(context.line.expectedQuantity), unit: context.line.unit }, items: binding, replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}
