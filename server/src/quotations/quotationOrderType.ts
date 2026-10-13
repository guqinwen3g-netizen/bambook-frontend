export type QuotationOrderType = 'Garment' | 'Fabric' | 'Other';

const GARMENT_ORDER_UNITS = new Set(['PC', 'PCS', 'SET']);
const FABRIC_ORDER_UNITS = new Set(['M', 'METER', 'MT', 'YD', 'YARD', 'KG', 'G', 'ROLL', '卷', '米']);

export function isGarmentQuotationOrderUnit(value?: string | null): boolean {
  return GARMENT_ORDER_UNITS.has(String(value ?? '').trim().toUpperCase());
}

/** Match the order type the quotation conversion service derives from source lines. */
export function deriveQuotationOrderTypeFromLines(lines: ReadonlyArray<{ unit?: string | null }> | null | undefined): QuotationOrderType {
  if (!lines || lines.length === 0) return 'Fabric';
  let garment = false;
  let fabric = false;
  let other = false;
  for (const line of lines) {
    const unit = String(line.unit ?? '').trim().toUpperCase();
    if (isGarmentQuotationOrderUnit(unit)) garment = true;
    else if (FABRIC_ORDER_UNITS.has(unit)) fabric = true;
    else other = true;
  }
  if (other || (garment && fabric)) return 'Other';
  return garment ? 'Garment' : 'Fabric';
}
