/** Decimal(18,4) comparisons without binary rounding or an unknown-to-zero fallback. */
export function settlementAmountUnits(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d{1,14}(?:\.\d{1,4})?$/.test(text)) return null;
  const [integer, fraction = ''] = text.split('.');
  return BigInt(integer) * 10000n + BigInt(fraction.padEnd(4, '0'));
}
