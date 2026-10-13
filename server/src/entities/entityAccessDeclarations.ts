import type { PermissionScope } from '../_shared/rolePermissionMatrix';

/** Actual graph type names from entities/sync.ts, not the search registry's
 * aliases. Scope truth: human routes plus VIEW_TO_MAIN_SCOPES Inventory/MES
 * (orders:read / production:read). Their legacy authenticate-only GET routes
 * still need the same row/sensitive-field contract; graph restoration does not
 * certify those HTTP routes. Unknown types have no wildcard disclosure grant. */
export const GRAPH_ENTITY_READ_SCOPES: Readonly<Record<string, PermissionScope>> = Object.freeze({
  order: 'orders:read', orderLine: 'orders:read',
  product: 'products:read', 'development-case': 'products:read',
  'relation.organization': 'relations:read', 'relation.person': 'relations:read', 'relation.contact': 'relations:read',
  invoice: 'invoices:read', paymentVoucher: 'vouchers:read',
  fxSettlement: 'remit:read', outwardRemittance: 'remit:read', vatInvoice: 'vat:read',
  shipment: 'shipments:read', purchaseOrder: 'procurement:read', bom: 'bom:read',
  customsDeclaration: 'customs:read', taxRefund: 'customs:read', letterOfCredit: 'customs:read',
  quotation: 'quotations:read', opportunity: 'crm:read',
  materialReceipt: 'procurement:read', productionStage: 'production:read',
  inventoryTransfer: 'orders:read', inventoryItem: 'orders:read', stockMovement: 'orders:read', warehouse: 'orders:read',
  outsourcingOrder: 'production:read',
});

/** Known polymorphic document anchors emitted by syncStockMovementReferences.
 * Manual/Adjustment and future unknown reference types are not document grants.
 * Adding a sync type requires an explicit scope and row contract here. */
export const STOCK_MOVEMENT_GRAPH_REFERENCE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  PurchaseOrder: 'purchaseOrder', MaterialReceipt: 'materialReceipt',
  Order: 'order', Shipment: 'shipment', ProductionStage: 'productionStage', Transfer: 'stockMovement', InventoryTransfer:'inventoryTransfer',
});

export function graphReadScope(type: string): PermissionScope | undefined {
  return Object.prototype.hasOwnProperty.call(GRAPH_ENTITY_READ_SCOPES, type) ? GRAPH_ENTITY_READ_SCOPES[type] : undefined;
}

export function graphSource(input: Record<string, unknown>): { type: string; id: string; direction: 'both' | 'out' | 'in' } | null {
  for (const [typeKey, idKey, direction] of [['type', 'id', 'both'], ['fromType', 'fromId', 'out'], ['toType', 'toId', 'in']] as const) {
    const type = String(input[typeKey] || '').trim();
    const id = String(input[idKey] || '').trim();
    if (type && id) return { type, id, direction };
  }
  return null;
}
