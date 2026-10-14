import { describe, it, expect } from 'vitest';
import { applyMistCommand, createMistState, mistCommandPermission, type MistContext, type MistState } from './mistWorkspace';
import { payableBills, payableSources, supplierPayableSummary, supplierPayments, purchasePayableReadback } from './mistPayables';

function ctx(actorName = '财务-林', now = '2026-10-14T02:00:00.000Z'): MistContext { let n = 0; return { id: () => `ap-${actorName}-${++n}`, now, actorName, actorId: actorName } as MistContext; }
const today = '2026-10-14';
function demo() {
  const c = ctx(), state = createMistState(c, 'demo');
  const po1 = state.fulfillment.purchases.find(p => p.code === 'PO-2026-00001')!; // 华盛毛纺 2400 米 × 46.5 = 111600 CNY
  const draft = state.fulfillment.purchases.find(p => p.state === 'draft' && p.supplierId === po1.supplierId)!;
  const po2 = state.fulfillment.purchases.find(p => p.code === 'PO-2026-00002')!;
  return { c, state, po1, po2, draft };
}
let seq = 0;
const run = (s: MistState, command: any) => applyMistCommand(s, command, { ...ctx(), id: () => `ap-run-${++seq}` });
const bill = (supplierId: string, lines: Array<{ purchaseId: string; amount: number }>, extra: Record<string, unknown> = {}) => ({ type: 'payable.bill.register', payload: { supplierId, invoiceNo: 'VAT-001', invoiceDate: '2026-10-10', currency: 'CNY', amount: lines.reduce((n, l) => n + l.amount, 0), taxAmount: 0, taxRate: '13%', lines, due: '2026-11-09', dueBasis: '合同：到货验收后 30 天', ...extra } });

describe('供应商票据登记', () => {
  it('财务权限；已批准合同才能登记，票据形成应付，合同剩余待登记同步减少', () => {
    const { state, po1 } = demo();
    expect(mistCommandPermission(bill(po1.supplierId, []) as any)).toBe('invoices:write');
    expect(payableSources(state).find(r => r.purchase.id === po1.id)!.uninvoiced).toBe(111600);
    const { state: s1, result } = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 33480 }], { taxAmount: 3851.68 }));
    const b = payableBills(s1, today).find(x => x.id === result.id)!;
    expect(b).toMatchObject({ code: 'AP-2026-0001', supplier: '华盛毛纺', amount: 33480, paid: 0, open: 33480, status: 'unpaid', terms: [po1.terms] });
    expect(payableSources(s1).find(r => r.purchase.id === po1.id)).toMatchObject({ invoiced: 33480, uninvoiced: 78120 });
    expect(purchasePayableReadback(s1, po1.id, today)).toHaveLength(1);
    expect(s1.payments.length).toBe(state.payments.length);
  });
  it('拒绝：草稿合同、别家合同、币种不同、合计不等、超合同额、重复发票号、未来日期、税额大于合计', () => {
    const { state, po1, po2, draft } = demo();
    const err = (cmd: any) => { try { run(state, cmd); return ''; } catch (e: any) { return e.message as string; } };
    expect(err(bill(po1.supplierId, [{ purchaseId: draft.id, amount: 100 }]))).toContain('尚未批准');
    expect(err(bill(po1.supplierId, [{ purchaseId: po2.id, amount: 100 }]))).toContain('不是该供应商');
    expect(err(bill(po1.supplierId, [{ purchaseId: po1.id, amount: 100 }], { currency: 'USD' }))).toContain('币种');
    expect(err(bill(po1.supplierId, [{ purchaseId: po1.id, amount: 100 }], { amount: 120 }))).toContain('合计必须等于');
    expect(err(bill(po1.supplierId, [{ purchaseId: po1.id, amount: 111600.01 }]))).toContain('超过合同金额');
    expect(err(bill(po1.supplierId, [{ purchaseId: po1.id, amount: 100 }], { invoiceDate: '2026-10-15' }))).toContain('未来');
    expect(err(bill(po1.supplierId, [{ purchaseId: po1.id, amount: 100 }], { taxAmount: 101 }))).toContain('税额');
    const { state: s1 } = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 100 }]));
    expect(() => run(s1, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 100 }], { invoiceNo: ' vat-001 ' }))).toThrow('已登记过');
  });
});

