import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SupplierContractTx, SupplierSourceProof } from './supplierContractAccess';
import { normalizeGarmentFulfillment } from '../orders/internalFabricPolicy';
import { normalizeSupplierContractDraft, supplierFail, supplierFingerprint, supplierJson, supplierObject, type SupplierContractDraft, type SupplierContractKind, type SupplierContractLine } from './supplierContractPolicy';

export type SupplierContractRecord = { id: string; kind: SupplierContractKind; number: string; status: string; supplierRelationId: string | null;
  approvedCommitmentRevisionId: string | null; businessOwnerId: string | null; lines: Array<{ id: string; orderLineId: string | null; retiredAt: bigint | null }> };
export type SupplierSnapshot = SupplierContractDraft & { schemaVersion: 1; businessOwnerId: string; sourceProofs: SupplierSourceProof[]; basedOnRevisionId: string | null; changeReason: string | null;
  supplierParty?: Prisma.InputJsonValue; supplierFeedbackReceiptId?: string };
export async function readSupplierContract(tx: SupplierContractTx, kind: SupplierContractKind, id: string): Promise<SupplierContractRecord> {
  if (kind === 'purchase') {
    const row = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
    if (!row) return supplierFail('NOT_FOUND', '采购单不存在或已失效。', 404);
    return { id: row.id, kind, number: row.poNumber, status: row.status, supplierRelationId: row.supplierRelationId,
      approvedCommitmentRevisionId: row.approvedCommitmentRevisionId, businessOwnerId: row.businessOwnerId, lines: row.lines };
  }
  const row = await tx.outsourcingOrder.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
  if (!row) return supplierFail('NOT_FOUND', '加工合同不存在或已失效。', 404);
  return { id: row.id, kind, number: row.orderNumber, status: row.status, supplierRelationId: row.supplierId,
    approvedCommitmentRevisionId: row.approvedCommitmentRevisionId, businessOwnerId: row.businessOwnerId, lines: row.lines };
}
export const supplierRevisionWhere = (kind: SupplierContractKind, id: string) => kind === 'purchase' ? { purchaseOrderId: id } : { outsourcingOrderId: id };
export async function latestSupplierRevision(tx: SupplierContractTx, kind: SupplierContractKind, id: string) {
  return tx.supplierCommitmentRevision.findFirst({ where: supplierRevisionWhere(kind, id), orderBy: { revision: 'desc' } });
}
export function supplierSnapshot(value: unknown, kind: SupplierContractKind): SupplierSnapshot {
  const row = supplierObject(value);
  if (row.schemaVersion !== 1 || row.contractKind !== kind || !Array.isArray(row.sourceProofs) || typeof row.businessOwnerId !== 'string')
    return supplierFail('SOURCE_PROOF_UNKNOWN', '供应商承诺版本依据尚未明确，请重新核实。', 409);
  return { ...normalizeSupplierContractDraft(kind, row), schemaVersion: 1, businessOwnerId: row.businessOwnerId,
    sourceProofs: row.sourceProofs as SupplierSourceProof[], basedOnRevisionId: typeof row.basedOnRevisionId === 'string' ? row.basedOnRevisionId : null,
    changeReason: typeof row.changeReason === 'string' ? row.changeReason : null,
    ...(row.supplierParty ? { supplierParty: supplierJson(row.supplierParty) } : {}),
    ...(typeof row.supplierFeedbackReceiptId === 'string' ? { supplierFeedbackReceiptId: row.supplierFeedbackReceiptId } : {}) };
}
export function assertSupplierSourceProof(snapshot: SupplierSnapshot, current: SupplierSourceProof[]): void {
  const ids = [...new Set(snapshot.lines.map(line => line.orderLineId))].sort();
  const selected = current.filter(row => ids.includes(row.orderLineId)).sort((a, b) => a.orderLineId.localeCompare(b.orderLineId));
  const frozen = [...snapshot.sourceProofs].sort((a, b) => a.orderLineId.localeCompare(b.orderLineId));
  if (selected.length !== ids.length || frozen.length !== ids.length || supplierFingerprint(selected) !== supplierFingerprint(frozen))
    supplierFail('SOURCE_PROOF_CHANGED', '准确来源的批准或商业依据已变化，请保存新的草稿并重新审批。', 409);
}
export function assignSupplierLineIds(draft: SupplierContractDraft, existing?: SupplierContractRecord): SupplierContractDraft {
  for (const line of draft.lines) {
    if (line.id && (!existing || !existing.lines.some(old => old.id === line.id && old.orderLineId === line.orderLineId)))
      supplierFail('LINE_IDENTITY_CHANGED', '已有单据行不能改绑准确来源；请在变更中新增行并保留原行历史。', 409);
  }
  return { ...draft, lines: draft.lines.map(line => ({ ...line, id: line.id ?? `SCL_${randomUUID()}` })) };
}
export async function validateSupplierAndLocation(tx: SupplierContractTx, draft: SupplierContractDraft): Promise<Prisma.InputJsonValue> {
  const relation = await tx.relation.findFirst({ where: { id: draft.supplierRelationId, deletedAt: null } });
  const factory = await tx.factoryProfile.findUnique({ where: { relationId: draft.supplierRelationId } });
  if (!relation || !relation.isOrganization || relation.category !== 'Supplier' || factory?.deletedAt != null || factory?.blacklistedAt != null)
    return supplierFail('SUPPLIER_UNAVAILABLE', '请选择真实有效且未被拉黑的供应商。', 409);
  const location = draft.mainDeliveryLocation;
  if (location?.kind === 'supplier' && !await tx.relation.findFirst({ where: { id: location.relationId, deletedAt: null, isOrganization: true } }))
    supplierFail('LOCATION_UNAVAILABLE', '实际交付对象已失效。', 409);
  if (location?.kind === 'warehouse' && !await tx.warehouse.findFirst({ where: { id: location.warehouseId, isActive: true, deletedAt: null } }))
    supplierFail('LOCATION_UNAVAILABLE', '实际交付仓库已失效。', 409);
  return supplierJson({ id: relation.id, code: relation.code, name: relation.name, chineseName: relation.chineseName, englishName: relation.englishName, contactInfo: relation.contactInfo,
    officialAddress: relation.officialAddress, taxId: relation.taxId, primaryContactName: relation.primaryContactName, primaryContactEmail: relation.primaryContactEmail });
}
/** Cost responsibility is explicit. A garment buyer cannot bypass the fabric
 * team's internal supply or buy items explicitly included in CMT. */
