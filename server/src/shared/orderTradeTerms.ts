/** Shared order trade vocabulary. Dates retain their own milestone semantics. */
import { extractIncotermCode, KNOWN_INCOTERMS } from '../_shared/incoterm';
export const ORDER_INCOTERMS = KNOWN_INCOTERMS.filter(code => !['DAT', 'DES', 'DEQ', 'DAF'].includes(code));
export type OrderIncoterm = typeof ORDER_INCOTERMS[number];
export function orderIncoterm(value: unknown): OrderIncoterm | null {
  if (typeof value !== 'string') return null;
  const code = extractIncotermCode(value);
  return KNOWN_INCOTERMS.includes(code as OrderIncoterm) ? code as OrderIncoterm : null;
}
export function sellerArrangesOrderTransport(value: unknown): boolean {
  const code = orderIncoterm(value);
  return !!code && ['CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'DAT', 'DES', 'DEQ', 'DAF'].includes(code);
}
export function orderTradePlace(order: Record<string, unknown>): string {
  if (typeof order.deliveryPlace === 'string' && order.deliveryPlace.trim()) return order.deliveryPlace.trim();
  if (!orderIncoterm(order.deliveryTerms) || typeof order.deliveryTerms !== 'string') return '';
  return order.deliveryTerms.trim().replace(/^[A-Za-z]{3}[\s,.]*/, '').trim();
}
/** Retain the existing full contract expression consumed by invoices/customs. */
export function normalizeOrderTradePatch(patch: Record<string, unknown>, current: Record<string, unknown> = {}): Record<string, unknown> {
  // dueDate is the legacy Ex-mill alias, never a contract delivery/arrival promise.
  if (Object.prototype.hasOwnProperty.call(patch, 'clientDate') || Object.prototype.hasOwnProperty.call(patch, 'dueDate')) {
    const exMill = Object.prototype.hasOwnProperty.call(patch, 'clientDate') ? patch.clientDate : patch.dueDate;
    patch = { ...patch, clientDate: exMill || null, dueDate: exMill || '' };
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'deliveryTerms') && !Object.prototype.hasOwnProperty.call(patch, 'deliveryPlace')) return patch;
  const merged = { ...current, ...patch }, code = orderIncoterm(merged.deliveryTerms);
  if (!code) return patch;
  const place = Object.prototype.hasOwnProperty.call(patch, 'deliveryPlace') ? String(patch.deliveryPlace ?? '').trim() : orderTradePlace(merged);
  return { ...patch, deliveryTerms: [code, place].filter(Boolean).join(' '), deliveryPlace: place || null };
}
export function orderDeliveryMilestone(value: unknown): { label: string; placeLabel: string } {
  const code = orderIncoterm(value);
  if (code === 'EXW') return { label: '约定备妥日期', placeLabel: '备货地点' };
  if (['FCA', 'CPT', 'CIP'].includes(code ?? '')) return { label: '约定交承运人日期', placeLabel: '交承运人地点' };
  if (code === 'FAS') return { label: '约定船边交货日期', placeLabel: '装运港 / 船边交货点' };
  if (['FOB', 'CFR', 'CIF'].includes(code ?? '')) return { label: '约定装船日期', placeLabel: '装运港' };
  if (code === 'DPU') return { label: '约定卸货完成日期', placeLabel: '卸货地点' };
  if (['DAP', 'DDP'].includes(code ?? '')) return { label: '约定送达日期', placeLabel: '交货地点' };
  return { label: '合同约定交货日期', placeLabel: '合同交货地点' };
}
export function orderTradePlaceLabel(value: unknown): string {
  const code = orderIncoterm(value);
  if (['CFR', 'CIF'].includes(code ?? '')) return '目的港';
  if (['CPT', 'CIP'].includes(code ?? '')) return '运输目的地';
  return orderDeliveryMilestone(value).placeLabel;
}
export function orderTradeFieldVisible(key: string, order: Record<string, unknown>): boolean {
  if (['deliveryTerms', 'deliveryPlace', 'contractDeliveryDate', 'agreedDeliveryDate', 'deliveryAgreementBasis', 'expectedArrivalDate', 'agreedArrivalDate'].includes(key)
    && typeof order.orderPurpose === 'string' && order.orderPurpose.startsWith('internal_')) return false;
  if (['deliveryPlace', 'contractDeliveryDate', 'agreedDeliveryDate', 'deliveryAgreementBasis'].includes(key)) return !!orderIncoterm(order.deliveryTerms) || !!order[key];
  // C terms name a destination, while the actual delivery occurs at origin.
  if (key === 'agreedArrivalDate') return !['DAP', 'DPU', 'DDP'].includes(orderIncoterm(order.deliveryTerms) ?? '') || !!order.agreedArrivalDate;
  return true;
}
export function orderTradeTermsError(order: Record<string, unknown>): string | null {
  if (order.deliveryTerms != null && order.deliveryTerms !== '' && !orderIncoterm(order.deliveryTerms)) return '请选择有效的贸易条款。';
  for (const key of ['deliveryPlace']) if (order[key] != null && typeof order[key] !== 'string') return '贸易地点格式不正确。';
  for (const key of ['contractDeliveryDate', 'expectedArrivalDate', 'agreedArrivalDate', 'productionDate', 'clientDate']) {
    const value = order[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string') return '日期格式不正确。';
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return '请填写有效的日期。';
    if (['contractDeliveryDate', 'expectedArrivalDate', 'agreedArrivalDate'].includes(key)
      && typeof order.clientDate === 'string' && order.clientDate && value < order.clientDate) return '合同交货或到达日期不能早于出厂交期。';
  }
  if (typeof order.productionDate === 'string' && order.productionDate && typeof order.clientDate === 'string' && order.clientDate && order.productionDate > order.clientDate) return '生产交期不能晚于出厂交期。';
  return null;
}
export function orderLineDeliveryError(order: Record<string, unknown>, line: Record<string, unknown>, requireCommitment = false): string | null {
  const override = line.agreedDeliveryDate;
  if (line.deliveryAgreementBasis != null && typeof line.deliveryAgreementBasis !== 'string') return '条目交期约定依据格式不正确。';
  if (override && (typeof line.deliveryAgreementBasis !== 'string' || !line.deliveryAgreementBasis.trim())) return '请填写条目单独交期的客户约定依据。';
  if (!override && line.deliveryAgreementBasis) return '请填写对应的条目单独约定交货日期。';
  const internal = typeof order.orderPurpose === 'string' && order.orderPurpose.startsWith('internal_');
  if (requireCommitment && !internal && !override && !order.contractDeliveryDate) return '请填写主单合同交货日期，或本条目的单独约定交货日期。';
  return orderTradeTermsError({ ...order, contractDeliveryDate: override || order.contractDeliveryDate,
    clientDate: line.exMillDate ?? order.clientDate, productionDate: line.deliveryDate ?? order.productionDate });
}
