import { describe, it, expect } from 'vitest';
import { applyMistCommand, createMistState, mistCommandPermission, type MistContext, type MistState } from './mistWorkspace';
import { payableBills, payableSources, supplierPayableSummary, supplierPayments, purchasePayableReadback, prepaymentPlans, paymentRequests, purchasePrepaymentReadback, getPayableReviews, payablesCommandPermissions } from './mistPayables';
import { getMistReviewTasks } from './mistWorkspace';

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

// 角色：业务员申请、主管审批、财务付款；审批名单由服务端按申请人解析后放入上下文。
const REVIEWERS = { paymentReviewerIds: ['主管-周'] };
const as = (actor: string, st: MistState, command: any, now = '2026-10-14T02:00:00.000Z') => applyMistCommand(st, command, { ...ctx(actor, now), id: () => `ap-${actor}-${++seq}`, authority: { supplier: {}, ...REVIEWERS } } as MistContext);
const err = (fn: () => unknown) => { try { fn(); return ''; } catch (e: any) { return e.message as string; } };
const billRequest = (supplierId: string, lines: Array<{ billId: string; amount: number }>, reason = '到期付款') => ({ type: 'payable.request.submit', payload: { purpose: 'bill', supplierId, currency: 'CNY', lines, reason } });
const decide = (id: string, decision: 'approved' | 'rejected' = 'approved', note = '核对合同与票据，同意') => ({ type: 'payable.request.decide', payload: { id, decision, note } });
/** 申请 → 主管批准 → 财务按申请登记实付。 */
function approvedPay(st: MistState, supplierId: string, lines: Array<{ billId: string; amount: number }>, reference: string) {
  const req = as('业务-王', st, billRequest(supplierId, lines)); const ok = as('主管-周', req.state, decide(String(req.result.id)));
  const amount = lines.reduce((n, l) => n + l.amount, 0);
  const paid = as('财务-林', ok.state, { type: 'payable.payment.register', payload: { requestId: req.result.id, date: '2026-10-14', amount, reference, allocations: lines } });
  return { state: paid.state, requestId: String(req.result.id), paymentId: String(paid.result.id), applied: paid.result.applied };
}

