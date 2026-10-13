import type { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from './service';
import { hasScope, createPermissionService } from './permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { isShipmentVisible } from './orderVisibility';
import { createTeamShareService } from '../teams/teamShareService';
import { STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES } from '../entities/entityAccessDeclarations';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';

/** Inventory/MES read contract: VIEW_TO_MAIN_SCOPES (orders:read / production:read),
 * §10.4.2 order-linked business visibility, and C4 general stock without an order.
 * Filters are passed into the real query BEFORE pagination/count/aggregation.
 * Parent links here are snapshot ids, not invented Prisma FK relations. This is
 * read-only; it never initializes production stages or writes projections. */
export function createOperationalReadAccess(prisma: PrismaClient, actor: TokenPayload | null | undefined, developmentRead = false) {
  const scopeAllowed = (scope: PermissionScope) => hasScope(actor, scope) || (!actor?.userId && developmentRead);
  let orders: Promise<{ ids: string[]; unrestricted: boolean }> | undefined;
  const currentOrders = () => orders ??= (async () => {
    if (!actor?.userId && !developmentRead) return { ids: [], unrestricted: false };
    const scope = await buildOrderListScopeWhere(prisma, actor, { fresh: true });
    const rows = await prisma.order.findMany({ where: { AND: [{ deletedAt: null }, scope] }, select: { id: true } });
    return { ids: rows.map(row => row.id), unrestricted: Object.keys(scope).length === 0 };
  })();
  async function orderWhere(allowUnassigned = false): Promise<Record<string, unknown>> {
    if (!actor?.userId && !developmentRead) return { id: { in: [] } };
    const { ids } = await currentOrders();
    return allowUnassigned ? { OR: [{ orderId: null }, { orderId: { in: ids } }] } : { orderId: { in: ids } };
  }
  async function canReadOrder(id: string): Promise<boolean> {
    return Boolean(id) && (await currentOrders()).ids.includes(id);
  }
  async function canReadInventoryItem(id: string): Promise<boolean> {
    if (!actor?.userId && !developmentRead) return false;
    const row = await prisma.inventoryItem.findFirst({ where: { id, deletedAt: null }, select: { id: true, orderId: true } });
    return Boolean(row && (!row.orderId || await canReadOrder(row.orderId)));
  }
  async function productionPlanWhere(): Promise<Prisma.ProductionPlanWhereInput> {
    return { AND: [{ deletedAt: null }, await orderWhere(true)] };
  }
  let planIds: Promise<string[]> | undefined;
  const visiblePlanIds = () => planIds ??= (async () => {
    const rows = await prisma.productionPlan.findMany({ where: await productionPlanWhere(), select: { id: true } });
    return rows.map(row => row.id);
  })();
  async function workHourWhere(): Promise<Prisma.WorkHourWhereInput> {
    return { productionPlanId: { in: await visiblePlanIds() } };
  }
  async function pieceRateWhere(): Promise<Prisma.PieceRateRecordWhereInput> {
    return { OR: [{ productionPlanId: null }, { productionPlanId: { in: await visiblePlanIds() } }] };
  }
  async function colorBatchWhere(): Promise<Prisma.SampleColorBatchWhereInput> {
    const { ids } = await currentOrders();
    const branches: Prisma.SampleColorBatchWhereInput[] = [{ stage: 'bulk', developmentCaseId: null, orderId: { in: ids } }];
    if (scopeAllowed('products:read')) {
      // Lab dips inherit a real customer-linked case, not the case's free-text owner.
      const resolver = !actor?.userId && developmentRead ? { rule: { kind: 'all' as const } } : await createPermissionService({ prisma }).getDataScopeResolver(actor, 'relations');
      // relations.kind=all may be merely L1 directory access (sales write:self).
      // L2 business-wide access follows the existing TeamShare write/all decision.
      const allBusinessCustomers = resolveWriteKind(resolver.rule) === 'all';
      const customerIds = allBusinessCustomers ? null : await createTeamShareService(prisma).resolveVisibleRelationIds(actor!);
      const relations = await prisma.relation.findMany({ where: { deletedAt: null, ...(customerIds ? { id: { in: customerIds } } : {}) }, select: { id: true } });
      const customerWhere = allBusinessCustomers
        ? { OR: [{ customerRelationId: null }, { customerRelationId: { in: relations.map(row => row.id) } }] }
        : { customerRelationId: { in: relations.map(row => row.id) } };
      const cases = await prisma.developmentCase.findMany({ where: { deletedAt: null, ...customerWhere }, select: { id: true } });
      branches.push({ stage: 'lab_dip', orderId: null, developmentCaseId: { in: cases.map(row => row.id) } });
    }
    return { OR: branches };
  }

  const referenceCache = new Map<string, Promise<boolean>>();
  async function referenceVisible(type: string, id: string): Promise<boolean> {
    const key = JSON.stringify([type, id]);
    if (!referenceCache.has(key)) referenceCache.set(key, (async () => {
      if(type==='InventoryTransfer'){const row=await prisma.inventoryTransfer.findUnique({where:{id},select:{sourceItemId:true}});return Boolean(row&&await canReadInventoryItem(row.sourceItemId));}
      if (type === 'Order') return scopeAllowed('orders:read') && canReadOrder(id);
      if (type === 'PurchaseOrder') {
        if (!scopeAllowed('procurement:read')) return false;
        const row = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, select: { orderId: true } });
        return Boolean(row && (row.orderId ? await canReadOrder(row.orderId) : (await currentOrders()).unrestricted));
      }
      if (type === 'MaterialReceipt') {
        if (!scopeAllowed('procurement:read')) return false;
        const row = await prisma.materialReceipt.findUnique({ where: { id }, select: { purchaseOrderId: true } });
        return Boolean(row && await referenceVisible('PurchaseOrder', row.purchaseOrderId));
      }
      if (type === 'Shipment') {
        if (!scopeAllowed('shipments:read')) return false;
        const row = await prisma.shipment.findFirst({ where: { id, deletedAt: null }, select: { id: true, orderId: true } });
        const { ids, unrestricted } = await currentOrders();
        return Boolean(row && await isShipmentVisible(prisma, unrestricted ? null : ids, row));
      }
      if (type === 'ProductionStage') {
        if (!scopeAllowed('production:read')) return false;
        const row = await prisma.productionStage.findUnique({ where: { id }, select: { orderId: true } });
        return Boolean(row && await canReadOrder(row.orderId));
      }
      return false;
    })());
    return referenceCache.get(key)!;
  }
  let movements: Promise<Prisma.StockMovementWhereInput> | undefined;
  // Older L8 producers wrote receipt IDs under PurchaseOrder. Only their
  // exact native source marker may follow the real receipt's PO parent; an
  // arbitrary/missing reference must never gain visibility through a guess.
  async function legacyReceiptMovementVisible(row: {
    referenceType: string | null; referenceId: string | null; notes: string | null; warehouseId: string;
  }): Promise<boolean> {
    if (row.referenceType !== 'PurchaseOrder' || !row.referenceId || !row.notes?.startsWith('L8-source:')
      || !scopeAllowed('procurement:read')) return false;
    let marker: any;
    try { marker = JSON.parse(row.notes.slice('L8-source:'.length)); } catch { return false; }
    if (!marker || marker.receiptId !== row.referenceId || marker.warehouseId !== row.warehouseId
      || typeof marker.warehouseId !== 'string' || !marker.warehouseId
      || typeof marker.lineId !== 'string' || !marker.lineId) return false;
    // A colliding PO ID is ambiguous, including a deleted PO. Do not reinterpret it.
    if (await prisma.purchaseOrder.findUnique({ where: { id: row.referenceId }, select: { id: true } })) return false;
    const receipt = await prisma.materialReceipt.findUnique({ where: { id: row.referenceId }, select: { purchaseOrderId: true } });
    if (!receipt) return false;
    const line = await prisma.purchaseLine.findFirst({
      where: { id: marker.lineId, purchaseOrderId: receipt.purchaseOrderId }, select: { id: true },
    });
    return Boolean(line && await referenceVisible('MaterialReceipt', row.referenceId));
  }
  async function stockMovementWhere(): Promise<Prisma.StockMovementWhereInput> {
    return movements ??= (async () => {
      // Only minimal identifiers are read to resolve polymorphic document gates.
      // Resolve the complete allowed set before the service applies its page/count.
      // Transfer ancestry is checked without recursive cached-Promise deadlocks.
      const rows = await prisma.stockMovement.findMany({
        where: { item: { is: { AND: [{ deletedAt: null }, await orderWhere(true)] } } },
        select: { id: true, referenceType: true, referenceId: true, notes: true, warehouseId: true },
      });
      const byId = new Map(rows.map(row => [row.id, row]));
      const allowed = new Map<string, boolean>();
      async function visible(id: string, ancestors: ReadonlySet<string>): Promise<boolean> {
        if (ancestors.has(id)) return false;
        if (allowed.has(id)) return allowed.get(id)!;
        const row = byId.get(id);
        if (!row) return false;
        const known = Object.prototype.hasOwnProperty.call(STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES, row.referenceType || '');
        const legacyReceiptMarker = row.referenceType === 'PurchaseOrder' && row.notes?.startsWith('L8-source:');
        const result = legacyReceiptMarker ? await legacyReceiptMovementVisible(row) : !known || Boolean(row.referenceId && (row.referenceType === 'Transfer'
          ? await visible(row.referenceId, new Set([...ancestors, id]))
          : await referenceVisible(row.referenceType!, row.referenceId)));
        allowed.set(id, result);
        return result;
      }
      const ids: string[] = [];
      for (const row of rows) if (await visible(row.id, new Set())) ids.push(row.id);
      return { id: { in: ids } };
    })();
  }
  async function ownershipHistoryWhere(): Promise<Record<string, unknown>> {
    const { ids } = await currentOrders();
    return { AND: ['fromOrderId', 'toOrderId'].map(field => ({ OR: [{ [field]: null }, { [field]: { in: ids } }] })) };
  }
  return { orderWhere, canReadOrder, canReadInventoryItem, productionPlanWhere, workHourWhere, pieceRateWhere, colorBatchWhere, stockMovementWhere, ownershipHistoryWhere };
}

