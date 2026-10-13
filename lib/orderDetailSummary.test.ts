import { describe, expect, it } from 'vitest';
import type { Order } from '../types';
import { orderDetailSummary, realOrderDetailLines, orderDetailLineAmount, normalizeOrderDetailType } from './orderDetailSummary';

const order: Order = { id: 'O', type: 'Fabric', customer: 'Customer', product: 'Legacy first product', quantity: 999, unit: 'Header unit', dueDate: '2020-01-01', quoteAmount: 900, status: 'Confirmed', contractDeliveryDate: '2026-12-01', lines: [
  { id: 'L1', lineNumber: 1, quantity: '0.1' as any, unit: 'M', netValue: 1, exMillDate: '2026-11-10' },
  { id: 'L2', lineNumber: 2, quantity: '0.2' as any, unit: 'M', netValue: 2, exMillDate: '2026-11-01', agreedDeliveryDate: '2026-12-15' },
  { id: 'L3', lineNumber: 3, quantity: 4, unit: 'KG', netValue: 4 },
  { id: 'L4', lineNumber: 4, quantity: 6, unit: null, netValue: 6 },
] };
describe('whole-order detail summary from real lines', () => {
  it('normalizes native domain labels without projecting or replacing the complete DTO', () => {
    const raw = { ...order, type: 'fabric' as Order['type'], nativeMainField: { source: 'V2' } };
    const normalized = normalizeOrderDetailType(raw);
    expect(normalized).toEqual({ ...raw, type: 'Fabric' });
    expect(normalized.lines).toBe(raw.lines); expect((normalized as typeof raw).nativeMainField).toBe(raw.nativeMainField);
    expect(normalizeOrderDetailType(order)).toBe(order);
    expect(normalizeOrderDetailType({ ...raw, type: 'garment' as Order['type'] }).type).toBe('Garment');
  });
  it('uses only the line net value or known quantity/price, including a real zero', () => {
    expect(orderDetailLineAmount({ quantity: 10, unitPrice: null, netValue: null })).toBeUndefined();
    expect(orderDetailLineAmount({ quantity: 10, unitPrice: 2, netValue: null })).toBe(20);
    expect(orderDetailLineAmount({ quantity: 10, unitPrice: 2, netValue: 0 })).toBe(0);
  });
  it('keeps Decimal quantities together only when their actual units match', () => {
    expect(orderDetailSummary(order).quantities).toEqual([{ unit: 'M', quantity: 0.3 }, { unit: 'KG', quantity: 4 }, { unit: '', quantity: 6 }]);
    expect(orderDetailSummary(order).amount).toBe(13);
  });
  it('omits unrecorded quantity groups instead of reporting the ledger zero fallback', () => {
    const sparse = { ...order, lines: [
      { id: 'missing', unit: 'M', quantity: null },
      { id: 'blank', unit: 'KG', quantity: ' ' },
      { id: 'invalid', unit: 'Yard', quantity: 'unknown' },
      { id: 'zero', unit: 'Pcs', quantity: 0 },
    ] } as unknown as Order;
    expect(orderDetailSummary(sparse).quantities).toEqual([{ unit: 'Pcs', quantity: 0 }]);
  });
  it('keeps Ex-mill and contractual delivery as independent complete ranges', () => {
    const summary = orderDetailSummary(order);
    expect(summary.exMill).toEqual({ first: '2026-11-01', last: '2026-11-10', undatedCount: 2 });
    expect(summary.delivery).toEqual({ first: '2026-12-01', last: '2026-12-15', undatedCount: 0 });
  });
  it('does not invent a line or borrow the legacy quantity when lines are empty', () => {
    const empty = { ...order, lines: [] };
    expect(realOrderDetailLines(empty)).toEqual([]); expect(orderDetailSummary(empty).quantities).toEqual([]);
    expect(orderDetailSummary(empty).exMill).toEqual({ first: '', last: '', undatedCount: 0 });
  });
});