export async function assertSupplierLineResponsibilities(tx: SupplierContractTx, snapshot: SupplierContractDraft, sources: SupplierSourceProof[], formal = false) {
  for (const line of snapshot.lines) {
    const source = sources.find(row => row.orderLineId === line.orderLineId);
    if (!source) return supplierFail('SOURCE_REQUIRED', '单据行缺少准确来源。');
    const commercial = supplierObject(source.commercial), order = supplierObject(commercial.order), orderLine = supplierObject(commercial.line);
    if (snapshot.contractKind === 'purchase' && line.kind === 'Material') {
      if (!line.category) return supplierFail('CATEGORY_REQUIRED', '物料采购须明确实物品类。');
      if (source.businessLine === 'garment' && line.category === 'Fabric') return supplierFail('INTERNAL_FABRIC_SOURCE_REQUIRED', '成衣面料须由面料业务建立内部供料，不能在成衣行直接采购绕过。', 409);
      if (source.businessLine === 'garment') {
        let responsibility: ReturnType<typeof normalizeGarmentFulfillment>;
        try { responsibility = normalizeGarmentFulfillment(orderLine); }
        catch { return supplierFail('CMT_SCOPE_REVIEW_REQUIRED', '来源条目须明确真实履约模式及 CMT 包含范围，历史未知值不能推定。', 409); }
        if (!line.costItemName || line.includedInCmtPrice === undefined || !line.cmtIncludedItemsReviewed
          || supplierFingerprint(line.cmtIncludedItemsReviewed) !== supplierFingerprint(responsibility.cmtIncludedItems))
          return supplierFail('CMT_SCOPE_REVIEW_REQUIRED', '请明确实际费用项目，逐项核对来源 CMT 包含范围，并据实记录是否已含加工价。', 409);
        if (line.includedInCmtPrice || responsibility.cmtIncludedItems.includes(line.costItemName))
          return supplierFail('CMT_INCLUDED_COST', '该实际费用项目已含加工价，不能重复采购和计成本。', 409);
      }
    }
    if (snapshot.contractKind !== 'processing' || !formal && !line.inputSource) continue;
    const input = line.inputSource;
    if (!input) return supplierFail('INPUT_SOURCE_REQUIRED', '提交加工合同前须逐行明确真实原料来源。');
    if (input.kind === 'purchase_contract') {
      const purchaseLine = await tx.purchaseLine.findFirst({ where: { id: input.lineId, purchaseOrderId: input.contractId, retiredAt: null } });
      if (!purchaseLine || purchaseLine.orderLineId !== line.orderLineId || purchaseLine.kind !== 'Material')
        return supplierFail('INPUT_SOURCE_MISMATCH', '加工采购料源须引用本准确来源行的真实原料采购行。', 409);
    } else if (input.kind === 'warehouse') {
      const item = await tx.inventoryItem.findFirst({ where: { id: input.inventoryItemId, deletedAt: null } });
      if (!item || item.orderId !== source.orderId || item.ownership !== 'Owned' || item.ownerRelationId != null)
        return supplierFail('INPUT_SOURCE_MISMATCH', '库内料源须是归属当前来源订单的真实我方库存。', 409);
    } else if (!order.customerRelationId || order.customerRelationId !== input.relationId
      || !await tx.relation.findFirst({ where: { id: input.relationId, deletedAt: null, isOrganization: true } }))
      return supplierFail('INPUT_SOURCE_MISMATCH', '客户供料须明确当前准确来源的真实需求方。', 409);
  }
}
export async function writeSupplierRevision(tx: SupplierContractTx, kind: SupplierContractKind, id: string, revision: number, snapshot: SupplierSnapshot) {
  return tx.supplierCommitmentRevision.create({ data: { id: `SCV_${randomUUID()}`, ...supplierRevisionWhere(kind, id), revision, status: 'draft',
    snapshot: supplierJson(snapshot), contentFingerprint: supplierFingerprint(snapshot), basedOnRevisionId: snapshot.basedOnRevisionId,
    createdBy: snapshot.businessOwnerId, createdAt: BigInt(Date.now()) } });
}
/** Stable row IDs survive revisions and actual deliveries. Header quantities are legacy projections only. */
export async function projectSupplierContract(tx: SupplierContractTx, kind: SupplierContractKind, id: string, snapshot: SupplierSnapshot, options: { createNumber?: string; approvedRevisionId?: string }) {
  const now = BigInt(Date.now()), orderIds = [...new Set(snapshot.sourceProofs.map(row => row.orderId))];
  const orderId = orderIds.length === 1 ? orderIds[0] : null;
  const common = { currency: snapshot.currency, totalAmount: new Prisma.Decimal(snapshot.totalAmount), paymentTerms: snapshot.paymentTerms,
    mainDeliveryLocationKey: snapshot.mainDeliveryLocationKey, mainDeliveryLocation: snapshot.mainDeliveryLocation ? supplierJson(snapshot.mainDeliveryLocation) : Prisma.DbNull,
    businessOwnerId: snapshot.businessOwnerId, orderId, notes: snapshot.notes ?? null, updatedAt: now,
    ...(options.approvedRevisionId ? { approvedCommitmentRevisionId: options.approvedRevisionId } : {}) };
  if (kind === 'purchase') {
    const data = { ...common, supplierRelationId: snapshot.supplierRelationId, orderDate: snapshot.orderDate,
      deliveryTerms: snapshot.deliveryTerms ?? null, shipToAddress: snapshot.mainDeliveryLocation?.address ?? null };
    if (options.createNumber) await tx.purchaseOrder.create({ data: { ...data, id, poNumber: options.createNumber, status: 'Draft', createdAt: now } });
    else await tx.purchaseOrder.update({ where: { id }, data });
    await tx.purchaseLine.updateMany({ where: { purchaseOrderId: id, id: { notIn: snapshot.lines.map(row => row.id!) }, retiredAt: null }, data: { retiredAt: now } });
    for (const [index, line] of snapshot.lines.entries()) {
      const data = { ...purchaseLineData(line, index), ...(options.approvedRevisionId ? { supplierCommittedDeliveryDate: null } : {}) };
      await tx.purchaseLine.upsert({ where: { id: line.id! }, create: { ...data, id: line.id!, purchaseOrderId: id, createdAt: now }, update: { ...data, retiredAt: null } });
    }
  } else {
    const units = new Set(snapshot.lines.map(row => row.unit));
    const quantity = units.size === 1 ? snapshot.lines.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)) : new Prisma.Decimal(0);
    const data = { ...common, supplierId: snapshot.supplierRelationId, processType: snapshot.lines.length === 1 ? snapshot.lines[0].processType! : 'Other',
      description: snapshot.lines.map(row => row.description).join(' / '), quantity, unit: units.size === 1 ? snapshot.lines[0].unit : 'MIXED',
      unitPrice: snapshot.lines.length === 1 ? new Prisma.Decimal(snapshot.lines[0].unitPrice) : new Prisma.Decimal(0), orderDate: snapshot.orderDate };
    if (options.createNumber) await tx.outsourcingOrder.create({ data: { ...data, id, orderNumber: options.createNumber, status: 'Draft', createdAt: now } });
    else await tx.outsourcingOrder.update({ where: { id }, data });
    await tx.outsourcingLine.updateMany({ where: { outsourcingOrderId: id, id: { notIn: snapshot.lines.map(row => row.id!) }, retiredAt: null }, data: { retiredAt: now } });
    for (const line of snapshot.lines) {
      const data = { orderLineId: line.orderLineId, processType: line.processType!, description: line.description, materialCode: line.materialCode ?? null,
        specification: line.specification ?? null, quantity: new Prisma.Decimal(line.quantity), unit: line.unit, unitPrice: new Prisma.Decimal(line.unitPrice),
        amount: new Prisma.Decimal(line.amount), requestedDeliveryDate: line.requestedDeliveryDate, notes: line.notes ?? null, updatedAt: now,
        ...(options.approvedRevisionId ? { supplierCommittedDeliveryDate: null } : {}) };
      await tx.outsourcingLine.upsert({ where: { id: line.id! }, create: { ...data, id: line.id!, outsourcingOrderId: id, createdAt: now }, update: { ...data, retiredAt: null } });
    }
  }
}
function purchaseLineData(line: SupplierContractLine, index: number) {
  return { lineNumber: index + 1, kind: line.kind!, orderLineId: line.orderLineId, materialCode: line.materialCode ?? null, description: line.description,
    category: line.category ?? null, specification: line.specification ?? null, quantity: new Prisma.Decimal(line.quantity), unit: line.unit,
    unitPrice: new Prisma.Decimal(line.unitPrice), amount: new Prisma.Decimal(line.amount), requestedDeliveryDate: line.requestedDeliveryDate, notes: line.notes ?? null };
}
export async function supplierAudit(tx: SupplierContractTx, actorId: string, action: string, kind: SupplierContractKind, id: string, before: unknown, after: unknown) {
  await tx.auditLog.create({ data: { id: `alog_${randomUUID()}`, actorId, action, targetType: kind === 'purchase' ? 'PurchaseOrder' : 'OutsourcingOrder', targetId: id,
    detail: supplierJson({ source: 'api:supplier-contract', before, after }), operationType: 'update' } });
}