export function canReadPieceRatePay(actor: TokenPayload | null | undefined): boolean {
  return hasScope(actor, 'hr:salary:read') && hasScope(actor, 'sensitive:salary');
}

const COST_FIELDS = new Set(['unitCost', 'unitPrice', 'amount', 'totalAmount', 'value']);
const SALARY_FIELDS = new Set(['ratePerUnit', 'amount', 'totalAmount', 'pendingAmount', 'confirmedAmount', 'paidAmount']);
/** Null means withheld/unknown, never a fabricated zero. Decimal/BigInt values
 * retain their serialization contract and source storage objects are untouched. */
export function maskOperationalRead<T>(value: T, actor: TokenPayload | null | undefined, kind: 'cost' | 'salary' = 'cost'): T {
  const permitted = kind === 'salary' ? canReadPieceRatePay(actor) : hasScope(actor, 'sensitive:cost');
  const fields = kind === 'salary' ? SALARY_FIELDS : COST_FIELDS;
  const visit = (input: any): any => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return input;
    const output: Record<string, any> = {};
    for (const [key, child] of Object.entries(input)) output[key] = !permitted && fields.has(key) ? null : visit(child);
    // Unknown polymorphic references have no resource contract; don't disclose ids.
    if ('referenceType' in output && !Object.prototype.hasOwnProperty.call(STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES, output.referenceType || '')) output.referenceId = null;
    return output;
  };
  return visit(value);
}
