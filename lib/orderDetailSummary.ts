import type { Order, OrderLineItem, OrderLineLite } from '../types';
import type { FieldMeta } from './orderSchema';
import { isManualItemField } from './manualOrderEntry';
import { flattenOrderLines } from './orderLineItems';
import { formatYmd } from './dateFormat';
import { orderAmountOrNull } from '../server/src/shared/orderAmount';

/** Canonicalize only the domain label at the UI boundary, preserving the complete raw DTO. */
export function normalizeOrderDetailType(order: Order): Order {
  const type = String(order.type).toLowerCase();
  const canonical = type === 'fabric' ? 'Fabric' : type === 'garment' ? 'Garment' : type === 'other' ? 'Other' : order.type;
  return canonical === order.type ? order : { ...order, type: canonical as Order['type'] };
}

/** Detail scopes only contain persisted lines; the ledger's legacy placeholder is not an item. */
export function realOrderDetailLines(order: Order): OrderLineItem[] {
  return order.lines?.length ? flattenOrderLines([order]) : [];
}

/** Header projections of the first product must not become whole-order specifications or edits. */
export function isOrderMainDetailField(field: FieldMeta): boolean {
  return !isManualItemField(field) && !['productionBatch', 'referenceBatch', 'dueDate'].includes(String(field.key));
}

function dateRange(dates: Array<string | null | undefined>) {
  const recorded = dates.map(formatYmd).filter(Boolean).sort();
  return { first: recorded[0] || '', last: recorded.at(-1) || '', undatedCount: dates.length - recorded.length };
}

export function orderDetailSummary(order: Order) {
  const lines = realOrderDetailLines(order);
  const quantities = new Map<string, number>();
  for (const line of order.lines || []) {
    // Read stored quantities, not the ledger projection's zero fallback.
    if (line.quantity == null || String(line.quantity).trim() === '') continue;
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity)) continue;
    // Missing units stay unknown; never borrow the first line's header unit.
    const unit = line.unit || '';
    quantities.set(unit, Number(((quantities.get(unit) || 0) + quantity).toFixed(4)));
  }
  return {
    lines,
    quantities: [...quantities].map(([unit, quantity]) => ({ unit, quantity })),
    amount: orderAmountOrNull(order),
    exMill: dateRange(lines.map(line => line.exMillDate)),
    delivery: dateRange(lines.map(line => line.agreedDeliveryDate || order.contractDeliveryDate)),
  };
}

/** A line with no own price/net amount is unknown; a whole-order quote cannot price each line. */
export function orderDetailLineAmount(line: Pick<OrderLineLite, 'netValue' | 'unitPrice' | 'quantity'>): number | undefined {
  const numeric = (value: unknown) => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return undefined;
    const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined;
  };
  const net = numeric(line.netValue);
  if (net !== undefined) return net;
  const price = numeric(line.unitPrice), quantity = numeric(line.quantity);
  return price !== undefined && quantity !== undefined ? price * quantity : undefined;
}
