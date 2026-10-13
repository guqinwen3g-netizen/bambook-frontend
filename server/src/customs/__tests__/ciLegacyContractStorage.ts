/** Explicit old-test source adaptation. The stored rows are synthetic storage,
 * not PostgreSQL/approval evidence. Current auth, L2, source and registration
 * helpers execute unchanged; no owner role or guessed financial copy is used. */
import { actor as storedActor, decimal, storage } from './documentSourceStorage';
import { readCiInvoiceSource, registerCanonicalCi } from '../ciInvoiceSource';

export const ciActor = { ...storedActor, userId: 'user_1', permissionCeiling: [...storedActor.permissions!] };
export function createCiStorage(options: { invoiceId?: string; invoiceNumber?: string; amount?: string; currency?: string } = {}) {
  const s = storage();
  const replacements: Record<string, string> = { u: 'user_1', O: 'ord_1', R: 'rel_1', S: 'shp_1', INV: options.invoiceId ?? 'INV_NATIVE' };
  const rename = (value: any): any => {
    if (typeof value === 'string') return replacements[value] ?? value;
    if (Array.isArray(value)) return value.map(rename);
    if (value && typeof value === 'object' && !(typeof value.toFixed === 'function')) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, rename(v)]));
    return value;
  };
  for (const name of Object.keys(s.tables)) s.tables[name] = rename(s.tables[name]);
  const currency = options.currency ?? 'USD', amount = options.amount ?? '12345.67';
  Object.assign(s.tables.invoice[0], { invoiceNumber: options.invoiceNumber ?? 'FIN-NATIVE-001', amount: decimal(amount), currency, customerName: 'ACME LTD' });
  s.tables.invoiceOrderAllocation[0].allocatedAmount = decimal(amount);
  s.tables.order[0].currency = currency; s.tables.orderShipmentBatch[0].currency = currency;
  Object.assign(s.tables.shipment[0], { status: 'Booked', portOfLoading: 'SHANGHAI', portOfDischarge: 'HAMBURG' });
  return s;
}
export async function currentCiOptions(s: ReturnType<typeof createCiStorage>) {
  const input = { trustedActor: ciActor, sourceInvoiceId: s.tables.invoice[0].id, shipmentId: 'shp_1', mode: 'register' as const };
  const original = await readCiInvoiceSource(s.db, input);
  return { trustedActor: ciActor, sourceInvoiceId: original.invoice.id, shipmentId: 'shp_1',
    expectedSourceFingerprint: original.fingerprint, expectedShipmentSourceFingerprint: original.shipmentSources.find(row => row.shipment.id === 'shp_1')!.fingerprint };
}
export async function originalCi(s: ReturnType<typeof createCiStorage>) {
  return registerCanonicalCi(s.db, { ...await currentCiOptions(s), mode: 'register' });
}
