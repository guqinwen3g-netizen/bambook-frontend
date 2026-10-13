import type { PrismaClient } from '@prisma/client';
import { hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { isShipmentVisible, resolveVisibleOrderIds, isOrderLinkedVisible } from '../auth/orderVisibility';
import type { ActorContext } from '../agent/types';
import { toolActorToken } from '../agent/toolActorContext';
import { graphReadScope, graphSource, STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES } from './entityAccessDeclarations';
import { createTeamShareService } from '../teams/teamShareService';

// Do not echo arbitrary graph metadata, source strings, or EntityReference
// snapshots into model output. Only canonical document identifiers are labels.
const KNOWN_LINK_KINDS = new Set(['orderedBy', 'suppliedBy', 'shipsTo', 'billTo', 'handledBy', 'merchandisedBy', 'supervisedBy', 'developFor', 'developBy', 'aboutProduct', 'aboutMaterial', 'aboutGarment', 'belongsTo', 'aboutOrder', 'settlesInvoice', 'settlesVoucher', 'paysVoucher', 'shipsVia', 'forOrder', 'fromBom', 'fromQuotation', 'clearsShipment', 'declaredFor', 'refundsDeclaration', 'refundTo', 'creditOpenedBy', 'quotedFor', 'convertedToOrder', 'opportunityFor', 'forPurchaseOrder', 'stockedAs', 'outsourcedTo', 'movesItem', 'inWarehouse', 'referencesDocument', 'purchasedFrom', 'producedFor', 'manufacturedBy']);
const resourceModels: Record<string, { model: string; label: string; linkedOrder?: boolean }> = {
  product: { model: 'productAsset', label: 'sku' },
  'development-case': { model: 'developmentCase', label: 'code' },
  invoice: { model: 'invoice', label: 'invoiceNumber' },
  paymentVoucher: { model: 'paymentVoucher', label: 'voucherNumber' },
  fxSettlement: { model: 'fxSettlement', label: 'settlementNumber' },
  outwardRemittance: { model: 'outwardRemittance', label: 'remittanceNumber' },
  vatInvoice: { model: 'vatInvoice', label: 'vatNumber' },
  purchaseOrder: { model: 'purchaseOrder', label: 'poNumber', linkedOrder: true },
  bom: { model: 'bOM', label: 'bomNumber', linkedOrder: true },
  customsDeclaration: { model: 'customsDeclaration', label: 'declarationNumber', linkedOrder: true },
  taxRefund: { model: 'taxRefund', label: 'refundNumber', linkedOrder: true },
  letterOfCredit: { model: 'letterOfCredit', label: 'lcNumber', linkedOrder: true },
  quotation: { model: 'quotation', label: 'quotationNumber' },
  warehouse: { model: 'warehouse', label: 'code' },
};

/** Scope + row visibility are checked on both graph endpoints. This service is
 * deliberately read-only. Finance resources retain their human resource-read
 * contract, but expose identifiers only; relation reads reuse the human V2
 * normal/confidential boundary. Order-linked operational rows reuse the same
 * order visibility resolver as their human APIs, including shipment allocations.
 * Unknown types remain a tracked capability gap, not a V1-completeness claim. */
export function createAgentLinksService(prisma: PrismaClient, actor: ActorContext) {
  const token = toolActorToken(actor);
  const cache = new Map<string, Promise<{ label: string } | null>>();
  const unknownReferenceIds = new Map<string, string>();
  let orderIds: Promise<string[] | null> | undefined;
  const visibleOrders = () => orderIds ??= resolveVisibleOrderIds(prisma, token);

  async function validOrderParent(orderId: string): Promise<boolean> {
    if (!isOrderLinkedVisible(await visibleOrders(), orderId)) return false;
    return Boolean(await prisma.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } }));
  }
  async function lookup(type: string, id: string, ancestors: ReadonlySet<string>): Promise<{ label: string } | null> {
    const scope = graphReadScope(type);
    if (!scope || !id || !hasScope(token, scope)) return null;
    try {
      if (type === 'order') {
        const where = await buildOrderListScopeWhere(prisma, token);
        const row = await prisma.order.findFirst({ where: { id, deletedAt: null, ...where }, select: { id: true, poNumber: true } });
        return row ? { label: row.poNumber || row.id } : null;
      }
      if (type === 'orderLine') {
        const row = await prisma.orderLine.findUnique({ where: { id }, select: { id: true, orderId: true, lineNumber: true } });
        if (!row || !await endpoint('order', row.orderId, ancestors)) return null;
        return { label: `line ${row.lineNumber}` };
      }
      if (type.startsWith('relation.')) {
        const { createRelationServiceV2 } = await import('../relations/relationServiceV2');
        const result = await createRelationServiceV2(prisma).getRelation(token, id);
        return result.ok ? { label: result.data.code || result.data.id } : null;
      }
      if (type === 'shipment') {
        const row = await prisma.shipment.findFirst({ where: { id, deletedAt: null }, select: { id: true, orderId: true, shipmentNumber: true } });
        return row && await isShipmentVisible(prisma, await visibleOrders(), row) ? { label: row.shipmentNumber } : null;
      }
      if (type === 'opportunity') {
        const row = await prisma.opportunity.findFirst({ where: { id, deletedAt: null }, select: { id: true, relationId: true } });
        if (!row?.relationId) return null;
        // CRM business rows use L2 followed/shared customer visibility. The L1
        // normal-library relations:read gate cannot authorize business access.
        const relation = await prisma.relation.findFirst({ where: { id: row.relationId, deletedAt: null }, select: { id: true } });
        if (!relation || !await createTeamShareService(prisma).hasBizReadAccess(token, row.relationId)) return null;
        return { label: row.id }; // Never model-output arbitrary title or amount.
      }
      if (type === 'materialReceipt') {
        // This immutable receipt model has no deletedAt or direct orderId.
        const row = await prisma.materialReceipt.findUnique({ where: { id }, select: { id: true, receiptNumber: true, purchaseOrderId: true } });
        if (!row || !await endpoint('purchaseOrder', row.purchaseOrderId, ancestors)) return null;
        return { label: row.receiptNumber || row.id };
      }
      if (type === 'productionStage') {
        const row = await prisma.productionStage.findUnique({ where: { id }, select: { id: true, orderId: true, stageKey: true } });
        if (!row?.orderId || !await validOrderParent(row.orderId)) return null;
        // Direct reads avoid getProductionBoard's historical stage-initialization writes.
        return { label: row.stageKey || row.id };
      }
      if(type==='inventoryTransfer'){const row=await prisma.inventoryTransfer.findUnique({where:{id},select:{id:true,sourceItemId:true}});if(!row||!await endpoint('inventoryItem',row.sourceItemId,ancestors))return null;return {label:row.id};}
      if (type === 'inventoryItem') {
        const row = await prisma.inventoryItem.findFirst({ where: { id, deletedAt: null }, select: { id: true, materialCode: true, orderId: true } });
        // General/unassigned stock is not private by assumption. An actual
        // order anchor must pass current order visibility and existence.
        if (!row || (row.orderId && !await validOrderParent(row.orderId))) return null;
        return { label: row.materialCode || row.id };
      }
      if (type === 'outsourcingOrder') {
        const row = await prisma.outsourcingOrder.findFirst({ where: { id, deletedAt: null }, select: { id: true, orderNumber: true, orderId: true } });
        if (!row || (row.orderId && !await validOrderParent(row.orderId))) return null;
        return { label: row.orderNumber || row.id };
      }
      if (type === 'stockMovement') {
        // StockMovement is immutable and has no deletedAt. Its actual item and
        // known business document are separate row boundaries, not input claims.
        const row = await prisma.stockMovement.findUnique({ where: { id }, select: { id: true, movementNumber: true, itemId: true, referenceType: true, referenceId: true } });
        if (!row || !await endpoint('inventoryItem', row.itemId, ancestors)) return null;
        const referenceType = Object.prototype.hasOwnProperty.call(STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES, row.referenceType || '') ? STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES[row.referenceType!] : undefined;
        if (referenceType && (!row.referenceId || !await endpoint(referenceType, row.referenceId, ancestors))) return null;
        if (!referenceType && row.referenceId) unknownReferenceIds.set(row.id, row.referenceId);
        return { label: row.movementNumber || row.id };
      }
      const resource = resourceModels[type];
      if (!resource) return null;
      const row = await (prisma as any)[resource.model].findFirst({ where: { id, deletedAt: null }, select: { id: true, [resource.label]: true, ...(resource.linkedOrder ? { orderId: true } : {}) } });
      if (!row || (resource.linkedOrder && !isOrderLinkedVisible(await visibleOrders(), row.orderId))) return null;
      return { label: String(row[resource.label] || row.id) };
    } catch {
      // Resolver/storage failures cannot disclose a row or recover an old role.
      return null;
    }
  }
  function endpoint(type: string, id: string, ancestors: ReadonlySet<string> = new Set()): Promise<{ label: string } | null> {
    const key = JSON.stringify([type, id]);
    // Corrupt Transfer cycles cannot wait forever on their own cached Promise.
    if (ancestors.has(key)) return Promise.resolve(null);
    if (!cache.has(key)) cache.set(key, lookup(type, id, new Set([...ancestors, key])));
    return cache.get(key)!;
  }
  async function visibleLinks(input: Record<string, unknown>) {
    const source = graphSource(input);
    if (!source) return { ok: false as const, reason: 'TYPE_AND_ID_REQUIRED' };
    if (!await endpoint(source.type, source.id)) return { ok: false as const, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' };
    const numericLimit = Number(input.limit || 100);
    const limit = Number.isFinite(numericLimit) ? Math.max(1, Math.min(Math.floor(numericLimit), 500)) : 100;
    const where: any = { status: 'active', deletedAt: null };
    if (source.direction === 'both') where.OR = [{ fromType: source.type, fromId: source.id }, { toType: source.type, toId: source.id }];
    else if (source.direction === 'out') { where.fromType = source.type; where.fromId = source.id; if (input.toType) where.toType = String(input.toType); }
    else { where.toType = source.type; where.toId = source.id; if (input.fromType) where.fromType = String(input.fromType); }
    if (input.linkKind) where.linkKind = String(input.linkKind);
    const rows = await prisma.entityLink.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit });
    const links: Array<{ direction: 'out' | 'in'; linkKind: string; otherType: string; otherId: string; label: string; updatedAt: number }> = [];
    for (const row of rows) {
      const direction = row.fromType === source.type && row.fromId === source.id ? 'out' : 'in';
      // Guard even when a storage adapter incorrectly ignores the source filter.
      if (direction === 'in' && (row.toType !== source.type || row.toId !== source.id)) continue;
      const otherType = direction === 'out' ? row.toType : row.fromType;
      const otherId = direction === 'out' ? row.toId : row.fromId;
      if (row.fromType === 'stockMovement' && unknownReferenceIds.get(row.fromId) === row.toId) continue;
      const other = await endpoint(otherType, otherId);
      if (!other) continue;
      if (row.fromType === 'stockMovement' && unknownReferenceIds.get(row.fromId) === row.toId) continue;
      links.push({ direction, linkKind: KNOWN_LINK_KINDS.has(row.linkKind) ? row.linkKind : 'related', otherType, otherId, label: other.label, updatedAt: Number(row.updatedAt) });
    }
    return { ok: true as const, source, links };
  }
  async function query(input: Record<string, unknown>) {
    const result = await visibleLinks(input);
    return result.ok ? { ok: true, total: result.links.length, links: result.links } : result;
  }
  async function expand(input: Record<string, unknown>) {
    // This registered tool's contract is the bidirectional {type,id} shape.
    if (!input.type || !input.id) return { ok: false, reason: 'TYPE_AND_ID_REQUIRED' };
    const result = await visibleLinks({ ...input, limit: input.limit ?? 200 });
    if (!result.ok) return result;
    const neighbors: Record<string, Array<any>> = {};
    for (const link of result.links) (neighbors[link.linkKind] ??= []).push({ direction: link.direction, type: link.otherType, id: link.otherId, label: link.label, updatedAt: link.updatedAt });
    return { ok: true, type: result.source.type, id: result.source.id, total: result.links.length, neighbors };
  }
  return { query, expand };
}
