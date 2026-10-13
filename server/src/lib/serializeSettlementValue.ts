import { Prisma } from '@prisma/client';

/** Financial facts retain Decimal(18,4) precision; callers must not round them
 * through Number or depend on a process-global BigInt prototype patch. */
export function serializeSettlementValue(value: unknown): any {
  if (value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serializeSettlementValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeSettlementValue(item)]));
  return value;
}
