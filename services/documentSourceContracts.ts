import type { DocumentSetData, DocumentSetLine } from '../types';
type ExactFields<T, K extends keyof T> = Omit<T, K> & { [P in K]: string | null };
export type SourceDocumentSetData = Omit<DocumentSetData, 'shipment' | 'lines' | 'totals' | 'customs' | 'extras'> & {
  shipment: ExactFields<DocumentSetData['shipment'], 'grossWeight' | 'netWeight' | 'volume'>;
  lines: Array<ExactFields<DocumentSetLine, 'quantity' | 'unitPrice' | 'amount' | 'grossWeight' | 'netWeight' | 'volume'> & {
    shipmentLineId: string; orderId: string | null; orderLineId: string | null; productionBatchIds: string[]; cartonItems: unknown[];
  }>;
  totals: ExactFields<DocumentSetData['totals'], 'quantity' | 'amount' | 'grossWeight' | 'netWeight' | 'volume'>;
  customs: ExactFields<NonNullable<DocumentSetData['customs']>, 'totalValue'> | null;
  extras: Omit<DocumentSetData['extras'], 'insurance'> & { insurance: ExactFields<DocumentSetData['extras']['insurance'], 'insuredAmount' | 'premium'> };
  orders: Array<{ id: string; orderNumber: string | null; poNumber: string | null; currency: string | null; deliveryTerms: string | null; paymentTerms: string | null }>;
  cartons: unknown[];
  source: { schemaVersion: 1; fingerprint: string; orderIds: string[]; kind: 'legacy' | 'physical' | 'claim'; cartonCoverageComplete: boolean };
};
export interface ShipmentCiSources {
  schemaVersion: 1; shipmentId: string; expectedShipmentSourceFingerprint: string; orderIds: string[];
  candidates: Array<{ sourceInvoiceId: string; invoiceNumber: string; status: string; amount: string; currency: string;
    canRegister: boolean; expectedSourceFingerprint: string; orderIds: string[]; shipmentIds: string[] }>;
}
export interface ShipmentDocumentSourceBinding {
  sourceInvoiceId?: string; expectedSourceFingerprint?: string; expectedShipmentSourceFingerprint?: string;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const decimal = (v: unknown) => v === null || typeof v === 'string' && /^-?\d+(\.\d{1,4})?$/.test(v);
export function parseShipmentCiSources(data: unknown, shipmentId: string): ShipmentCiSources {
  const d = data as ShipmentCiSources;
  if (!d || d.schemaVersion !== 1 || d.shipmentId !== shipmentId || !text(d.expectedShipmentSourceFingerprint)
    || !strings(d.orderIds) || !Array.isArray(d.candidates) || d.candidates.some(c => !text(c.sourceInvoiceId) || !text(c.invoiceNumber)
      || !text(c.status) || !text(c.currency) || typeof c.amount !== 'string' || !decimal(c.amount) || typeof c.canRegister !== 'boolean'
      || !text(c.expectedSourceFingerprint) || !strings(c.orderIds) || !strings(c.shipmentIds) || !c.shipmentIds.includes(shipmentId))
    || new Set(d.candidates.map(c => c.sourceInvoiceId)).size !== d.candidates.length) throw new Error('原运单发票来源响应不完整，请重新读取。');
  return d;
}
export function parseSourceDocumentSet(data: unknown, shipmentId: string): SourceDocumentSetData {
  const d = data as SourceDocumentSetData;
  if (!d || d.shipment?.id !== shipmentId || d.source?.schemaVersion !== 1 || !text(d.source.fingerprint) || !strings(d.source.orderIds)
    || !Array.isArray(d.lines) || !d.totals || !d.extras?.insurance || !Array.isArray(d.orders) || !Array.isArray(d.missing)
    || ['quantity', 'amount', 'grossWeight', 'netWeight', 'volume'].some(k => !decimal(d.totals[k as keyof typeof d.totals]))
    || d.lines.some(l => !text(l.shipmentLineId) || ['quantity', 'unitPrice', 'amount', 'grossWeight', 'netWeight', 'volume'].some(k => !decimal(l[k as keyof typeof l]))))
    throw new Error('原运单制单来源响应不完整，请重新读取。');
  return d;
}
/** Exact source text, with four native decimals retained and no Number round-trip. */
export function formatSourceAmount(value: string | null | undefined): string | null {
  if (value == null || !/^-?\d+(\.\d{1,4})?$/.test(value)) return null;
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const tail = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${tail}`;
}
