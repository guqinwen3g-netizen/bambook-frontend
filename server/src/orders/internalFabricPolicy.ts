import { Prisma } from '@prisma/client';
import { parseOrderQuantity } from '../shared/orderQuantitySummary';
import { businessError } from '../shared/errorCodes';

/** Planning metres are Decimal(18,4), with no implicit conversion or rounding. */
export function internalMetres(value: unknown): Prisma.Decimal {
  try { return new Prisma.Decimal(parseOrderQuantity(value)); }
  catch { throw businessError('INVALID_INPUT', '米数须为大于零的精确十进制，最多四位小数。'); }
}

export type GarmentFulfillmentMode = 'cmt' | 'trims_cmt' | 'full_package';
export type GarmentFulfillment = { fulfillmentMode: GarmentFulfillmentMode; cmtIncludedItems: string[] };
export function normalizeGarmentFulfillment(input: { fulfillmentMode?: unknown; cmtIncludedItems?: unknown }): GarmentFulfillment {
  if (!['cmt', 'trims_cmt', 'full_package'].includes(String(input.fulfillmentMode)))
    throw businessError('INVALID_INPUT', '请选择成衣条目的履约模式；历史未知值不能推定为 CMT。');
  if (!Array.isArray(input.cmtIncludedItems) || input.cmtIncludedItems.length > 64)
    throw businessError('INVALID_INPUT', '请明确 CMT 包含项目；无包含项也须明确保存空列表。');
  const items = input.cmtIncludedItems.map((value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
      throw businessError('INVALID_INPUT', 'CMT 包含项目须为明确的简短文字。');
    return value.trim();
  });
  if (new Set(items).size !== items.length) throw businessError('INVALID_INPUT', 'CMT 包含项目不能重复。');
  return { fulfillmentMode: input.fulfillmentMode as GarmentFulfillmentMode, cmtIncludedItems: items };
}

export function assertAllocationCapacity(quantity: unknown, allocations: readonly unknown[]): Prisma.Decimal {
  const total = internalMetres(quantity);
  const used = allocations.reduce<Prisma.Decimal>((sum, value) => sum.plus(internalMetres(value)), new Prisma.Decimal(0));
  if (used.gt(total)) throw businessError('CONFLICT', '累计分配米数超过内部面料行数量，请核对余量。');
  return total.minus(used);
}
