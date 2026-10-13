import { displayItemNo } from '../server/src/shared/orderItemNo';
export { displayItemNo } from '../server/src/shared/orderItemNo';
import type { Order, OrderLineItem, OrderLineLite, OrderLineStatus } from '../types';
// ★ S4 任务3：造明细行的 netValue —— 原写法 `contractAmount ?? quoteAmount` 不在真源次序里
import { orderAmountOf } from '../server/src/shared/orderAmount';

const DEFAULT_STATUS: OrderLineStatus = 'Pending';

/** Manual due dates come from the visible agreed delivery fields. A hidden
 * creation-day default must not override a later entered ex-mill date. */
export function manualOrderDueDate(draft: Partial<Order>): string {
  return draft.clientDate || '';
}

/** The manual one-item form explicitly records its agreed sales amount.
 * Persist that input to the new line; reading legacy orders still follows
 * orderAmountOf and never treats a header contract amount as a line value. */
export function manualInitialLineNetValue(draft: Partial<Order>): number | undefined {
  const amount: unknown = draft.contractAmount;
  if (amount == null || amount === '') return undefined;
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw Error('销售合同金额须为非负有限数值，请核对后重试');
  return value;
}

/** Only entered, finite values may drive the agreement preview. Clearing a
 * price/amount clears its derived counterpart; an absent price is not zero. */
export function linkOrderAgreementAmounts(prev: Partial<Order>, patch: Partial<Order>): Partial<Order> {
  const next = { ...prev, ...patch };
  const entered = (value: unknown): number | undefined => {
    if (value == null || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const quantity = entered(next.quantity);
  const hasPrice = 'salesPrice' in patch, hasAmount = 'contractAmount' in patch;
  const price = entered(next.salesPrice), amount = entered(next.contractAmount);
  const round2 = (number: number) => Math.round(number * 100) / 100;
  if (hasPrice && !hasAmount && price === undefined) next.contractAmount = undefined;
  else if (hasAmount && !hasPrice && amount === undefined) next.salesPrice = undefined;
  else if (quantity !== undefined && quantity > 0) {
    if (hasPrice && !hasAmount) next.contractAmount = round2(price! * quantity);
    else if (hasAmount && !hasPrice) next.salesPrice = round2(amount! / quantity);
    else if ('quantity' in patch && !hasPrice && !hasAmount) {
      next.contractAmount = price === undefined ? undefined : round2(price * quantity);
    }
  }
  return next;
}


export function getNextItemNo(existing: Array<string | null | undefined>): string {
  const mainNumbers = existing
    .map(normalizeSequencedItemNo)
    .filter((v): v is string => v != null)
    .filter((v) => /^\d{4}$/.test(v))
    .map((v) => Math.floor(Number(v) / 10) * 10);
  const next = mainNumbers.length === 0 ? 10 : Math.max(...mainNumbers) + 10;
  return String(next).padStart(4, '0');
}

function normalizeSequencedItemNo(itemNo: string | null | undefined): string | null {
  const raw = String(itemNo ?? '').trim();
  if (!raw) return null;
  return displayItemNo(raw);
}

// Prisma Decimal values may arrive as strings even though the UI DTO is numeric.
// Normalize only the derived display values; retain the stored line fields for editing.
function displayNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string' || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function flattenOrderLines(orders: Order[]): OrderLineItem[] {
  const items: OrderLineItem[] = [];
  for (const order of orders) {
    if (order.deletedAt) continue;
    const lines = order.lines && order.lines.length > 0
      ? [...order.lines].sort((a, b) => (a.lineNumber || 0) - (b.lineNumber || 0))
      : [fallbackLine(order)];

    for (const line of lines) {
      const poNumber = order.poNumber || order.id;
      const lineSeq = Number.isFinite(line.lineNumber) && line.lineNumber > 0 ? line.lineNumber : 1;
      const displayNo = displayItemNo(line.itemNo || String(lineSeq * 10));
      const quantity = displayNumber(line.quantity) ?? 0;
      const price = displayNumber(line.unitPrice);
      const amount =
        displayNumber(line.netValue) ??
        (price !== undefined
          ? price * quantity
          : order.quoteAmount);
      const status = line.status || order.status || DEFAULT_STATUS;
      items.push({
        ...line,
        order,
        orderId: line.orderId || order.id,
        poNumber,
        customer: order.customer,
        poDate: order.poDate,
        salesCurrency: order.salesCurrency,
        displayItemNo: displayNo,
        displayId: `PO ${poNumber} / ${displayNo}`,
        quantity,
        amount: amount ?? 0,
        status,
      });
    }
  }
  return items;
}

function fallbackLine(order: Order): OrderLineLite {
  return {
    id: `${order.id}__L001`,
    orderId: order.id,
    lineNumber: 1,
    itemNo: '0010',
    materialCode: order.clientCode ?? null,
    millQuality: order.productColorCode ?? null,
    description: order.product || order.fabricContent || null,
    width: order.width ?? null,
    exMillDate: order.clientDate || order.dueDate || null,
    deliveryDate: order.productionDate ?? null,
    quantity: order.quantity ?? 0,
    unit: 'Meter',
    unitPrice: order.salesPrice ?? null,
    netValue: orderAmountOf(order) || null,
    cloth: order.fabricContent ?? null,
    weight: order.gsm ?? null,
    status: order.status,
  };
}
