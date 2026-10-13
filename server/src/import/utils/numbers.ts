/**
 * Parse a number written in European convention:
 *   - "."  is the thousands separator
 *   - ","  is the decimal separator
 *
 * Examples:
 *   "3.600,00"    -> 3600
 *   "103.680,00"  -> 103680
 *   "8,10"        -> 8.1
 *   "1.000.000,5" -> 1000000.5
 *   "42930"       -> 42930
 *
 * Returns NaN on garbage.
 */
export function parseEuropeanNumber(input: string): number {
  if (typeof input !== 'string') return NaN;
  const trimmed = input.trim();
  if (!/^[0-9.,]+$/.test(trimmed)) return NaN;
  const normalized = trimmed.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}