describe('付款申请与主管审批', () => {
  it('权限沿用矩阵：申请需付款申请创建权，审批需付款申请审批权；没有已批准申请不能登记任何付款', () => {
    expect(mistCommandPermission({ type: 'payable.request.submit', payload: {} } as any)).toBe('finance:payment_request:create');
    expect(mistCommandPermission({ type: 'payable.request.decide', payload: {} } as any)).toBe('finance:payment_request:approve');
    expect(mistCommandPermission({ type: 'payable.plan.register', payload: {} } as any)).toBe('invoices:write');
    expect(payablesCommandPermissions({ type: 'payable.payment.reverse', payload: {} } as any)).toEqual(['vouchers:write', 'invoices:reconcile']);
    const { state, po1 } = demo();
    expect(err(() => run(state, { type: 'payable.payment.register', payload: { supplierId: po1.supplierId, date: '2026-10-13', amount: 100, currency: 'CNY', reference: 'B-1' } }))).toContain('须先提交付款申请');
  });
  it('票据付款：申请冻结快照进入主管收件箱；未批准不能付；批准后按申请付款并分配，金额 / 分配不一致拒绝', () => {
    const { state, po1 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 30000 }])).state;
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 20000 }], { invoiceNo: 'VAT-002' })).state;
    const [a, b] = payableBills(s, today);
    expect(err(() => applyMistCommand(s, billRequest(po1.supplierId, [{ billId: a.id, amount: 100 }]) as any, ctx('业务-王')))).toContain('没有可审批');
    const req = as('业务-王', s, billRequest(po1.supplierId, [{ billId: a.id, amount: 30000 }, { billId: b.id, amount: 10000 }]));
    s = req.state; const id = String(req.result.id);
    const task = getMistReviewTasks(s).find(t => t.id === 'payment:' + id)!;
    expect(task).toMatchObject({ kind: 'payment', status: 'pending', reviewerIds: ['主管-周'], requesterId: '业务-王', requiredPermission: 'finance:payment_request:approve' });
    expect(task.details.find(d => d.label === '本次申请金额')!.value).toBe('40000.00 CNY');
    // 同一张票不能被第二份未付申请重复占用
    expect(err(() => as('业务-王', s, billRequest(po1.supplierId, [{ billId: a.id, amount: 1 }])))).toContain('可申请金额');
    const pay = (st: MistState, extra: Record<string, unknown> = {}) => as('财务-林', st, { type: 'payable.payment.register', payload: { requestId: id, date: '2026-10-14', amount: 40000, reference: 'BANK-778', allocations: [{ billId: a.id, amount: 30000 }, { billId: b.id, amount: 10000 }], ...extra } });
    expect(err(() => pay(s))).toContain('尚未经主管批准');
    expect(err(() => as('业务-王', s, decide(id)))).toContain('有效审批主管');
    expect(err(() => applyMistCommand(s, decide(id) as any, { ...ctx('主管-周'), authority: { supplier: {}, paymentReviewerIds: [] } } as MistContext))).toContain('有效审批主管');
    s = as('主管-周', s, decide(id)).state;
    expect(getPayableReviews(s)[0].status).toBe('approved');
    expect(err(() => pay(s, { amount: 39999 }))).toContain('须与已批准申请一致');
    expect(err(() => pay(s, { allocations: [{ billId: a.id, amount: 40000 }] }))).toContain('须与已批准申请');
    expect(err(() => pay(s, { date: '2026-10-13' }))).toContain('早于主管批准');
    const r = pay(s); s = r.state; expect(r.result.applied).toBe(2);
    expect(payableBills(s, today).find(x => x.id === a.id)!.status).toBe('paid');
    expect(payableBills(s, today).find(x => x.id === b.id)).toMatchObject({ status: 'partial', open: 10000 });
    expect(paymentRequests(s)[0]).toMatchObject({ state: 'paid', supplierPaymentId: r.result.id });
    expect(supplierPayments(s)[0]).toMatchObject({ allocated: 40000, unallocated: 0, requestCode: 'PR-2026-0001' });
    expect(s.payments.at(-1)).toMatchObject({ payee: '华盛毛纺', amount: 40000, ref: 'BANK-778' });
    expect(err(() => pay(s))).toContain('已登记实付');
  });
  it('退回的申请不能付款；待审批 / 已批准未付可撤回，撤回后释放额度并从待审批中消失', () => {
    const { state, po1 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 1000 }])).state; const a = payableBills(s, today)[0];
    const r1 = as('业务-王', s, billRequest(po1.supplierId, [{ billId: a.id, amount: 1000 }])); s = as('主管-周', r1.state, decide(String(r1.result.id), 'rejected', '票据到期日核对不符')).state;
    expect(paymentRequests(s)[0].state).toBe('rejected');
    expect(err(() => as('财务-林', s, { type: 'payable.payment.register', payload: { requestId: r1.result.id, date: '2026-10-14', amount: 1000, reference: 'X', allocations: [{ billId: a.id, amount: 1000 }] } }))).toContain('尚未经主管批准');
    const r2 = as('业务-王', s, billRequest(po1.supplierId, [{ billId: a.id, amount: 1000 }])); s = r2.state;
    expect(err(() => run(s, { type: 'payable.bill.void', payload: { id: a.id, reason: '开错' } }))).toContain('先撤回申请');
    s = as('业务-王', s, { type: 'payable.request.cancel', payload: { id: r2.result.id, reason: '供应商要求合并付款' } }).state;
    expect(getPayableReviews(s).some(t => t.entityId === r2.result.id)).toBe(false);
    expect(as('业务-王', s, billRequest(po1.supplierId, [{ billId: a.id, amount: 1000 }])).result.id).toBeTruthy();
  });
});