describe('供应商付款与多票分配', () => {
  it('一笔付款分到两张票，一张付清一张部分；未分配金额保留，后续再分配；同时出现在收付款记录', () => {
    const { state, po1 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 30000 }])).state;
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 20000 }], { invoiceNo: 'VAT-002' })).state;
    const [a, b] = payableBills(s, today);
    const r = run(s, { type: 'payable.payment.register', payload: { supplierId: po1.supplierId, date: '2026-10-13', amount: 45000, currency: 'CNY', reference: 'BANK-778', allocations: [{ billId: a.id, amount: 30000 }, { billId: b.id, amount: 10000 }] } });
    s = r.state; expect(r.result.applied).toBe(2);
    const bills = payableBills(s, today);
    expect(bills.find(x => x.id === a.id)!.status).toBe('paid'); expect(bills.find(x => x.id === b.id)).toMatchObject({ status: 'partial', open: 10000 });
    expect(supplierPayments(s)[0]).toMatchObject({ allocated: 40000, unallocated: 5000 });
    expect(s.payments.at(-1)).toMatchObject({ payee: '华盛毛纺', amount: 45000, currency: 'CNY', ref: 'BANK-778' });
    expect(supplierPayableSummary(s, today).find(x => x.supplierId === po1.supplierId)).toMatchObject({ billed: 50000, paid: 40000, open: 10000, unallocated: 5000, bills: 1 });
    expect(() => run(s, { type: 'payable.payment.allocate', payload: { supplierPaymentId: r.result.id, allocations: [{ billId: b.id, amount: 6000 }] } })).toThrow('超过');
    s = run(s, { type: 'payable.payment.allocate', payload: { supplierPaymentId: r.result.id, allocations: [{ billId: b.id, amount: 5000 }] } }).state;
    expect(payableBills(s, today).find(x => x.id === b.id)!.open).toBe(5000);
    expect(() => run(s, { type: 'payable.payment.register', payload: { supplierId: po1.supplierId, date: '2026-10-13', amount: 1, currency: 'CNY', reference: 'bank-778' } })).toThrow('已登记过');
  });
  it('拒绝跨供应商、跨币种和超额分配；有付款的票据不能作废，没付款的作废后释放合同额度', () => {
    const { state, po1, po2 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 1000 }])).state;
    s = run(s, bill(po2.supplierId, [{ purchaseId: po2.id, amount: 200 }], { invoiceNo: 'BT-1' })).state;
    const a = payableBills(s, today).find(x => x.supplierId === po1.supplierId)!, other = payableBills(s, today).find(x => x.supplierId === po2.supplierId)!;
    const pay = (allocations: any, extra = {}) => run(s, { type: 'payable.payment.register', payload: { supplierId: po1.supplierId, date: '2026-10-13', amount: 1000, currency: 'CNY', reference: 'R-' + Math.random(), allocations, ...extra } });
    expect(() => pay([{ billId: other.id, amount: 100 }])).toThrow('不是该供应商');
    expect(() => pay([{ billId: a.id, amount: 100 }], { currency: 'USD' })).toThrow('汇率');
    expect(() => pay([{ billId: a.id, amount: 1000.5 }])).toThrow('超过');
    expect(() => pay([], { date: '2026-10-15' })).toThrow('未来');
    const before = s.payments.length; expect(() => pay([{ billId: a.id, amount: 5000 }])).toThrow(); expect(s.payments.length).toBe(before);
    const paid = pay([{ billId: a.id, amount: 400 }]).state;
    expect(() => run(paid, { type: 'payable.bill.void', payload: { id: a.id, reason: '开错' } })).toThrow('已有付款');
    const voided = run(s, { type: 'payable.bill.void', payload: { id: a.id, reason: '票面金额开错，供应商重开' } }).state;
    expect(payableBills(voided, today).find(x => x.id === a.id)).toMatchObject({ status: 'void', open: 0 });
    expect(payableSources(voided).find(r => r.purchase.id === po1.id)!.invoiced).toBe(0);
    expect(() => run(voided, { type: 'payable.payment.register', payload: { supplierId: po1.supplierId, date: '2026-10-13', amount: 10, currency: 'CNY', reference: 'X1', allocations: [{ billId: a.id, amount: 10 }] } })).toThrow('作废');
  });
});
