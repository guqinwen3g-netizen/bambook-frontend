import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SupplierContractTx } from './supplierContractAccess';
import { supplierFail, supplierFingerprint, type SupplierContractDraft, type SupplierContractKind } from './supplierContractPolicy';

/** Optional explicit demand linkage. Every linked requirement stays an exact
 * planning allocation, never a physical receipt or a supplier approval. */
export async function reconcileSupplierDemandPlan(tx: SupplierContractTx, kind: SupplierContractKind, contractId: string,
  draft: SupplierContractDraft, ownerId: string, options: { apply?: boolean; frozen?: boolean } = {}): Promise<SupplierContractDraft> {
  const parent = kind === 'purchase' ? { purchaseOrderId: contractId } : { outsourcingOrderId: contractId };
  const previous = await tx.purchaseDemandAllocation.findMany({ where: parent });
  const demandIds = [...new Set([...draft.lines.flatMap(line => line.demandId ? [line.demandId] : []), ...previous.filter(row => row.status === 'Active').map(row => row.demandId)])].sort();
  const lines = draft.lines.map(line => ({ ...line }));
  for (const demandId of demandIds) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProcurementDemand" WHERE "id" = ${demandId} FOR UPDATE`);
    const demand = await tx.procurementDemand.findUnique({ where: { id: demandId } });
    if (!demand || demand.status !== 'Ready' || !demand.orderId || !demand.orderLineId || demand.requiredQuantity == null)
      return supplierFail('DEMAND_NOT_READY', '准确需求尚未确认或已失效，请先核对实际需求。', 409);
    if (demand.assigneeId !== ownerId) return supplierFail('DEMAND_NOT_ASSIGNEE', '请由准确需求当前已领办的业务经办人建单或变更。', 403);
    const own = lines.filter(line => line.demandId === demandId);
    if (own.some(line => line.orderLineId !== demand.orderLineId || line.unit !== demand.unit
      || (kind === 'processing' ? demand.kind !== 'ProcessingService' : demand.kind !== line.kind)))
      return supplierFail('DEMAND_SOURCE_MISMATCH', '需求类型、准确来源条目或明确单位与合同条目不一致。', 409);
    if (options.frozen && own.some(line => line.demandRevision !== demand.revision)) return supplierFail('DEMAND_CHANGED', '冻结承诺的准确需求版本已变化，请刷新草稿后重提。', 409);
    if (demand.bomId) {
      const bom = await tx.bOM.findUnique({ where: { id: demand.bomId } });
      if (!bom || bom.deletedAt != null || bom.status !== 'Confirmed' || bom.version !== demand.bomVersion)
        return supplierFail('DEMAND_BOM_CHANGED', '准确需求所依据的 BOM 已变化，请先核对新版与已有采购。', 409);
    }
    const allocations = await tx.purchaseDemandAllocation.findMany({ where: { demandId, status: 'Active' } });
    const foreign = allocations.filter(row => kind === 'purchase' ? row.purchaseOrderId !== contractId : row.outsourcingOrderId !== contractId)
      .reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    const proposed = own.reduce((sum, line) => sum.plus(line.quantity), new Prisma.Decimal(0));
    if (foreign.plus(proposed).gt(demand.requiredQuantity)) return supplierFail('DEMAND_OVER_ALLOCATED', '本次准确合同分配超过该需求当前剩余量。', 409);
    const active = previous.filter(row => row.demandId === demandId && row.status === 'Active');
    for (const allocation of active) {
      const lineId = kind === 'purchase' ? allocation.purchaseLineId : allocation.outsourcingLineId;
      const next = own.find(line => line.id === lineId);
      if (!next || new Prisma.Decimal(next.quantity).lt(allocation.quantity)) {
        const facts = await tx.supplierFulfillmentFact.count({ where: kind === 'purchase' ? { purchaseLineId: lineId } : { outsourcingLineId: lineId } });
        if (facts) return supplierFail('FULFILLED_ALLOCATION_REVIEW_REQUIRED', '已有实际交接的需求分配不能直接缩减或释放，请先处理准确履约差异。', 409);
      }
    }
    const changed = active.some(row => !own.some(line => line.id === (kind === 'purchase' ? row.purchaseLineId : row.outsourcingLineId) && new Prisma.Decimal(line.quantity).eq(row.quantity)))
      || own.some(line => !active.some(row => (kind === 'purchase' ? row.purchaseLineId : row.outsourcingLineId) === line.id && new Prisma.Decimal(line.quantity).eq(row.quantity)));
    let revision = demand.revision;
    if (options.apply && changed) {
      for (const allocation of active) if (!own.some(line => line.id === (kind === 'purchase' ? allocation.purchaseLineId : allocation.outsourcingLineId)))
        await tx.purchaseDemandAllocation.update({ where: { id: allocation.id }, data: { status: 'Released', releasedAt: BigInt(Date.now()) } });
      for (const line of own) {
        if (!line.id) return supplierFail('LINE_SOURCE_MISMATCH', '需求分配须有稳定准确合同条目。', 409);
        const existing = previous.find(row => (kind === 'purchase' ? row.purchaseLineId : row.outsourcingLineId) === line.id);
        if (existing && existing.demandId !== demandId) return supplierFail('DEMAND_SOURCE_MISMATCH', '不能更换已有稳定条目的需求归属。', 409);
        const data = { quantity: new Prisma.Decimal(line.quantity), status: 'Active', releasedAt: null,
          requestFingerprint: supplierFingerprint({ kind, contractId, lineId: line.id, demandId, quantity: line.quantity }) };
        if (existing) await tx.purchaseDemandAllocation.update({ where: { id: existing.id }, data });
        else await tx.purchaseDemandAllocation.create({ data: { id: `PDA_${randomUUID()}`, requestKey: `supplier:${kind}:${contractId}:${line.id}`, demandId,
          purchaseOrderId: kind === 'purchase' ? contractId : null, purchaseLineId: kind === 'purchase' ? line.id : null,
          outsourcingOrderId: kind === 'processing' ? contractId : null, outsourcingLineId: kind === 'processing' ? line.id : null,
          createdBy: ownerId, createdAt: BigInt(Date.now()), ...data } });
      }
      const updated = await tx.procurementDemand.update({ where: { id: demandId }, data: { revision: { increment: 1 }, updatedAt: BigInt(Date.now()) } });
      revision = updated.revision;
    }
    for (const line of own) line.demandRevision = revision;
  }
  return { ...draft, lines };
}
