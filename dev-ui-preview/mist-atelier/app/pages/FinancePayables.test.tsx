// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { getAllByRole, getByRole, getByLabelText, queryAllByRole } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { createMistState, applyMistCommand } from '../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import { Nav } from '../nav';
const store = vi.hoisted(() => ({ value: null as any }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store.value }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => ({ hasPermission: (scope: string) => store.value?.canWrite !== false && (!store.value?.permissions || store.value.permissions.includes(scope)) }) }));
import { FinancePayables } from './FinancePayables';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, route: { view: string; id?: string; section?: string };
const go = vi.fn(), day = platformBusinessDate(new Date());
function render() { act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route, go, theme: 'light', toggleTheme: vi.fn(), openAI: vi.fn(), openPalette: vi.fn() } as any}><FinancePayables /></Nav.Provider></ToastProvider></MistRoot>)); }
const click = async (name: string | RegExp, scope: HTMLElement = document.body) => { await act(async () => (getAllByRole(scope, 'button', { name })[0] as HTMLButtonElement).click()); };
function input(label: string, value: string) { const c = getByLabelText(document.body, label) as HTMLInputElement; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(c, value); c.dispatchEvent(new Event('input', { bubbles: true })); }); }
function select(label: string, value: string) { const c = getByLabelText(document.body, label) as HTMLSelectElement; act(() => { c.value = value; c.dispatchEvent(new Event('change', { bubbles: true })); }); }
let po: any, ctx: any;
beforeEach(() => {
  let serial = 0; const context = ctx = { id: () => `ui-${++serial}`, actorName: '财务', actorId: 'finance', now: new Date().toISOString(), authority: { supplier: {}, paymentReviewerIds: ['manager'] } };
  const state = createMistState(context, 'demo'); po = state.fulfillment.purchases.find(p => p.code === 'PO-2026-00001');
  store.value = { state, workspace: { id: 'space' }, loading: false, saving: false, pending: null, run: vi.fn(async (command: any) => { const r = applyMistCommand(store.value.state, command, context); store.value.state = r.state; render(); return { requestId: 'req', revision: 1, result: r.result }; }) };
  go.mockReset(); route = { view: 'payment-vouchers', section: 'payables' };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('从待登记来源登记供应商票据：形成应付，合同还没收到票的金额同步减少', async () => {
  render(); expect(host.textContent).toContain('合同金额不是应付');
  await click(/待登记来源/); const row = getByRole(host, 'table', { name: '待登记来源合同' });
  expect(row.textContent).toContain('111,600.00 CNY');
  await click('登记票据', row);
  const dialog = getByRole(document.body, 'dialog', { name: '登记供应商票据' });
  expect((getByLabelText(dialog, po.code + ' 本票金额') as HTMLInputElement).value).toBe('111600');
  expect(dialog.querySelector('[data-bill-source]')?.classList.contains('mist-module-actions')).toBe(true);
  input(po.code + ' 本票金额', '33480'); input('供应商发票号', 'VAT-HS-01'); input('税额', '3851.68'); input('到期日', day);
  expect((getByLabelText(dialog, '到期日依据') as HTMLInputElement).value).toContain(po.terms);
  await click('登记应付', dialog);
  expect(store.value.run).toHaveBeenCalledWith(expect.objectContaining({ type: 'payable.bill.register', payload: expect.objectContaining({ supplierId: po.supplierId, currency: 'CNY', amount: 33480, taxAmount: 3851.68, lines: [{ purchaseId: po.id, amount: 33480 }] }) }));
  expect(store.value.state.payables.bills[0]).toMatchObject({ invoiceNo: 'VAT-HS-01', amount: 33480 });
  expect(getByRole(host, 'table', { name: '供应商应付汇总' }).textContent).toContain('33,480.00 CNY');
  expect(go).toHaveBeenLastCalledWith('payment-vouchers', store.value.state.payables.bills[0].id, { section: 'payables' });
});

it('有付款的票据不能作废，按钮写明原因；没有付款的作废要写原因', async () => {
  store.value.state = applyMistCommand(store.value.state, { type: 'payable.bill.register', payload: { supplierId: po.supplierId, invoiceNo: 'V-9', invoiceDate: day, currency: 'CNY', amount: 50, taxAmount: 0, lines: [{ purchaseId: po.id, amount: 50 }], due: day, dueBasis: '测试' } } as any, { id: () => 'b' + Math.random(), now: new Date().toISOString(), actorName: '财务' }).state;
  const bill = store.value.state.payables.bills[0]; route = { view: 'payment-vouchers', section: 'payables', id: bill.id }; render();
  await click('作废票据'); const dialog = getByRole(document.body, 'dialog', { name: '作废供应商票据' });
  expect((getByRole(dialog, 'button', { name: '确认作废' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => { const t = getByLabelText(dialog, '作废原因') as HTMLTextAreaElement; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(t, '供应商开错金额'); t.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('确认作废', dialog);
  expect(store.value.state.payables.bills[0]).toMatchObject({ state: 'void', voided: { reason: '供应商开错金额' } });
});

function text(label: string, value: string, scope: HTMLElement = document.body) { const t = getByLabelText(scope, label) as HTMLTextAreaElement; act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(t, value); t.dispatchEvent(new Event('input', { bubbles: true })); }); }
const reg = (no: string, amount: number) => { let n = 0; store.value.state = applyMistCommand(store.value.state, { type: 'payable.bill.register', payload: { supplierId: po.supplierId, invoiceNo: no, invoiceDate: day, currency: 'CNY', amount, taxAmount: 0, lines: [{ purchaseId: po.id, amount }], due: day, dueBasis: '测试' } } as any, { id: () => no + '-' + (++n), now: new Date().toISOString(), actorName: '财务' } as any).state; };
/** 主管在审批收件箱批准（服务端审批入口，界面外）。 */
const approve = (id: string) => { store.value.state = applyMistCommand(store.value.state, { type: 'payable.request.decide', payload: { id, decision: 'approved', note: '核对后同意' } } as any, { id: () => 'decide-' + id, now: new Date().toISOString(), actorName: '主管', actorId: 'manager', authority: { supplier: {}, paymentReviewerIds: ['manager'] } } as any).state; };
const dialog = (name: string) => getByRole(document.body, 'dialog', { name });

it('票据付款：先申请并经主管批准，再按批准登记实付；分配错误可冲回后重新分配', async () => {
  reg('A-1', 300); reg('A-2', 200); render();
  const [a, b] = store.value.state.payables.bills;
  expect(queryAllByRole(host, 'button', { name: '登记供应商付款' })).toHaveLength(0);
  await click('申请票据付款');
  select('收款供应商', po.supplierId);
  expect(dialog('申请票据付款').querySelector('[data-pay-bill]')?.classList.contains('mist-module-actions')).toBe(true);
  input(a.code + ' 申请金额', '300'); input(b.code + ' 申请金额', '250');
  await click('提交审批', dialog('申请票据付款'));
  expect(store.value.run).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('不能超过可申请金额');
  input(b.code + ' 申请金额', '100');
  await click('提交审批', dialog('申请票据付款'));
  expect(document.body.textContent).toContain('请填写申请说明'); expect(store.value.run).not.toHaveBeenCalled();
  text('申请说明', '两张票均已到期，按合同 30 天付款');
  await click('提交审批', dialog('申请票据付款'));
  const req = store.value.state.payables.requests[0];
  expect(req).toMatchObject({ state: 'pending', amount: 400, reviewerIds: ['manager'] });
  route = { view: 'payment-vouchers', section: 'payables', id: req.id }; render();
  expect(host.textContent).toContain('等待主管审批'); expect(queryAllByRole(host, 'button', { name: '登记实付' })).toHaveLength(0);
  approve(req.id); render();
  await click('登记实付');
  const pay = dialog('按已批准申请登记实付');
  expect((getByLabelText(pay, a.code + ' 分配金额') as HTMLInputElement).readOnly).toBe(true);
  input('银行流水号', 'BK-1');
  await click('登记实付', pay);
  expect(store.value.state.payables.requests[0].state).toBe('paid');
  expect(store.value.state.payables.allocations).toHaveLength(2);
  expect(store.value.state.payments.at(-1)).toMatchObject({ payee: po.supplier, amount: 400, ref: 'BK-1' });
  const payment = store.value.state.payables.payments[0];
  route = { view: 'payment-vouchers', section: 'payables', id: payment.id }; render();
  await click('冲回分配');
  expect((getByRole(dialog('冲回分配'), 'button', { name: '确认冲回' }) as HTMLButtonElement).disabled).toBe(true);
  text('冲回原因', 'A-1 金额分错', dialog('冲回分配')); await click('确认冲回', dialog('冲回分配'));
  expect(store.value.state.payables.reversals).toHaveLength(1);
  expect(host.textContent).toContain('还有钱没分到票据上');
  await click('分配到应付'); input(b.code + ' 分配金额', '100'); await click('确认分配');
  expect(store.value.state.payables.allocations).toHaveLength(3);
});

it('预付款：财务按合同登记计划，申请经主管批准后实付，挂在合同上；登记错误可冲回，申请回到已批准待付', async () => {
  render();
  await click('登记付款计划');
  select('来源合同', po.id); input('计划金额', '33480'); input('付款触发条件', '合同回签后 7 天内');
  expect((getByLabelText(document.body, '合同条款依据') as HTMLInputElement).value).toContain('合同付款条件');
  await click('登记计划', dialog('登记付款计划'));
  const plan = store.value.state.payables.plans[0];
  expect(plan).toMatchObject({ purchaseId: po.id, amount: 33480, trigger: '合同回签后 7 天内' });
  expect(host.textContent).toContain('计划不是应付');
  await click('申请预付款');
  input('申请金额', '33480.01'); text('申请说明', '合同已于本周回签');
  await click('提交审批', dialog('申请预付款'));
  expect(document.body.textContent).toContain('超过该计划剩余可申请金额');
  input('申请金额', '33480'); await click('提交审批', dialog('申请预付款'));
  const req = store.value.state.payables.requests[0]; expect(req).toMatchObject({ purpose: 'prepayment', state: 'pending' });
  approve(req.id); route = { view: 'payment-vouchers', section: 'payables', id: req.id }; render();
  await click('登记实付'); expect(dialog('按已批准申请登记实付').textContent).toContain('不分配到票据');
  input('银行流水号', 'BK-PRE'); await click('登记实付', dialog('按已批准申请登记实付'));
  const payment = store.value.state.payables.payments[0];
  expect(payment).toMatchObject({ purpose: 'prepayment', purchaseId: po.id });
  route = { view: 'payment-vouchers', section: 'payables', id: payment.id }; render();
  expect(host.textContent).toContain('预付款挂在合同上'); expect(queryAllByRole(host, 'button', { name: '分配到应付' })).toHaveLength(0);
  await click('付款冲回'); text('冲回原因', '流水号录错', dialog('付款冲回')); await click('确认冲回', dialog('付款冲回'));
  expect(host.textContent).toContain('已冲回');
  expect(store.value.state.payables.requests[0].state).toBe('approved');
  expect(store.value.state.payments.at(-1).amount).toBe(-33480);
});

it('没有财务写权限：可以查看，登记和申请按钮禁用', async () => {
  store.value.canWrite = false; render();
  for (const name of ['登记供应商票据', '登记付款计划', '提交结算', '申请票据付款']) expect((getByRole(host, 'button', { name }) as HTMLButtonElement).disabled).toBe(true);
  await click(/待登记来源/); expect(getByRole(host, 'table', { name: '待登记来源合同' }).textContent).toContain(po.code);
  expect(store.value.run).not.toHaveBeenCalled();
});

function approvedBillRequest() {
  reg('PERMISSION-VAT', 100); const bill = store.value.state.payables.bills[0];
  store.value.state = applyMistCommand(store.value.state, { type: 'payable.request.submit', payload: { purpose: 'bill', supplierId: po.supplierId, currency: 'CNY', lines: [{ billId: bill.id, amount: 100 }], reason: '到期' } } as any, { id: () => 'perm-req', now: new Date().toISOString(), actorName: '业务', actorId: 'sales', authority: { supplier: {}, paymentReviewerIds: ['manager'] } } as any).state;
  approve('perm-req'); return { bill, request: store.value.state.payables.requests[0] };
}
it('只有付款登记权限、没有核销权时，票据付款申请的登记实付禁用并写明原因', async () => {
  const { request } = approvedBillRequest();
  store.value.permissions = ['vouchers:write', 'invoices:read', 'vouchers:read'];
  route = { view: 'payment-vouchers', section: 'payables', id: request.id }; render();
  expect((getByRole(host, 'button', { name: '登记实付' }) as HTMLButtonElement).disabled).toBe(true);
  expect(store.value.run).not.toHaveBeenCalled();
});
it('打开登记实付后失去核销权限，不能提交附带分配的复合付款', async () => {
  const { request } = approvedBillRequest();
  route = { view: 'payment-vouchers', section: 'payables', id: request.id }; render();
  await click('登记实付'); input('银行流水号', 'STALE-SCOPE');
  store.value.permissions = ['vouchers:write']; render();
  await click('登记实付', dialog('按已批准申请登记实付'));
  expect(store.value.run).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('没有办理此项财务动作的权限');
});

const as = (actorId: string, actorName: string, command: any) => { let n = 0; const r = applyMistCommand(store.value.state, command, { id: () => `${actorId}-${command.type}-${++n}-${Math.random()}`, now: new Date().toISOString(), actorName, actorId, authority: { supplier: {}, paymentReviewerIds: ['manager'] } } as any); store.value.state = r.state; return r.result; };

it('结算：业务员按收货提交，财务确认预付抵扣（与建议不同须写原因），再按结算登记票据，应付扣除预付', async () => {
  as('finance', '财务', { type: 'payable.plan.register', payload: { purchaseId: po.id, amount: 33480, trigger: '合同签订后 7 天内', basis: '合同第 5 条' } });
  const req = as('sales', '业务', { type: 'payable.request.submit', payload: { purpose: 'prepayment', planId: store.value.state.payables.plans[0].id, amount: 33480, reason: '按合同申请预付' } });
  approve(String(req.id));
  as('finance', '财务', { type: 'payable.payment.register', payload: { requestId: req.id, date: day, amount: 33480, reference: 'BK-PP' } });
  store.value.state.fulfillment.receipts.push({ id: 'rcpt-ui', purchaseId: po.id, quantity: 1000, rejected: 50, destination: 'warehouse', location: '嘉兴仓', date: day, evidence: '收货单', fileIds: [], actor: '仓库', createdAt: new Date().toISOString() });
  render();
  // 已付预付后，未确认结算的合同不能直接登记票据。
  await click(/待登记来源/); await click('登记票据', getByRole(host, 'table', { name: '待登记来源合同' }));
  expect([...(getByLabelText(dialog('登记供应商票据'), po.code + ' 关联结算') as HTMLSelectElement).options].map(o => o.textContent)).toEqual(['请选择结算', '待关联结算（发票先到，结算确认后再关联）']);
  await click('取消', dialog('登记供应商票据'));
  ctx.actorId = 'sales'; ctx.actorName = '业务';
  await click('提交结算'); const sd = dialog('提交结算');
  select('结算合同', po.id);
  const box = getByRole(sd, 'checkbox', { name: /嘉兴仓 · 实收 1000/ }) as HTMLInputElement;
  await act(async () => box.click());
  expect(sd.textContent).toContain('本次建议抵扣 13,950.00');
  await click('添加争议 / 扣款', sd); input('争议说明 1', '色差待确认扣款'); input('争议金额 1', '500');
  await click('提交复核', dialog('提交结算'));
  const st = store.value.state.payables.settlements[0];
  expect(st).toMatchObject({ state: 'pending', receiptIds: ['rcpt-ui'], submitterId: 'sales', disputes: [{ description: '色差待确认扣款', amount: 500 }] });
  ctx.actorId = 'finance'; ctx.actorName = '财务';
  route = { view: 'payment-vouchers', section: 'payables', id: st.id }; render();
  expect(host.textContent).toContain('等待财务复核');
  await click('确认结算'); const cd = dialog('确认结算');
  expect((getByLabelText(cd, '本次预付抵扣') as HTMLInputElement).value).toBe('13950');
  input('本次预付抵扣', '14000'); input('调整原因', '供应商同意首批多抵 50 元');
  await click('确认结算', dialog('确认结算'));
  expect(store.value.state.payables.settlements[0]).toMatchObject({ state: 'confirmed', confirmation: { suggestedPrepayment: 13950, prepaymentApplied: 14000, adjustReason: '供应商同意首批多抵 50 元' } });
  await click('按结算登记票据'); const bd = dialog('登记供应商票据');
  expect((getByLabelText(bd, po.code + ' 关联结算') as HTMLSelectElement).value).toBe(st.id);
  expect((getByLabelText(bd, po.code + ' 本票金额') as HTMLInputElement).value).toBe('46500');
  input('供应商发票号', 'VAT-ST-1'); input('税额', '0'); input('到期日', day);
  await click('登记应付', bd);
  const bill = store.value.state.payables.bills[0];
  expect(bill.lines[0]).toMatchObject({ purchaseId: po.id, amount: 46500, settlementId: st.id });
  route = { view: 'payment-vouchers', section: 'payables', id: bill.id }; render();
  expect(host.textContent).toContain('预付抵扣（来自结算）'); expect(host.textContent).toContain('14,000.00');
  expect(host.textContent).toContain('32,500.00');
  await click(/^供应商付款 · /);
  expect(getByRole(host, 'table', { name: '供应商付款' }).textContent).toContain('预付 · 部分已抵扣');
});

/** 已付预付的样例合同：33,480 预付，收货 1000 米（拒收 50）。 */
function prepaidWithReceipt() {
  as('finance', '财务', { type: 'payable.plan.register', payload: { purchaseId: po.id, amount: 33480, trigger: '合同签订后 7 天内', basis: '合同第 5 条' } });
  const req = as('sales', '业务', { type: 'payable.request.submit', payload: { purpose: 'prepayment', planId: store.value.state.payables.plans[0].id, amount: 33480, reason: '按合同申请预付' } });
  approve(String(req.id));
  as('finance', '财务', { type: 'payable.payment.register', payload: { requestId: req.id, date: day, amount: 33480, reference: 'BK-PP' } });
  store.value.state.fulfillment.receipts.push({ id: 'rcpt-ui', purchaseId: po.id, quantity: 1000, rejected: 50, destination: 'warehouse', location: '嘉兴仓', date: day, evidence: '收货单', fileIds: [], actor: '仓库', createdAt: new Date().toISOString() });
}

it('发票先到：登记为待关联结算并暂挂，汇总单列；结算确认后在票据详情关联结算，才能申请付款', async () => {
  prepaidWithReceipt(); render();
  await click(/待登记来源/); await click('登记票据', getByRole(host, 'table', { name: '待登记来源合同' }));
  const bd = dialog('登记供应商票据');
  input(po.code + ' 本票金额', '46500'); select(po.code + ' 关联结算', '__held'); input('供应商发票号', 'VAT-EARLY'); input('到期日', day);
  await click('登记应付', bd);
  const bill = store.value.state.payables.bills[0];
  expect(bill.lines[0]).toMatchObject({ awaitingSettlement: true });
  expect(getByRole(host, 'table', { name: '供应商应付汇总' }).textContent).toContain('1 张待关联结算（46,500.00 CNY）');
  expect(host.textContent).toContain('发票先于结算到达');
  expect((getAllByRole(host, 'button', { name: '申请付款' })[0] as HTMLButtonElement).disabled).toBe(true);
  const st = as('sales', '业务', { type: 'payable.settlement.submit', payload: { purchaseId: po.id, receiptIds: ['rcpt-ui'] } });
  as('finance', '财务', { type: 'payable.settlement.confirm', payload: { id: st.id, prepaymentApplied: 13950 } });
  render();
  await click('关联结算'); const ld = dialog('关联结算');
  expect((getByLabelText(ld, po.code + ' 关联结算') as HTMLSelectElement).value).toBe(st.id);
  await click('确认关联', ld);
  expect(store.value.state.payables.bills[0].lines[0]).toMatchObject({ settlementId: st.id });
  expect(host.textContent).not.toContain('发票先于结算到达');
  expect(host.textContent).toContain('13,950.00');
  expect((getAllByRole(host, 'button', { name: '申请付款' })[0] as HTMLButtonElement).disabled).toBe(false);
});

it('索赔扣款：工厂同意从货款中扣的追偿在票据上登记扣款，扣满自动落实；可冲回', async () => {
  reg('V-CL', 5000);
  const bill = store.value.state.payables.bills[0];
  store.value.state.platform = { ...(store.value.state.platform || {}), claims: [{ id: 'claim-ui', code: 'CL-2026-0042', state: 'Open', coordination: { notices: [], verifications: [], recoveries: [{ id: 'rec-ui', supplierId: po.supplierId, supplierName: po.supplier, currency: 'CNY', requested: 800, basis: '色差', state: 'Agreed', agreed: 800, method: 'deduction', agreedNote: '邮件', createdAt: '', createdBy: '业务', createdById: 'sales', events: [] }] } }] } as any;
  route = { view: 'payment-vouchers', section: 'payables', id: bill.id }; render();
  await click('登记索赔扣款'); const dd = dialog('登记索赔扣款');
  expect((getByLabelText(dd, '扣款金额') as HTMLInputElement).value).toBe('800');
  input('扣款依据', 'DN-2026-01');
  await click('登记扣款', dd);
  const rec = store.value.state.platform.claims[0].coordination.recoveries[0];
  expect(rec).toMatchObject({ state: 'Settled', settled: 800 });
  expect(host.textContent).toContain('索赔扣款'); expect(host.textContent).toContain('4,200.00 CNY');
  await click('冲回扣款'); text('冲回原因', '扣款通知作废'); await click('确认冲回', dialog('冲回索赔扣款'));
  expect(store.value.state.platform.claims[0].coordination.recoveries[0].state).toBe('Agreed');
  expect(store.value.state.payables.deductions[0].reversed).toMatchObject({ reason: '扣款通知作废' });
});

it('短交最终结算后剩余预付：在结算详情登记退款，可冲回', async () => {
  prepaidWithReceipt();
  const st = as('sales', '业务', { type: 'payable.settlement.submit', payload: { purchaseId: po.id, receiptIds: ['rcpt-ui'], final: true } });
  as('finance', '财务', { type: 'payable.settlement.confirm', payload: { id: st.id, prepaymentApplied: 33480 } });
  // 结算 46,500 已抵扣全部预付；再造一笔小额最终结算场景：用新合同数据验证剩余
  route = { view: 'payment-vouchers', section: 'payables', id: st.id }; render();
  expect(host.textContent).toContain('合同预付去向');
  expect(queryAllByRole(host, 'button', { name: '登记退款' })).toHaveLength(0);
  as('finance', '财务', { type: 'payable.settlement.reverse', payload: { id: st.id, reason: '改为小额结算' } });
  store.value.state.fulfillment.receipts.push({ id: 'rcpt-small', purchaseId: po.id, quantity: 500, rejected: 0, destination: 'warehouse', location: '嘉兴仓', date: day, evidence: '收货单', fileIds: [], actor: '仓库', createdAt: new Date().toISOString() });
  const st2 = as('sales', '业务', { type: 'payable.settlement.submit', payload: { purchaseId: po.id, receiptIds: ['rcpt-small'], final: true } });
  as('finance', '财务', { type: 'payable.settlement.confirm', payload: { id: st2.id, prepaymentApplied: 23250 } });
  route = { view: 'payment-vouchers', section: 'payables', id: st2.id }; render();
  expect(host.textContent).toContain('最终结算后仍有剩余预付');
  await click('登记退款'); const rd = dialog('登记剩余预付退款');
  expect((getByLabelText(rd, '退款金额') as HTMLInputElement).value).toBe('10230');
  input('退款流水号', 'TT-BACK'); text('退款说明', '供应商退回短交预付', rd);
  await click('登记退款', rd);
  expect(store.value.state.payables.prepaymentMoves[0]).toMatchObject({ kind: 'refund', amount: 10230, reference: 'TT-BACK' });
  expect((getAllByRole(host, 'button', { name: '冲回结算' })[0] as HTMLButtonElement).disabled).toBe(true);
  await click('冲回', host.querySelector('[data-prepayment-move]') as HTMLElement); text('冲回原因', '流水录错'); await click('确认冲回', dialog('冲回剩余预付处理'));
  expect(store.value.state.payables.prepaymentMoves[0].reversed).toMatchObject({ reason: '流水录错' });
});

const actAs = (actorId: string, command: any) => { let n = 0; const r = applyMistCommand(store.value.state, command, { id: () => `${actorId}-${Date.now()}-${++n}`, now: new Date().toISOString(), actorName: actorId, actorId, authority: { supplier: {}, paymentReviewerIds: ['manager'] } } as any); store.value.state = r.state; return r.result as any; };

it('不等票付款：已确认结算可写明未收票原因申请先付，经批准登记后显示已付未收票', async () => {
  const receipt = store.value.state.fulfillment.receipts.find((r: any) => r.purchaseId === po.id);
  const st = actAs('sales', { type: 'payable.settlement.submit', payload: { purchaseId: po.id, receiptIds: [receipt.id] } });
  actAs('finance', { type: 'payable.settlement.confirm', payload: { id: st.id, prepaymentApplied: 0 } });
  const amount = store.value.state.payables.settlements[0].amount;
  route = { view: 'payment-vouchers', section: 'payables', id: st.id }; render();
  expect(host.textContent).toContain('不等票可申请');
  await click('不等票申请付款');
  const d = dialog('不等票申请付款');
  expect((getByLabelText(d, '不等票申请金额') as HTMLInputElement).value).toBe(String(amount));
  await click('提交审批', d);
  expect(store.value.run).not.toHaveBeenCalled(); expect(d.textContent).toContain('未收票');
  input('不等票申请金额', '1000'); text('未收票原因', '工厂开票慢，货已验收', d);
  await click('提交审批', d);
  expect(store.value.run).toHaveBeenCalledWith(expect.objectContaining({ type: 'payable.request.submit', payload: expect.objectContaining({ purpose: 'settlement', settlementId: st.id, amount: 1000 }) }));
  const req = store.value.state.payables.requests[0]; approve(req.id);
  route = { view: 'payment-vouchers', section: 'payables', id: req.id }; render();
  expect(host.textContent).toContain('按结算付款（发票未到）');
  await click('登记实付'); expect(dialog('按已批准申请登记实付').textContent).toContain('自动抵到票据'); input('银行流水号', 'BANK-ADV'); await click('登记实付', dialog('按已批准申请登记实付'));
  expect(store.value.state.payables.payments[0]).toMatchObject({ purpose: 'settlement', settlementId: st.id, amount: 1000 });
  expect(getByRole(host, 'table', { name: '供应商应付汇总' }).textContent).toContain('已付未收票');
  await click(/供应商付款 ·/);
  expect(getByRole(host, 'table', { name: '供应商付款' }).textContent).toContain('已付未收票');
});

it('历史付款补登：计划详情按凭证补登，不走审批，记为历史补登', async () => {
  actAs('finance', { type: 'payable.plan.register', payload: { purchaseId: po.id, amount: 5000, trigger: '签约后', basis: '合同第 5 条' } });
  const plan = store.value.state.payables.plans[0];
  route = { view: 'payment-vouchers', section: 'payables', id: plan.id }; render();
  await click('历史付款补登'); const d = dialog('历史付款补登');
  await click('确认补登', d); expect(d.textContent).toContain('凭证号');
  input('实际付款日期', '2026-09-01'); input('付款凭证号', 'V-089'); input('补登金额', '3000');
  await click('确认补登', d);
  expect(store.value.run).toHaveBeenCalledWith(expect.objectContaining({ type: 'payable.payment.backfill', payload: expect.objectContaining({ planId: plan.id, amount: 3000, reference: 'V-089', date: '2026-09-01' }) }));
  expect(store.value.state.payables.payments[0]).toMatchObject({ backfill: true, purpose: 'prepayment', planId: plan.id });
  expect(store.value.state.payables.requests).toHaveLength(0);
  expect(host.textContent).toContain('历史补登（系统上线前已付，未走申请）');
});
