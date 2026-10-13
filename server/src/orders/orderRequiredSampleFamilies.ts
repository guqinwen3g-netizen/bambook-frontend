import type { OrderSampleFamily } from '../samples/orderSampleSourceContract';

const ORDERED_FAMILIES: Record<'garment' | 'fabric', readonly OrderSampleFamily[]> = {
  garment: ['garment_pp', 'garment_ship'],
  fabric: ['fabric_eps', 'fabric_ss', 'fabric_rc'],
};

export class RequiredSampleFamiliesError extends Error {
  readonly code = 'INVALID_INPUT';
  constructor(message: string) { super(message); this.name = 'RequiredSampleFamiliesError'; }
}

export function orderLineBusinessLine(order: { businessLine?: unknown; type?: unknown }): 'garment' | 'fabric' {
  const value = String(order.businessLine ?? order.type ?? '').trim().toLowerCase();
  if (['garment', 'apparel', 'clothing', '成衣', '服装'].includes(value)) return 'garment';
  if (['fabric', '面料'].includes(value)) return 'fabric';
  throw new RequiredSampleFamiliesError('订单业务板块无法明确识别为成衣或面料。');
}

/** New lines always freeze mandatory sample gates. Fabric RC is the only
 * optional family and is included only when the business explicitly selects it.
 * null is deliberately not a creation default: it remains historical/unknown.
 */
export function normalizeRequiredSampleFamilies(order: { businessLine?: unknown; type?: unknown }, input?: unknown): OrderSampleFamily[] {
  const line = orderLineBusinessLine(order);
  const mandatory: readonly OrderSampleFamily[] = line === 'garment'
    ? ['garment_pp', 'garment_ship'] : ['fabric_eps', 'fabric_ss'];
  const permitted = ORDERED_FAMILIES[line];
  const requested = input === undefined ? [...mandatory] : input;
  if (!Array.isArray(requested) || requested.some(value => typeof value !== 'string')) {
    throw new RequiredSampleFamiliesError('必需样品族须为明确的字符串数组。');
  }
  const values = requested as string[];
  if (new Set(values).size !== values.length) throw new RequiredSampleFamiliesError('必需样品族不能重复。');
  if (mandatory.some(value => !values.includes(value))) throw new RequiredSampleFamiliesError('订单行缺少该业务板块的必需样品族。');
  if (values.some(value => !permitted.includes(value as OrderSampleFamily))) throw new RequiredSampleFamiliesError('订单行包含不适用于该业务板块的样品族。');
  return permitted.filter(value => values.includes(value));
}

/** Historical rows remain explicitly unknown; malformed JSON is not guessed. */
export function readRequiredSampleFamilies(value: unknown, order: { businessLine?: unknown; type?: unknown }): OrderSampleFamily[] | null {
  if (value == null) return null;
  try { return normalizeRequiredSampleFamilies(order, value); }
  catch { return null; }
}
