import { Prisma } from '@prisma/client';

/** Comparisons retain model precision; display ratios must not decide the gate. */
export function compareMoqQuantity(quantity: unknown, unit: unknown, threshold: unknown, thresholdUnit: unknown):
  { resolved: true; compliant: boolean; quantityInThresholdDimension: string; thresholdInDimension: string; gapPct: number }
  | { resolved: false; reason: string } {
  const decimal = (value: unknown): Prisma.Decimal | null => {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Prisma.Decimal)) return null;
    const text = String(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const result = new Prisma.Decimal(text);
    return result.isFinite() && result.gt(0) ? result : null;
  };
  const normalize = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const token = value.trim().toUpperCase();
    return token === 'PCS' ? 'PC' : token;
  };
  const scaled = (value: Prisma.Decimal): { integer: bigint; scale: bigint } => {
    const [whole, fraction = ''] = value.toFixed().split('.');
    return { integer: BigInt(whole + fraction), scale: BigInt(10) ** BigInt(fraction.length) };
  };
  const gap = (actual: bigint, minimum: bigint) => actual >= minimum ? 0 : Number(((minimum - actual) * BigInt(1000) + minimum / BigInt(2)) / minimum) / 10;
  const qty = decimal(quantity), limit = decimal(threshold);
  const from = normalize(unit), to = normalize(thresholdUnit);
  if (!qty || !limit) return { resolved: false, reason: '数量或 MOQ 阈值缺少有效正数依据' };
  if (!from || !to) return { resolved: false, reason: '数量或 MOQ 阈值缺少单位依据' };
  // A configured threshold in the same actual unit is authoritative. Never
  // infer PC/SET contents or mass/length conversions from business family.
  if (from === to) { const q = scaled(qty), m = scaled(limit); const actual = q.integer * m.scale, minimum = m.integer * q.scale; return { resolved: true, compliant: actual >= minimum, quantityInThresholdDimension: qty.toString(), thresholdInDimension: limit.toString(), gapPct: gap(actual, minimum) }; }
  if ((from === 'M' || from === 'YD') && (to === 'M' || to === 'YD')) {
    const q = scaled(qty), m = scaled(limit);
    const qFactor = from === 'YD' ? BigInt(9144) : BigInt(10000), mFactor = to === 'YD' ? BigInt(9144) : BigInt(10000);
    const actual = q.integer * qFactor * m.scale, minimum = m.integer * mFactor * q.scale;
    const compliant = actual >= minimum;
    return { resolved: true, compliant, quantityInThresholdDimension: `${qty.toFixed()} ${from}`, thresholdInDimension: `${limit.toFixed()} ${to}`, gapPct: gap(actual, minimum) };
  }
  return { resolved: false, reason: '数量与 MOQ 阈值的单位维度无法核对' };
}
