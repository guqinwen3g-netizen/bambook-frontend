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
let po: any;
beforeEach(() => {
  let serial = 0; const context = { id: () => `ui-${++serial}`, actorName: '财务', actorId: 'finance', now: new Date().toISOString(), authority: { supplier: {}, paymentReviewerIds: ['manager'] } };
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
  await click('登记预付款计划');
  select('来源合同', po.id); input('预付金额', '33480'); input('付款触发条件', '合同回签后 7 天内');
  expect((getByLabelText(document.body, '合同条款依据') as HTMLInputElement).value).toContain('合同付款条件');
  await click('登记计划', dialog('登记预付款计划'));
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
  for (const name of ['登记供应商票据', '登记预付款计划', '申请票据付款']) expect((getByRole(host, 'button', { name }) as HTMLButtonElement).disabled).toBe(true);
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
