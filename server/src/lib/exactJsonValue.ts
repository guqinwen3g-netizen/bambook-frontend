import { Prisma } from '@prisma/client';

/** Normalize native facts before JSON.stringify invokes application-wide
 * toJSON overrides. Amounts, quantities and versions must remain exact.
 * Keep JSON object omissions, array nulls and date behavior unchanged. */
export function exactJsonValue(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(exactJsonValue);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') {
      const serialized = value.toJSON();
      if (serialized !== value) return exactJsonValue(serialized);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exactJsonValue(item)]));
  }
  return value;
}
