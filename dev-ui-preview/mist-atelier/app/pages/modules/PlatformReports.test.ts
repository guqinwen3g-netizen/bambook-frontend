import { describe, expect, it } from 'vitest';
import { agingBucket, buildCustomerSales, buildOrderMargin, buildOrderMarginCny, buildOrderProgress, buildReceivableAging } from './PlatformReports';
import { applyMistCommand, createMistState, type MistCommand, type MistContext } from '../../../../../server/src/shared/mistWorkspace';
import { rebateCandidateBills } from '../../../../../server/src/shared/mistExportRebate';

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
  it('computes contract-basis gross margin per order in the order currency without FX conversion', () => {
    const purchase = (id: string, orderId: string, o: Record<string, unknown> = {}) => ({ id, code: 'PO-' + id, orderId, state: 'approved', quantity: 10, price: 3.33, currency: 'USD', ...o });
    const s = { orders: [order('1', { amount: 100 }), order('2', { amount: 80 }), order('3', { amount: 50 }), order('4', { governance: { status: 'pending' } }), order('5', { amount: 40 })],
      invoices: [],
      fulfillment: { purchases: [purchase('a', '1'), purchase('b', '1', { quantity: 2, price: 10 }), purchase('c', '1', { state: 'pending' }), purchase('d', '1', { cancellation: { at: 'x' } }), purchase('e', '2', { currency: 'CNY', price: 50 }), purchase('f', '2', { price: 1 }), purchase('g', '4'), purchase('h', '5', { quantity: 1, price: 55 })] },
      payables: { bills: [{ state: 'open', currency: 'USD', lines: [{ purchaseId: 'a', amount: 20 }] }, { state: 'void', currency: 'USD', lines: [{ purchaseId: 'b', amount: 20 }] }] } } as any;
    const rows = buildOrderMargin(s);
    expect(rows.map(r => [r.id, r.status, r.revenue, r.cost, r.margin, r.rate === null ? null : Math.round(r.rate * 1000) / 1000, r.billed, r.pending, r.foreign])).toEqual([
      ['5', 'ok', 40, 55, -15, -0.375, 0, 0, ''],
      ['1', 'ok', 100, 53.3, 46.7, 0.467, 20, 1, ''],
      ['2', 'foreign', 80, 10, null, null, 0, 0, 'CNY 500.00'],
      ['3', 'nocost', 50, 0, null, null, 0, 0, ''],
    ]);
  });

  it('折算人民币毛利：按口径取汇率并标暂估，含退税毛利 = 不含退税毛利 + 本单核准退税；缺汇率不出毛利', () => {
    let n = 0; const ctx: MistContext = { id: () => `rp-${++n}`, now: '2026-10-17T04:00:00Z', actorName: '林舒', actorId: 'demo-finance' };
    let s = createMistState(ctx, 'demo');
    const run = (command: MistCommand) => { s = applyMistCommand(s, command, ctx).state; };
    const customs = s.fulfillment.customs.find(c => s.fulfillment.shipments.find(x => x.id === c.shipmentId)?.state === 'departed')!;
    run({ type: 'rebate.claim.file', payload: { customsId: customs.id, billIds: rebateCandidateBills(s, customs).map(b => b.id), filedAt: '2026-10-16', batchRef: '202610-01' } });
    run({ type: 'rebate.claim.approve', payload: { id: s.exportRebate!.claims[0].id, date: '2026-10-17', amount: 25000, ref: '审核通知', reason: '部分计税金额调减' } });
    const pick = (basis: 'actual' | 'period' | 'quote') => buildOrderMarginCny(s, basis, '2026-10', '2026-10-17').find(r => r.code === 'SO-G-2026-017')!;
    const period = pick('period');
    expect(period).toMatchObject({ status: 'ok', estimated: true, revenue: 41850, revenueCny: 297888.3, rebate: { expected: 26000, approved: 25000, received: 0 } });
    expect(period.fx?.label).toContain('2026-09 月末 7.1180');
    expect(Math.round((period.marginIn! - period.marginEx!) * 100) / 100).toBe(25000);
    expect(period.marginEx).toBe(Math.round((297888.3 - period.costCny!) * 100) / 100);
    expect(pick('quote')).toMatchObject({ status: 'ok', estimated: true, revenueCny: 301320 });
    expect(pick('actual')).toMatchObject({ status: 'norate', marginEx: null, marginIn: null, missing: ['USD'] });
    const eur = buildOrderMarginCny(s, 'quote', '2026-10', '2026-10-17').find(r => r.currency === 'EUR')!;
    expect(eur.status).toBe('norate');
  });
});
