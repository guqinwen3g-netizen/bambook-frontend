import { lineAmount, mistMoneyMinor, type MistOrderLine } from '../../../../server/src/shared/mistWorkspace';

type AmountLine = Pick<MistOrderLine, 'qty' | 'price'>;
export type OrderLineAmount = { amount: number | null; error: string };
export type OrderMoneyTotal = { total: number | null; cents: number | null; error: string };

/** Keep received totals and remaining balances on the same integer-cent basis. */
export function sumOrderMoney(values: readonly number[]): OrderMoneyTotal {
  try {
    const cents = values.reduce((sum, value) => sum + mistMoneyMinor(value), 0);
    if (!Number.isSafeInteger(cents)) throw new Error('总金额超出支持范围');
    return { total: cents / 100, cents, error: '' };
  } catch (problem) {
    return { total: null, cents: null, error: problem instanceof Error ? problem.message : '金额无效' };
  }
}

/** Match server order recalculation: round each line, then sum integer cents. */
export function orderAmounts(lines: readonly AmountLine[]) {
  const items: OrderLineAmount[] = lines.map(line => {
    try {
      if (!Number.isFinite(line.qty) || line.qty <= 0) throw new Error('数量须为大于零的有效数值');
      const amount = lineAmount(line.qty, line.price);
      mistMoneyMinor(amount);
      return { amount, error: '' };
    } catch (problem) {
      return { amount: null, error: problem instanceof Error ? problem.message : '数量或单价无效' };
    }
  });
  const invalidIndex = items.findIndex(item => item.error);
  const sum = sumOrderMoney(items.flatMap(item => item.amount === null ? [] : [item.amount]));
  const error = !lines.length ? '请至少添加一个订单条目' : invalidIndex >= 0 ? `条目 ${invalidIndex + 1}：${items[invalidIndex].error}` : sum.error;
  return { items, total: error ? null : sum.total, cents: error ? null : sum.cents, error };
}

export function formatOrderQuantity(qty: number) {
  return Number.isFinite(qty) ? qty.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
}