describe('合同预付款计划与预付', () => {
  it('财务按合同登记预付计划；申请经批准后实付，预付挂在合同上不分配到票据，也不减少票据应付', () => {
    const { state, po1, draft } = demo();
    const plan = (st: MistState, amount: number, purchaseId = po1.id) => run(st, { type: 'payable.plan.register', payload: { purchaseId, amount, trigger: '合同签订后 7 天内', basis: '合同第 5 条：30% 预付，余款按结算' } });
    expect(err(() => plan(state, 100, draft.id))).toContain('尚未批准');
    expect(err(() => plan(state, 111600.01))).toContain('超过合同金额');
    let s = plan(state, 33480).state; const pp = prepaymentPlans(s)[0];
    expect(pp).toMatchObject({ code: 'PP-2026-0001', amount: 33480, requested: 0, available: 33480 });
    const ask = (st: MistState, amount: number) => as('业务-王', st, { type: 'payable.request.submit', payload: { purpose: 'prepayment', planId: pp.id, amount, reason: '合同已回签，按条款申请预付' } });
    expect(err(() => ask(s, 33480.01))).toContain('剩余可申请');
    const req = ask(s, 33480); s = req.state; const id = String(req.result.id);
    expect(getPayableReviews(s)[0].details.find(d => d.label === '预付款计划')!.value).toContain('合同签订后 7 天内');
    expect(err(() => ask(s, 1))).toContain('剩余可申请');
    expect(err(() => run(s, { type: 'payable.plan.cancel', payload: { id: pp.id, reason: 'x' } }))).toContain('已有付款申请');
    s = as('主管-周', s, decide(id)).state;
    expect(err(() => as('财务-林', s, { type: 'payable.payment.register', payload: { requestId: id, date: '2026-10-14', amount: 33480, reference: 'BANK-PP', allocations: [{ billId: 'x', amount: 1 }] } }))).toContain('不能分配到票据');
    const paid = as('财务-林', s, { type: 'payable.payment.register', payload: { requestId: id, date: '2026-10-14', amount: 33480, reference: 'BANK-PP' } }); s = paid.state;
    expect(supplierPayments(s)[0]).toMatchObject({ purpose: 'prepayment', prepaid: 33480, unallocated: 0, purchaseId: po1.id });
    expect(purchasePrepaymentReadback(s, po1.id)).toMatchObject({ planned: 33480, paid: 33480 });
    expect(err(() => run(s, { type: 'payable.payment.allocate', payload: { supplierPaymentId: paid.result.id, allocations: [{ billId: 'x', amount: 1 }] } }))).toContain('结算确认后抵扣');
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 61310 }], { invoiceNo: 'VAT-9' })).state;
    expect(payableBills(s, today)[0].open).toBe(61310);
    expect(supplierPayableSummary(s, today).find(x => x.supplierId === po1.supplierId)).toMatchObject({ open: 61310, prepaid: 33480, unallocated: 0 });
  });
});

