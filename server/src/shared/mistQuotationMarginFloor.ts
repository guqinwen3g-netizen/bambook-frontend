/** BB-QUO-3：按板块（面料 / 成衣）的最低毛利率底价线。毛利率 = (单价 − 成本) / 单价。
 *  参数带版本与生效日，只有管理层（pricing:admin）可设；报价保存时把适用版本冻结到条目，之后改参数不影响已保存报价。 */
export type MarginFloorFamily = 'fabric' | 'garment';
export const MARGIN_FLOOR_FAMILY_LABEL: Record<MarginFloorFamily, string> = { fabric: '面料', garment: '成衣' };
export type QuoteMarginFloor = { id: string; family: MarginFloorFamily; version: number; minMarginPercent: string; effectiveFrom: string; reason: string; createdAt: string; createdBy: string; createdById: string };
export type FrozenMarginFloor = Pick<QuoteMarginFloor, 'id' | 'family' | 'version' | 'minMarginPercent' | 'effectiveFrom'>;

/** 0 ≤ x < 100，最多两位小数；返回规范文本或 null。 */
export function normalizeMarginPercent(value: unknown): string | null {
  const t = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  return t.replace(/^0+(?=\d)/, '');
}
/** 某板块在某业务日适用的版本：生效日 ≤ 当日中最晚生效的，同日取版本号最大者。 */
export function applicableMarginFloor(floors: readonly QuoteMarginFloor[] | undefined, family: MarginFloorFamily, day: string): QuoteMarginFloor | undefined {
  let best: QuoteMarginFloor | undefined;
  for (const f of floors || []) if (f.family === family && f.effectiveFrom <= day && (!best || f.effectiveFrom > best.effectiveFrom || (f.effectiveFrom === best.effectiveFrom && f.version > best.version))) best = f;
  return best;
}
export function freezeMarginFloor(f: QuoteMarginFloor): FrozenMarginFloor { return { id: f.id, family: f.family, version: f.version, minMarginPercent: f.minMarginPercent, effectiveFrom: f.effectiveFrom }; }
export function marginFloorText(f: FrozenMarginFloor) { return `${MARGIN_FLOOR_FAMILY_LABEL[f.family]}最低毛利率 ${f.minMarginPercent}%（V${f.version}，${f.effectiveFrom} 起生效）`; }

function scaled(v: string | undefined): bigint | null { const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec((v || '').trim()); return m ? BigInt(m[1]) * BigInt(10000) + BigInt((m[2] || '').padEnd(4, '0') || '0') : null; }
/** 条目毛利率（两位小数，四舍五入）；单价或成本缺失 / 单价为 0 时为 null。 */
export function quoteLineMarginPercent(price: string, cost: string): string | null {
  const p = scaled(price), c = scaled(cost);
  if (p === null || c === null || p === BigInt(0) || !cost?.trim()) return null;
  const diff = p - c, neg = diff < BigInt(0), abs = neg ? -diff : diff;
  const bp = (abs * BigInt(10000) * BigInt(2) + p) / (p * BigInt(2)); // 万分之一，四舍五入
  const s = bp.toString().padStart(3, '0');
  return (neg && bp > BigInt(0) ? '-' : '') + s.slice(0, -2) + '.' + s.slice(-2);
}
/** 精确比较：(p − c) / p < min% ⇔ (p − c) × 10000 < min(万分之一) × p。 */
export function lineBelowMarginFloor(line: { price: string; cost: string; marginFloor?: FrozenMarginFloor }): boolean {
  const f = line.marginFloor; if (!f) return false;
  const p = scaled(line.price), c = scaled(line.cost), min = scaled(f.minMarginPercent);
  if (p === null || c === null || min === null || p === BigInt(0) || !line.cost?.trim()) return false;
  return (p - c) * BigInt(10000) * BigInt(100) < min * p;
}
