import { describe, expect, it } from 'vitest';
import { agingBucket, buildCustomerSales, buildOrderProgress, buildReceivableAging } from './PlatformReports';

const order = (id: string, o: Record<string, unknown> = {}) => ({ id, code: 'SO-' + id, customerId: 'c-' + (o.customer ?? 'A'), customer: 'A', currency: 'USD', amount: 100, due: '2026-10-20', progress: 50, state: '生产中', tone: 'neutral', createdAt: '2026-10-01T02:00:00Z', ...o });
const invoice = (id: string, orderId: string, o: Record<string, unknown> = {}) => ({ id, code: 'INV-' + id, orderId, order: '', customer: 'A', currency: 'USD', amount: 100, open: 100, due: '2026-10-01', ...o });
const state = (orders: any[], invoices: any[] = []) => ({ orders, invoices } as any);

describe('报表中心', () => {
  it('sums customer sales per currency, excludes void invoices and uses the Shanghai business day', () => {
    const s = state([order('1'), order('2', { currency: 'CNY', amount: 50 }), order('3', { createdAt: '2026-09-30T17:00:00Z' }), order('4', { customer: 'B', customerId: 'c-B', amount: 300 })],
      [invoice('i1', '1', { open: 40 }), invoice('i2', '1', { voidedAt: '2026-10-02T00:00:00Z', open: 100 }), invoice('i3', '2', { currency: 'CNY', amount: 50, open: 50 })]);
    const rows = buildCustomerSales(s, '2026-10-01');
    expect(rows.map(r => [r.customer, r.currency, r.orders, r.amount, r.invoiced, r.received, r.open])).toEqual([['A', 'CNY', 1, 50, 50, 0, 50], ['B', 'USD', 1, 300, 0, 0, 0], ['A', 'USD', 2, 200, 100, 60, 40]]);
    expect(buildCustomerSales(s, '2026-10-02')).toEqual([]);
  });
  it('buckets open receivables by days past due and skips settled or void invoices', () => {
    expect(['2026-10-15', '2026-10-14', '2026-09-15', '2026-08-16', '2026-07-17', '2026-07-16'].map(d => agingBucket(d, '2026-10-15'))).toEqual(['current', 'd30', 'd30', 'd60', 'd90', 'over']);
    const rows = buildReceivableAging(state([], [invoice('a', 'x', { due: '2026-10-20' }), invoice('b', 'x', { due: '2026-06-01', open: 25.5 }), invoice('c', 'x', { open: 0 }), invoice('d', 'x', { voidedAt: '2026-10-01T00:00:00Z' }), invoice('e', 'x', { currency: 'EUR', open: 7 })]), '2026-10-15');
    expect(rows).toEqual([
      { id: 'A|EUR', customer: 'A', currency: 'EUR', invoices: 1, total: 7, current: 0, d30: 7, d60: 0, d90: 0, over: 0 },
      { id: 'A|USD', customer: 'A', currency: 'USD', invoices: 2, total: 125.5, current: 100, d30: 0, d60: 0, d90: 0, over: 25.5 },
    ]);
  });
  it('lists unfinished orders with overdue first, then due within seven days', () => {
    const rows = buildOrderProgress(state([order('done', { progress: 100, due: '2026-01-01' }), order('ok', { due: '2026-11-30' }), order('soon', { due: '2026-10-22' }), order('late', { due: '2026-10-10' }), order('none', { due: '' })]), '2026-10-15');
    expect(rows.map(r => [r.id, r.status, r.lateDays])).toEqual([['late', 'overdue', 5], ['soon', 'soon', 0], ['ok', 'ontrack', 0], ['none', 'nodue', 0]]);
  });
});
