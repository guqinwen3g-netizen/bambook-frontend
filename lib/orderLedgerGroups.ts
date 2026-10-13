import type { Order, OrderLineItem } from '../types';
import { orderAmountOf } from '../server/src/shared/orderAmount';

export type OrderLedgerView = 'orders' | 'items';
export type OrderLedgerSort = { key: 'customer' | 'amount' | 'dueDate'; dir: 'asc' | 'desc' };

/** Header dates are only inherited when a line has no independent Ex-mill. */
export function orderLineExMillDate(item: OrderLineItem): string {
  return item.exMillDate || item.order.clientDate || item.order.dueDate || '';
}

export function compareLedgerItems(a: OrderLineItem, b: OrderLineItem, sort: OrderLedgerSort): number {
  const factor = sort.dir === 'asc' ? 1 : -1;
  if (sort.key === 'amount') return (a.amount - b.amount) * factor;
  if (sort.key === 'customer') return (a.customer || '').localeCompare(b.customer || '', 'zh-CN') * factor;
  const left = orderLineExMillDate(a), right = orderLineExMillDate(b);
  if (!left) return right ? 1 : 0;
  if (!right) return -1;
  return left.localeCompare(right) * factor;
}

export interface OrderLedgerGroup {
  order: Order;
  items: OrderLineItem[];
  matchedLineIds: Set<string>;
  quantities: Array<{ unit: string; quantity: number }>;
  amount: number;
  dueDate: string;
  lastDueDate: string;
  undatedItemCount: number;
}

/** Filtering selects parent orders; their complete, correctly numbered lines
 * remain together. Commercial totals always use the complete source order. */
export function groupOrderLedger(allItems: OrderLineItem[], matchedItems: OrderLineItem[], sort: OrderLedgerSort | null): OrderLedgerGroup[] {
  const selectedIds = new Set(matchedItems.map(item => item.order.id));
  const matchedLineIds = new Set(matchedItems.map(item => item.id));
  const grouped = new Map<string, OrderLedgerGroup>();
  for (const item of allItems) {
    const order = item.order;
    if (!selectedIds.has(order.id)) continue;
    let group = grouped.get(order.id);
    if (!group) {
      group = { order, items: [], matchedLineIds: new Set(), quantities: [], amount: orderAmountOf(order), dueDate: '', lastDueDate: '', undatedItemCount: 0 };
      grouped.set(order.id, group);
    }
    group.items.push(item);
    if (matchedLineIds.has(item.id)) group.matchedLineIds.add(item.id);
  }
  const groups = [...grouped.values()];
  for (const group of groups) {
    group.items.sort((a, b) => a.lineNumber - b.lineNumber);
    const quantities = new Map<string, number>();
    for (const item of group.items) {
      const unit = item.unit || group.order.unit || '';
      // 接口 Decimal 可能以字符串到达；不转数值会被拼接成 "02600"
      const qty = Number(item.quantity);
      quantities.set(unit, (quantities.get(unit) || 0) + (Number.isFinite(qty) ? qty : 0));
    }
    group.quantities = [...quantities].map(([unit, quantity]) => ({ unit, quantity }));
    const dates = group.items.map(orderLineExMillDate).filter(Boolean).sort();
    group.dueDate = dates[0] || '';
    group.lastDueDate = dates[dates.length - 1] || '';
    group.undatedItemCount = group.items.length - dates.length;
  }
  if (sort) groups.sort((a, b) => {
    const factor = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === 'amount') return (a.amount - b.amount) * factor;
    if (sort.key === 'customer') return (a.order.customer || '').localeCompare(b.order.customer || '', 'zh-CN') * factor;
    if (!a.dueDate) return b.dueDate ? 1 : 0;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate) * factor;
  });
  return groups;
}
