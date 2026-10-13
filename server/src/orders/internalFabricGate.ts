import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { normalizeOrderQuantityUnit } from '../shared/orderQuantitySummary';
import { isBusinessError } from '../shared/errorCodes';
import { currentInternalDemand, orderBusinessFamily } from './internalOrderFacts';
import { assertAllocationCapacity, normalizeGarmentFulfillment } from './internalFabricPolicy';

export type GarmentMaterialProof = {
  schemaVersion: 1;
  fulfillmentMode: 'cmt' | 'trims_cmt' | 'full_package';
  cmtIncludedItems: string[];
  allocation: null | { id: string; revision: number; metres: string; auditId: string; fabricOrderId: string;
    fabricOrderLineId: string; fabricLineQuantity: string; approvalId: string; internalPurpose: string;
    internalDemandTeamId: string; internalReceiverId: string };
};
const fail = (message: string): never => { throw new DevelopmentDomainError('CONFLICT', message); };

/** Shared PP/production gate. This reads planning facts, never stock or fabric completion. */
export async function resolveGarmentMaterialProof(db: any, order: any, line: any): Promise<GarmentMaterialProof | null> {
  if (String(order.businessLine || order.type || '').trim().toLowerCase() !== 'garment') return null;
  try {
    const fulfillment = normalizeGarmentFulfillment(line);
    const base: GarmentMaterialProof = { schemaVersion: 1, ...fulfillment, allocation: null };
    if (fulfillment.fulfillmentMode !== 'full_package') return base;
    const row = await db.fabricLineAllocation.findUnique({ where: { garmentOrderLineId: line.id } });
    if (!row || row.status !== 'active' || row.garmentOrderId !== order.id) fail('全包条目进 PP 前须明确有效内部面料行及分配米数。');
    const sourceOrder = await db.order.findFirst({ where: { id: row.fabricOrderId, deletedAt: null } });
    const sourceLine = await db.orderLine.findUnique({ where: { id: row.fabricOrderLineId } });
    if (!sourceOrder || !sourceLine || sourceLine.orderId !== sourceOrder.id || sourceOrder.orderPurpose !== 'internal_fabric_supply'
      || orderBusinessFamily(sourceOrder) !== 'fabric' || ['Pending', 'Cancelled', 'Archived'].includes(sourceOrder.status))
      fail('内部面料供给单或准确条目已失效。');
    if (normalizeOrderQuantityUnit(sourceLine.unit) !== 'M') fail('内部面料行必须有明确米数单位，不能自动换算。');
    const demand = await currentInternalDemand(db, sourceOrder);
    const approval = await db.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: sourceOrder.id, status: 'approved' }, orderBy: { decidedAt: 'desc' } });
    if (!approval) fail('内部面料单尚无真实主单审批通过依据。');
    const allocations = await db.fabricLineAllocation.findMany({ where: { fabricOrderLineId: sourceLine.id, status: 'active' } });
    assertAllocationCapacity(sourceLine.quantity.toString(), allocations.map((a: any) => a.metres.toString()));
    const audit = await db.auditLog.findUnique({ where: { id: row.auditId } });
    const after = audit?.detail?.after;
    if (!audit || audit.action !== 'allocate_internal_fabric' || audit.targetType !== 'FabricLineAllocation' || audit.targetId !== row.id
      || after?.revision !== row.revision || after?.status !== 'active' || after?.metres !== row.metres.toString()
      || after?.fabricOrderLineId !== row.fabricOrderLineId || after?.garmentOrderLineId !== line.id)
      fail('内部面料分配缺少准确有效审计依据。');
    return { ...base, allocation: { id: row.id, revision: row.revision, metres: row.metres.toString(), auditId: row.auditId,
      fabricOrderId: sourceOrder.id, fabricOrderLineId: sourceLine.id, fabricLineQuantity: sourceLine.quantity.toString(), approvalId: approval.id,
      internalPurpose: demand.purpose, internalDemandTeamId: demand.team.id, internalReceiverId: demand.receiver.id } };
  } catch (error) {
    if (isBusinessError(error)) fail(typeof error.message === 'string' ? error.message : '内部材料依据无法核验。');
    throw error;
  }
}
