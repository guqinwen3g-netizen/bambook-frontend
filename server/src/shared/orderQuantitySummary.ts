import { normalizeLengthUnit } from '../lib/unitConversion';
export type OrderQuantityUnit = 'M' | 'YD' | 'KG' | 'G' | 'PC' | 'SET' | 'ROLL' | 'DOZEN';
export type OrderQuantitySummaryState = 'single_unit' | 'mixed_units' | 'unresolved' | 'legacy_unit_unrecorded';
export class OrderQuantityError extends Error {
  constructor(public readonly code: 'INVALID_QUANTITY' | 'QUANTITY_OVERFLOW', message: string) { super(message); this.name = 'OrderQuantityError'; }
}
const SCALE = BigInt(10000), ZERO = BigInt(0), MAX = BigInt('999999999999999999'), SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const invalid = (message: string): never => { throw new OrderQuantityError('INVALID_QUANTITY', message); };
const overflow = (): never => { throw new OrderQuantityError('QUANTITY_OVERFLOW', '数量超出 Decimal(18,4) 可表示范围。'); };
function canonical(value: bigint): string {
  const whole = (value / SCALE).toString(), fraction = (value % SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
function scaled(value: unknown, allowZero: boolean): bigint {
  const numeric = typeof value === 'number';
  if (typeof value !== 'string' && !numeric) invalid('数量须为十进制字符串或安全数值，不能转换空值或其他类型。');
  if (numeric && !Number.isFinite(value as number)) invalid('数量须为有限数值。');
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (text.length > 256 || !/^\d+(?:\.\d{1,4})?$/.test(text)) invalid('数量须为非负十进制，最多四位小数，不能使用指数或舍入。');
  const [rawWhole, fraction = ''] = text.split('.'), whole = rawWhole.replace(/^0+/, '') || '0';
  if (whole.length > 14) overflow();
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
  if (result > MAX) overflow();
  if (!allowZero && result === ZERO) invalid('业务数量必须大于零。');
  // Do not round binary arithmetic to make an unsafe Number appear exact.
  if (numeric && (result > SAFE || !Number.isSafeInteger((value as number) * Number(SCALE))
    || BigInt((value as number) * Number(SCALE)) !== result || Number(canonical(result)) !== value))
    invalid('数值无法准确表示四位定点数量，请改用十进制字符串。');
  return result;
}
/** Positive business input by default; summary zero requires an explicit option. */
export function parseOrderQuantity(value: unknown, options: { allowZero?: boolean } = {}): string { return canonical(scaled(value, options.allowZero === true)); }
const ALIASES: Readonly<Record<string, OrderQuantityUnit>> = Object.freeze({
  kg: 'KG', kilogram: 'KG', kilograms: 'KG', '公斤': 'KG', '千克': 'KG', g: 'G', gram: 'G', grams: 'G', '克': 'G',
  pc: 'PC', pcs: 'PC', piece: 'PC', pieces: 'PC', '件': 'PC', set: 'SET', sets: 'SET', '套': 'SET',
  roll: 'ROLL', rolls: 'ROLL', '卷': 'ROLL', dozen: 'DOZEN', dozens: 'DOZEN', '打': 'DOZEN',
});
/** Alias normalization only, never conversions or business-type unit guesses. */
export function normalizeOrderQuantityUnit(value: unknown): OrderQuantityUnit | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const length = normalizeLengthUnit(value);
  if (length === 'M' || length === 'YD') return length;
  const alias = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALIASES, alias) ? ALIASES[alias] : null;
}
export type OrderQuantitySummary = Readonly<{
  version: 1; state: OrderQuantitySummaryState; quantity: string | null; unit: OrderQuantityUnit | null;
  groups: readonly Readonly<{ unit: OrderQuantityUnit; quantity: string }>[]; markedPartial: boolean;
  /** Display-only historical number, not a usable physical total. */
  legacyQuantity: string | null;
}>;
function summary(state: OrderQuantitySummaryState, groups: { unit: OrderQuantityUnit; quantity: string }[], markedPartial: boolean, legacyQuantity: string | null = null): OrderQuantitySummary {
  const single = state === 'single_unit' ? groups[0] : null;
  return Object.freeze({ version: 1 as const, state, quantity: single?.quantity ?? null, unit: single?.unit ?? null,
    groups: Object.freeze(groups.map(group => Object.freeze(group))), markedPartial, legacyQuantity });
}
/** Caller supplies actual active lines; no filtering, mutation, or object coercion. */
export function summarizeOrderQuantity(input: { activeOrderLines: readonly { quantity: unknown; unit: unknown }[]; legacyQuantity?: unknown; legacyUnit?: unknown }): OrderQuantitySummary {
  if (!input || !Array.isArray(input.activeOrderLines)) invalid('请提供实际有效订单行。');
  if (!input.activeOrderLines.length) {
    if (input.legacyQuantity === undefined || input.legacyQuantity === null) return summary('unresolved', [], true);
    const quantity = parseOrderQuantity(input.legacyQuantity, { allowZero: true }), unit = normalizeOrderQuantityUnit(input.legacyUnit);
    return unit ? summary('single_unit', [{ unit, quantity }], false) : summary('legacy_unit_unrecorded', [], true, quantity);
  }
  const totals = new Map<OrderQuantityUnit, bigint>(); let partial = false;
  for (const line of input.activeOrderLines) {
    if (!line || typeof line !== 'object') invalid('订单行原件不完整。');
    const quantity = scaled(line.quantity, true), unit = normalizeOrderQuantityUnit(line.unit);
    if (!unit) { partial = true; continue; }
    const total = (totals.get(unit) ?? ZERO) + quantity;
    if (total > MAX) overflow();
    totals.set(unit, total);
  }
  const groups = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([unit, quantity]) => ({ unit, quantity: canonical(quantity) }));
  return summary(partial ? 'unresolved' : groups.length === 1 ? 'single_unit' : 'mixed_units', groups, partial);
}
