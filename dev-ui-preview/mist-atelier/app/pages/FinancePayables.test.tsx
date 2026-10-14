// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { getAllByRole, getByRole, getByLabelText } from '@testing-library/dom';
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
  let serial = 0; const context = { id: () => `ui-${++serial}`, actorName: '财务', actorId: 'finance', now: new Date().toISOString() };
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

it('一笔付款分到两张票，没分完的钱保留并提示，之后可再分配', async () => {
  const reg = (no: string, amount: number) => { store.value.state = applyMistCommand(store.value.state, { type: 'payable.bill.register', payload: { supplierId: po.supplierId, invoiceNo: no, invoiceDate: day, currency: 'CNY', amount, taxAmount: 0, lines: [{ purchaseId: po.id, amount }], due: day, dueBasis: '测试' } } as any, { id: (() => { let n = 0; return () => no + (++n); })(), now: new Date().toISOString(), actorName: '财务' }).state; };
  reg('A-1', 300); reg('A-2', 200); render();
  const [a, b] = store.value.state.payables.bills;
  await click('登记供应商付款');
  select('收款供应商', po.supplierId); input('付款金额', '600'); input('银行流水号', 'BK-1');
  expect(getByRole(document.body, 'dialog', { name: '登记供应商付款' }).querySelector('[data-pay-bill]')?.classList.contains('mist-module-actions')).toBe(true);
  input(a.code + ' 分配金额', '300'); input(b.code + ' 分配金额', '250');
  await click('登记付款', getByRole(document.body, 'dialog', { name: '登记供应商付款' }));
  expect(store.value.run).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('不能超过票据未付余额');
  input(b.code + ' 分配金额', '100');
  await click('登记付款', getByRole(document.body, 'dialog', { name: '登记供应商付款' }));
  const pay = store.value.state.payables.payments[0];
  expect(store.value.state.payables.allocations).toHaveLength(2);
  expect(host.textContent).toContain('还有钱没分到票据上');
  expect(store.value.state.payments.at(-1)).toMatchObject({ payee: po.supplier, amount: 600, ref: 'BK-1' });
  route = { view: 'payment-vouchers', section: 'payables', id: pay.id }; render();
  await click('分配到应付'); input(b.code + ' 分配金额', '100'); await click('确认分配');
  expect(store.value.state.payables.allocations).toHaveLength(3);
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

it('没有财务写权限：可以查看，登记按钮禁用', async () => {
  store.value.canWrite = false; render();
  expect((getByRole(host, 'button', { name: '登记供应商票据' }) as HTMLButtonElement).disabled).toBe(true);
  expect((getByRole(host, 'button', { name: '登记供应商付款' }) as HTMLButtonElement).disabled).toBe(true);
  await click(/待登记来源/); expect(getByRole(host, 'table', { name: '待登记来源合同' }).textContent).toContain(po.code);
  expect(store.value.run).not.toHaveBeenCalled();
});

function permissionBill() {
  let serial = 0;
  store.value.state = applyMistCommand(store.value.state, { type: 'payable.bill.register', payload: { supplierId: po.supplierId, invoiceNo: 'PERMISSION-VAT', invoiceDate: day, currency: 'CNY', amount: 100, taxAmount: 0, lines: [{ purchaseId: po.id, amount: 100 }], due: day, dueBasis: '隔离权限回归' } }, { id: () => 'permission-' + (++serial), now: new Date().toISOString(), actorName: '财务' }).state;
  return store.value.state.payables.bills[0];
}
it('只有付款登记权限时不预填或开放核销分配，仍可登记未分配付款', async () => {
  const bill = permissionBill();
  store.value.permissions = ['vouchers:write'];
  route = { view: 'payment-vouchers', section: 'payables', id: bill.id }; render();
  await click('登记付款');
  const dialog = getByRole(document.body, 'dialog', { name: '登记供应商付款' });
  const allocation = getByLabelText(dialog, bill.code + ' 分配金额') as HTMLInputElement;
  expect(allocation.disabled).toBe(true);
  expect(allocation.value).toBe('');
  expect(dialog.textContent).toContain('没有核销分配权限');
  input('银行流水号', 'PAY-WITHOUT-ALLOCATION');
  await click('登记付款', dialog);
  expect(store.value.run).toHaveBeenCalledWith(expect.objectContaining({ type: 'payable.payment.register', payload: expect.objectContaining({ amount: 100, allocations: [] }) }));
  expect(store.value.state.payables.allocations).toEqual([]);
  expect(host.textContent).toContain('还有钱没分到票据上');
});
it('打开表单后失去核销权限，不能提交已填分配的复合付款', async () => {
  const bill = permissionBill(); render();
  await click('登记供应商付款');
  select('收款供应商', po.supplierId); input('付款金额', '100'); input('银行流水号', 'STALE-SCOPE'); input(bill.code + ' 分配金额', '100');
  store.value.permissions = ['vouchers:write']; render();
  await click('登记付款', getByRole(document.body, 'dialog', { name: '登记供应商付款' }));
  expect(store.value.run).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('没有办理此项财务动作的权限');
});
