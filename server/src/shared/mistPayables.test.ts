import { describe, it, expect } from 'vitest';
import { applyMistCommand, createMistState, mistCommandPermission, type MistContext, type MistState } from './mistWorkspace';
import { supplierSettlements, invoiceableSettlements, payablesCommandPermission, payableBills, payableSources, supplierPayableSummary, supplierPayments, purchasePayableReadback, prepaymentPlans, paymentRequests, purchasePrepaymentReadback, getPayableReviews, payablesCommandPermissions } from './mistPayables';
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
    expect(err(() => run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 61310 }], { invoiceNo: 'VAT-9' })))).toContain('须关联已确认结算');
    expect(supplierPayableSummary(s, today)).toMatchObject([{ supplierId: po1.supplierId, open: 0, prepaid: 33480, unallocated: 0 }]);
    expect(purchasePrepaymentReadback(s, po1.id)).toMatchObject({ paid: 33480, applied: 0, available: 33480 });
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

describe('结算确认、预付抵扣与票据关联', () => {
  let rc = 0;
  const receive = (st: MistState, purchaseId: string, quantity: number, rejected = 0) => { const id = 'rcpt-' + (++rc); st.fulfillment.receipts.push({ id, purchaseId, quantity, rejected, destination: 'warehouse', location: '嘉兴仓', date: '2026-10-13', evidence: '收货单', fileIds: [], actor: '仓库', createdAt: '2026-10-13T02:00:00.000Z' } as any); return id; };
  function prepaid() {
    const { state, po1, po2 } = demo();
    let s = run(state, { type: 'payable.plan.register', payload: { purchaseId: po1.id, amount: 33480, trigger: '合同签订后 7 天内', basis: '合同第 5 条' } }).state;
    const planId = prepaymentPlans(s)[0].id;
    const req = as('业务-王', s, { type: 'payable.request.submit', payload: { purpose: 'prepayment', planId, amount: 33480, reason: '按合同申请预付' } }); s = req.state;
    s = as('主管-周', s, decide(String(req.result.id))).state;
    const paid = as('财务-林', s, { type: 'payable.payment.register', payload: { requestId: req.result.id, date: '2026-10-14', amount: 33480, reference: 'BANK-PP' } }); s = paid.state;
    return { s, po1, po2, prepaymentId: String(paid.result.id) };
  }
  const submit = (st: MistState, purchaseId: string, receiptIds: string[], extra: Record<string, unknown> = {}, actor = '业务-王') => as(actor, st, { type: 'payable.settlement.submit', payload: { purchaseId, receiptIds, ...extra } });
  const confirm = (st: MistState, id: string, prepaymentApplied: number, extra: Record<string, unknown> = {}, actor = '财务-林') => as(actor, st, { type: 'payable.settlement.confirm', payload: { id, prepaymentApplied, ...extra } });

  it('权限：业务员按合同经办权限提交，财务按核销权限复核、退回、冲回', () => {
    expect(payablesCommandPermission({ type: 'payable.settlement.submit', payload: {} } as any)).toBe('procurement:write');
    expect(payablesCommandPermission({ type: 'payable.settlement.cancel', payload: {} } as any)).toBe('procurement:write');
    for (const type of ['payable.settlement.confirm', 'payable.settlement.return', 'payable.settlement.reverse']) expect(payablesCommandPermission({ type, payload: {} } as any)).toBe('invoices:reconcile');
  });

  it('样例 PO-2026-00001：1000 / 1400 米两批按比例抵扣 13,950 / 19,530，票据关联结算后应付扣除预付，不重复形成应付', () => {
    let { s, po1, prepaymentId } = prepaid();
    const r1 = receive(s, po1.id, 1000, 50), r2 = receive(s, po1.id, 1400);
    const st1 = submit(s, po1.id, [r1], { disputes: [{ description: '色差待确认扣款', amount: 500 }] }); s = st1.state;
    let v = supplierSettlements(s)[0];
    expect(v).toMatchObject({ code: 'ST-2026-0001', quantity: 1000, rejected: 50, amount: 46500, final: false, state: 'pending', suggested: 13950, available: 33480 });
    expect(err(() => submit(s, po1.id, [r2]))).toContain('待财务复核');
    expect(err(() => confirm(s, v.id, 13950, {}, '业务-王'))).toContain('本人提交');
    expect(err(() => confirm(s, v.id, 14000))).toContain('调整原因');
    expect(err(() => confirm(s, v.id, 33480.01, { adjustReason: 'x' }))).toContain('剩余可抵扣');
    s = confirm(s, v.id, 13950, { note: '核对收货单' }).state;
    v = supplierSettlements(s)[0];
    expect(v).toMatchObject({ state: 'confirmed', net: 32550, uninvoiced: 46500, disputes: [{ description: '色差待确认扣款', amount: 500 }] });
    expect(v.confirmation).toMatchObject({ suggestedPrepayment: 13950, prepaymentApplied: 13950, adjustReason: '' });
    expect(purchasePrepaymentReadback(s, po1.id)).toMatchObject({ paid: 33480, applied: 13950, available: 19530 });
    expect(err(() => run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 46500 }])))).toContain('须关联已确认结算');
    expect(err(() => run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 46500.01, settlementId: v.id } as any])))).toContain('不能重复开票');
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 30000, settlementId: v.id } as any], { invoiceNo: 'VAT-A' })).state;
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 16500, settlementId: v.id } as any], { invoiceNo: 'VAT-B' })).state;
    const bills = payableBills(s, today);
    expect(bills.map(b => [b.invoiceNo, b.prepaymentCredit, b.open])).toEqual([['VAT-A', 9000, 21000], ['VAT-B', 4950, 11550]]);
    expect(bills[0].status).toBe('partial');
    expect(invoiceableSettlements(s, po1.id)).toEqual([]);
    expect(err(() => run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 1, settlementId: v.id } as any], { invoiceNo: 'VAT-C' })))).toContain('不能重复开票');
    expect(supplierPayableSummary(s, today)[0]).toMatchObject({ billed: 46500, open: 32550, prepaid: 19530, paid: 0 });
    expect(err(() => as('财务-林', s, { type: 'payable.settlement.reverse', payload: { id: v.id, reason: '数量录错' } }))).toContain('先作废关联票据');
    expect(err(() => submit(s, po1.id, [r1]))).toContain('已在其他结算');
    // 第二批达到合同数量，自动视为最终结算，抵扣剩余全部预付。
    const st2 = submit(s, po1.id, [r2]); s = st2.state;
    const v2 = supplierSettlements(s).find(x => x.id === st2.result.id)!;
    expect(v2).toMatchObject({ quantity: 1400, amount: 65100, final: true, suggested: 19530 });
    s = confirm(s, v2.id, 19530).state;
    expect(purchasePrepaymentReadback(s, po1.id)).toMatchObject({ applied: 33480, available: 0, residualAfterFinal: 0 });
    expect(err(() => submit(s, po1.id, [receive(s, po1.id, 1)]))).toContain('已完成最终结算');
    expect(err(() => as('财务-林', s, { type: 'payable.payment.reverse', payload: { supplierPaymentId: prepaymentId, reason: '误付' } }))).toContain('先冲回相关结算');
    expect(supplierPayableSummary(s, today)[0].prepaid).toBe(0);
  });

  it('退回、撤回、冲回会释放收货记录；拒收不计结算；短交最终结算后剩余预付单列待处理', () => {
    let { s, po1 } = prepaid();
    const rej = receive(s, po1.id, 0, 30), r1 = receive(s, po1.id, 500);
    expect(err(() => submit(s, po1.id, [rej]))).toContain('拒收数量不计入结算');
    let id = String(submit(s, po1.id, [r1]).result.id); s = submit(s, po1.id, [r1]).state;
    id = supplierSettlements(s)[0].id;
    expect(err(() => as('财务-林', s, { type: 'payable.settlement.cancel', payload: { id, reason: 'x' } }))).toContain('只有提交人');
    s = as('财务-林', s, { type: 'payable.settlement.return', payload: { id, reason: '收货单数量与仓库不符' } }).state;
    expect(supplierSettlements(s).find(x => x.id === id)).toMatchObject({ state: 'returned', returned: { reason: '收货单数量与仓库不符' } });
    const again = submit(s, po1.id, [r1]); s = again.state; id = String(again.result.id);
    s = as('业务-王', s, { type: 'payable.settlement.cancel', payload: { id, reason: '先补质检结论' } }).state;
    // 短交：业务员勾选最终结算，抵扣剩余预付但不超过结算金额，余额单列。
    const fin = submit(s, po1.id, [r1], { final: true }); s = fin.state; id = String(fin.result.id);
    expect(supplierSettlements(s).find(x => x.id === id)).toMatchObject({ final: true, amount: 23250, suggested: 23250 });
    s = confirm(s, id, 23250).state;
    expect(purchasePrepaymentReadback(s, po1.id)).toMatchObject({ applied: 23250, available: 10230, residualAfterFinal: 10230 });
    s = as('财务-林', s, { type: 'payable.settlement.reverse', payload: { id, reason: '最终结算数量录错' } }).state;
    expect(supplierSettlements(s).find(x => x.id === id)).toMatchObject({ state: 'reversed', reversed: { reason: '最终结算数量录错' } });
    expect(purchasePrepaymentReadback(s, po1.id)).toMatchObject({ applied: 0, available: 33480, residualAfterFinal: 0 });
    expect(submit(s, po1.id, [r1]).result.id).toBeTruthy();
  });

  it('进度款 / 尾款计划只记录安排：不能按计划直接申请，须随票据申请并占用计划额度', () => {
    const { state, po1 } = demo();
    let s = run(state, { type: 'payable.plan.register', payload: { purchaseId: po1.id, stage: 'final', amount: 11160, trigger: '验收合格后 30 天', basis: '合同第 5 条：尾款 10%' } }).state;
    const plan = prepaymentPlans(s)[0];
    expect(plan).toMatchObject({ stage: 'final', available: 11160 });
    expect(err(() => run(s, { type: 'payable.plan.register', payload: { purchaseId: po1.id, stage: 'progress', amount: 100440.01, trigger: 'x', basis: 'y' } }))).toContain('超过合同金额');
    expect(err(() => run(s, { type: 'payable.plan.register', payload: { purchaseId: po1.id, stage: 'deposit', amount: 1, trigger: 'x', basis: 'y' } }))).toContain('类型无效');
    expect(err(() => as('业务-王', s, { type: 'payable.request.submit', payload: { purpose: 'prepayment', planId: plan.id, amount: 100, reason: 'x' } }))).toContain('按票据申请付款');
    s = run(s, bill(po1.supplierId, [{ purchaseId: po1.id, amount: 20000 }], { invoiceNo: 'VAT-F' })).state;
    const b = payableBills(s, today)[0];
    expect(err(() => as('业务-王', s, { type: 'payable.request.submit', payload: { purpose: 'bill', supplierId: po1.supplierId, currency: 'CNY', lines: [{ billId: b.id, amount: 11160.01 }], planId: plan.id, reason: '尾款' } }))).toContain('剩余可申请');
    const req = as('业务-王', s, { type: 'payable.request.submit', payload: { purpose: 'bill', supplierId: po1.supplierId, currency: 'CNY', lines: [{ billId: b.id, amount: 11160 }], planId: plan.id, reason: '验收合格，申请尾款' } }); s = req.state;
    expect(prepaymentPlans(s)[0]).toMatchObject({ requested: 11160, available: 0 });
    expect(getPayableReviews(s)[0].details.find(d => d.label === '付款计划')!.value).toContain('验收合格后 30 天');
    s = as('主管-周', s, decide(String(req.result.id))).state;
    s = as('财务-林', s, { type: 'payable.payment.register', payload: { requestId: req.result.id, date: '2026-10-14', amount: 11160, reference: 'BANK-F', allocations: [{ billId: b.id, amount: 11160 }] } }).state;
    expect(prepaymentPlans(s)[0].paid).toBe(11160);
    expect(supplierPayableSummary(s, today)[0]).toMatchObject({ prepaid: 0, open: 8840 });
  });
});