describe('财务冲回：保留原记录，另记反向记录', () => {
  it('冲回付款：连带冲回分配，票据恢复未付，收付款记录记负数，申请回到已批准待付，可按原申请重新登记', () => {
    const { state, po1 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 1000 }])).state; const a = payableBills(s, today)[0];
    const p = approvedPay(s, po1.supplierId, [{ billId: a.id, amount: 1000 }], 'BANK-1'); s = p.state;
    expect(err(() => run(s, { type: 'payable.bill.void', payload: { id: a.id, reason: '开错' } }))).toContain('先冲回');
    expect(err(() => as('财务-林', s, { type: 'payable.payment.reverse', payload: { supplierPaymentId: p.paymentId, reason: '' } }))).toContain('冲回原因');
    s = as('财务-林', s, { type: 'payable.payment.reverse', payload: { supplierPaymentId: p.paymentId, reason: '流水号录错，银行实际未付' } }).state;
    expect(s.payables!.payments).toHaveLength(1); expect(s.payables!.allocations).toHaveLength(1);
    expect(s.payables!.reversals!.map(r => r.kind).sort()).toEqual(['allocation', 'payment']);
    expect(payableBills(s, today)[0]).toMatchObject({ status: 'unpaid', open: 1000 });
    expect(supplierPayments(s)[0]).toMatchObject({ allocated: 0, unallocated: 0, reversed: { reason: '流水号录错，银行实际未付' } });
    expect(s.payments.at(-1)).toMatchObject({ amount: -1000, ref: expect.stringContaining('冲回') });
    expect(paymentRequests(s)[0]).toMatchObject({ state: 'approved', paymentHistory: [p.paymentId] });
    expect(err(() => as('财务-林', s, { type: 'payable.payment.reverse', payload: { supplierPaymentId: p.paymentId, reason: '再冲' } }))).toContain('已冲回');
    const again = as('财务-林', s, { type: 'payable.payment.register', payload: { requestId: p.requestId, date: '2026-10-14', amount: 1000, reference: 'BANK-1', allocations: [{ billId: a.id, amount: 1000 }] } });
    expect(payableBills(again.state, today)[0].status).toBe('paid');
  });
  it('冲回分配：金额回到这笔付款的未分配，可重新分配；作废前须冲回', () => {
    const { state, po1 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 1000 }])).state;
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 800 }], { invoiceNo: 'VAT-002' })).state;
    const [a, b] = payableBills(s, today);
    const p = approvedPay(s, po1.supplierId, [{ billId: a.id, amount: 800 }], 'BANK-2'); s = p.state;
    const alloc = s.payables!.allocations[0].id;
    s = as('财务-林', s, { type: 'payable.allocation.reverse', payload: { allocationId: alloc, reason: '应分到 VAT-002' } }).state;
    expect(supplierPayments(s)[0]).toMatchObject({ allocated: 0, unallocated: 800 });
    expect(supplierPayableSummary(s, today).find(x => x.supplierId === po1.supplierId)).toMatchObject({ unallocated: 800 });
    expect(err(() => as('财务-林', s, { type: 'payable.allocation.reverse', payload: { allocationId: alloc, reason: 'x' } }))).toContain('已冲回');
    s = run(s, { type: 'payable.payment.allocate', payload: { supplierPaymentId: p.paymentId, allocations: [{ billId: b.id, amount: 800 }] } }).state;
    expect(payableBills(s, today).find(x => x.id === b.id)!.status).toBe('paid');
    const voided = run(s, { type: 'payable.bill.void', payload: { id: a.id, reason: '票面开错' } }).state;
    expect(payableBills(voided, today).find(x => x.id === a.id)!.status).toBe('void');
  });
  it('拒绝跨供应商、跨币种与超额申请', () => {
    const { state, po1, po2 } = demo();
    let s = run(state, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 1000 }])).state;
    s = run(s, bill(po2.supplierId, [{ purchaseId: po2.id, amount: 200 }], { invoiceNo: 'BT-1' })).state;
    const a = payableBills(s, today).find(x => x.supplierId === po1.supplierId)!, other = payableBills(s, today).find(x => x.supplierId === po2.supplierId)!;
    expect(err(() => as('业务-王', s, billRequest(po1.supplierId, [{ billId: other.id, amount: 100 }])))).toContain('供应商或币种');
    expect(err(() => as('业务-王', s, { ...billRequest(po1.supplierId, [{ billId: a.id, amount: 100 }]), payload: { ...billRequest(po1.supplierId, [{ billId: a.id, amount: 100 }]).payload, currency: 'USD' } }))).toContain('供应商或币种');
    expect(err(() => as('业务-王', s, billRequest(po1.supplierId, [{ billId: a.id, amount: 1000.5 }])))).toContain('可申请金额');
  });
});
