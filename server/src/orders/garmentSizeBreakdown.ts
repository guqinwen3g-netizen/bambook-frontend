import { parseOrderQuantity } from '../shared/orderQuantitySummary';

export class GarmentSizeBreakdownError extends Error {
  constructor(message: string) { super(message); this.name = 'GarmentSizeBreakdownError'; }
}

/** Canonical order-line size matrix: every configured size is a non-negative
 * safe integer and the matrix total must exactly equal the contract quantity. */
export function normalizeGarmentSizeBreakdown(value: unknown, quantity: unknown): Record<string, number> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new GarmentSizeBreakdownError('成衣尺码数量必须是“尺码: 数量”的对象。');
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return null;
  const normalized: Array<[string, number]> = [], seen = new Set<string>();
  let total = BigInt(0);
  for (const [rawSize, rawQuantity] of entries) {
    const size = rawSize.trim();
    if (!size) throw new GarmentSizeBreakdownError('尺码名称不能为空。');
    if (seen.has(size)) throw new GarmentSizeBreakdownError(`尺码“${size}”重复，请合并为一行。`);
    if (typeof rawQuantity !== 'number' || !Number.isSafeInteger(rawQuantity) || rawQuantity < 0)
      throw new GarmentSizeBreakdownError(`尺码“${size}”数量必须是非负整数。`);
    seen.add(size); normalized.push([size, rawQuantity]); total += BigInt(rawQuantity);
  }
  const contractQuantity = parseOrderQuantity(quantity, { allowZero: true });
  if (contractQuantity !== total.toString())
    throw new GarmentSizeBreakdownError(`尺码数量合计 ${total} 必须等于订单条目数量 ${contractQuantity}。`);
  return Object.fromEntries(normalized);
}
