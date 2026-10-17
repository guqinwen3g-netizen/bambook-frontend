import {createMistState as newModuleFixture} from '../../../../server/src/shared/mistWorkspace';
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAllByRole, getByRole, getByLabelText, queryByRole } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import type { MistState } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';
const store = vi.hoisted(() => ({ state: null as MistState | null, loading: false, error: '', workspace: { id: 'w', ownerId: 'test-user' }, run: vi.fn(), refresh: vi.fn(), downloadFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store }));
vi.mock('../runtime/auth', () => { const useMistSession = () => ({ status:'authenticated', sessionKey:'order-test', user:{id:'test-user',displayName:'负责人'}, hasPermission:()=>true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
import { OrderListPage } from './OrderListPage';
import { OrderDetailPage } from './OrderDetailPage';
import { OrderCreatePage } from './OrderCreatePage';
import { FinancePage, parseMistReceiptCsv } from './FinancePage';
import { CustomerPage } from './CustomerPage';
import { ProductionPage, productionWindow } from './ProductionPage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root;
const go = vi.fn(), openAI = vi.fn();
const today = () => new Date().toISOString().slice(0, 10);
function fixture(): MistState {
  const date = today();
  return {
    ...newModuleFixture({actorName:'测试',now:'2026-10-13T00:00:00.000Z',id:()=>crypto.randomUUID()},'empty'),schemaVersion: 1, devs: [], versions: [], drafts: [], fabrics: [], files: [], calendar: [], tasks: [], notifications: [], events: [], allocations: [], payments: [],
    settings: { theme: 'light', density: 'default', reducedMotion: false, notifications: { qc: true, shipping: true, suggestions: true, digest: false }, workspaceName: '工作空间', profileName: '负责人', profileEmail: 'lead@example.com', locale: 'zh-CN' },
    customers: [{ id: 'customer-a', code: 'C-A', name: '客户甲', country: '中国', city: '上海', industry: '服装', owner: '负责人', grade: 'A', currency: 'USD', terms: 'T/T', incoterm: 'FOB', categories: '成衣', creditLimit: 10000, since: '2023-01-01' }],
    contacts: [{ id: 'contact-a', customerId: 'customer-a', name: '联系人甲', role: '采购', email: 'first@example.com', phone: '12345', tone: 'accent' }],
    orders: [{ id: 'order-a', code: 'SO-A', type: 'garment', customerId: 'customer-a', customer: '客户甲', season: 'AW27', lines: 1, qty: 10, amount: 100, currency: 'USD', due: date, progress: 40, state: '生产中', tone: 'accent', owner: '负责人', img: 'coat', checklist: [{ id: 'check-a', label: '装箱单草稿', done: false, note: '' }], handoffAt: null, createdAt: date, updatedAt: date }],
    orderLines: [{ id: 'line-a', orderId: 'order-a', name: '本单产品', style: 'SKU-A', img: 'coat', qty: 10, unit: '件', price: 10, made: 40, qc: 0 }, { id: 'line-other', orderId: 'other', name: '其他单产品', style: 'SKU-X', img: 'clay', qty: 999, unit: '米', price: 999, made: 0, qc: 0 }],
    productions: [{ id: 'production-a', code: 'P-A', orderId: 'order-a', lineId: 'line-a', order: 'SO-A', name: '本单产品', factory: '工厂甲', qty: 10, due: date, pct: 40, img: 'coat', col: 'sew', startDate: date }],
    receipts: [{ id: 'receipt-a', code: 'R-A', date, payer: '客户甲', amount: 60, remaining: 60, currency: 'USD', ref: 'SO-A', state: 'suggested', suggest: 'invoice-a', confidence: 98 }],
    invoices: [{ id: 'invoice-a', code: 'INV-A', orderId: 'order-a', order: 'SO-A', customer: '客户甲', due: date, amount: 100, open: 100, currency: 'USD' }, { id: 'invoice-eur', code: 'INV-EUR', orderId: 'order-a', order: 'SO-A', customer: '客户甲', due: date, amount: 100, open: 100, currency: 'EUR' }],
  };
}
let element: React.ReactNode, route: { view: string; id?: string; customerId?: string; orderLineId?: string; productionId?: string; section?: string };
function render(page: React.ReactNode, nextRoute = { view: 'orders' } as typeof route) {
  element = page; route = nextRoute;
  act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route, go, openAI, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn() }}>{element}</Nav.Provider></ToastProvider></MistRoot>));
}
async function click(node: HTMLElement) { await act(async () => node.click()); }
function input(label: string, value: string) {
  const node = getByLabelText(host, new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?$`)) as HTMLInputElement;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
function select(label: string, value: string) {
  const node = getByLabelText(host, new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?$`)) as HTMLSelectElement;
  act(() => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); });
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  store.state = fixture(); store.loading = false; store.error = ''; store.run.mockReset(); store.refresh.mockReset(); store.downloadFile.mockReset(); go.mockReset();
  store.run.mockResolvedValue({ requestId: 'r1', revision: 2, result: {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('order detail renders only its own lines and does not invent a fallback order', () => {
  render(<OrderDetailPage />, { view: 'orders/detail', id: 'order-a' });
  expect(host.textContent).toContain('本单产品'); expect(host.textContent).not.toContain('其他单产品');
  render(<OrderDetailPage />, { view: 'orders/detail', id: 'missing' }); expect(host.textContent).toContain('没有找到此订单'); expect(host.textContent).not.toContain('SO-A');
});
it('waits for the checklist acknowledgement and leaves data unchanged on rejection', async () => {
  const pending = deferred<unknown>(); store.run.mockReturnValue(pending.promise);
  render(<OrderDetailPage />, { view: 'orders/detail', id: 'order-a' });
  await click(getByRole(host, 'checkbox', { name: '装箱单草稿' }));
  expect(store.run).toHaveBeenCalledWith({ type: 'order.checklist', payload: { orderId: 'order-a', itemId: 'check-a', done: true } });
  expect(getByRole(host, 'checkbox', { name: '装箱单草稿' }).getAttribute('aria-checked')).toBe('false');
  await act(async () => pending.reject(new Error('服务器拒绝')));
  expect(host.textContent).toContain('服务器拒绝'); expect(getByRole(host, 'checkbox', { name: '装箱单草稿' }).getAttribute('aria-checked')).toBe('false');
});
it('sends one same-currency reconciliation, and refreshed shared balances appear without local fake success', async () => {
  const pending = deferred<unknown>(); store.run.mockReturnValue(pending.promise);
  render(<FinancePage />);
  expect(host.textContent).not.toContain('INV-EUR');
  await click(getByRole(host, 'button', { name: '确认核销' }));
  expect(store.run).toHaveBeenCalledTimes(1); expect(store.run).toHaveBeenCalledWith({ type: 'finance.reconcile', payload: { receiptId: 'receipt-a', invoiceId: 'invoice-a' } });
  expect(host.querySelector('.mist-toast')).toBeNull();
  store.state = { ...store.state!, receipts: store.state!.receipts.map(item => ({ ...item, remaining: 0, state: 'matched' })), invoices: store.state!.invoices.map(item => item.id === 'invoice-a' ? { ...item, open: 40 } : item) };
  await act(async () => pending.resolve({ requestId: 'r1', revision: 2, result: {} })); render(<FinancePage />);
  expect(host.textContent).toContain('已核销');
  await click(getByRole(host, 'tab', { name: /发票/ })); expect(host.textContent).toContain('40.00 USD');
});
it('customer tabs change content, preserve a failed contact edit and pass the customer to new development', async () => {
  render(<CustomerPage />, { view: 'crm', id: 'customer-a' });
  await click(getByRole(host, 'tab', { name: /联系人/ })); expect(queryByRole(host, 'table', { name: '客户订单' })).toBeNull();
  await click(getByRole(host, 'button', { name: /联系人甲/ })); input('姓名', '联系人更新');
  store.run.mockRejectedValueOnce(new Error('联系保存失败')); await click(getByRole(host, 'button', { name: '保存', exact: true } as any));
  expect(host.textContent).toContain('联系保存失败'); expect((getByLabelText(host, /^姓名/) as HTMLInputElement).value).toBe('联系人更新');
  await click(getByRole(host, 'button', { name: '取消', exact: true } as any)); await click(getByRole(host, 'button', { name: '新建开发案' }));
  expect(go).toHaveBeenCalledWith('development/new', undefined, { customerId: 'customer-a' });
});
it('creates an order from explicit independent lines and navigates only after the receipt', async () => {
  const pending = deferred<unknown>(); store.run.mockReturnValue(pending.promise);
  render(<OrderCreatePage />, { view: 'orders/new', customerId: 'customer-a' });
  input('季节 / 批次', 'AW28'); await click(getByRole(host, 'button', { name: '下一步' }));
  input('品名', '新增款式'); input('款号 / 品号', 'SKU-NEW'); input('数量', '12'); input('单价 USD', '8.50');
  await click(getByRole(host, 'button', { name: '下一步' })); input('交期', today()); expect((getByLabelText(host, /^负责人/) as HTMLSelectElement).value).toBe('test-user');
  await click(getByRole(host, 'button', { name: '下一步' })); await click(getByRole(host, 'button', { name: '下一步' })); await click(getByRole(host, 'button', { name: '创建订单草稿' }));
  expect(store.run.mock.calls[0][0]).toMatchObject({ type: 'order.create', payload: { customerId: 'customer-a', ownerId: 'test-user', lines: [{ name: '新增款式', style: 'SKU-NEW', qty: 12, price: 8.5, unit: '件' }] } });
  expect(go).not.toHaveBeenCalled(); await act(async () => pending.resolve({ requestId: 'r1', revision: 2, result: { orderId: 'new-order' } }));
  expect(go).toHaveBeenCalledWith('orders/detail', 'new-order',{customerId:'customer-a',section:'garment'});
});
it('production edits persist a typed command and keep the entered value when saving fails', async () => {
  render(<ProductionPage />, { view: 'production-board', productionId: 'production-a' });
  input('生产进度（%）', '75'); store.run.mockRejectedValueOnce(new Error('进度未保存')); await click(getByRole(host, 'button', { name: '保存进度' }));
  expect(store.run.mock.calls[0][0]).toMatchObject({ type: 'production.update', payload: { id: 'production-a', pct: 75 } });
  expect((getByLabelText(host, '生产进度（%）') as HTMLInputElement).value).toBe('75'); expect(host.textContent).toContain('进度未保存');
});
it('dragging a production card waits for persistence and re-renders the acknowledged column', async () => {
  const pending = deferred<unknown>(); store.run.mockReturnValue(pending.promise);
  render(<ProductionPage />, { view: 'production-board' });
  const card = host.querySelector<HTMLElement>('.mist-kb-card')!, destination = host.querySelector<HTMLElement>('.mist-kb-col')!;
  await act(async () => card.dispatchEvent(new Event('dragstart', { bubbles: true })));
  await act(async () => destination.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })));
  await act(async () => destination.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })));
  expect(store.run).toHaveBeenCalledWith({ type: 'production.move', payload: { id: 'production-a', col: 'cut' } });
  expect(destination.querySelector('.mist-kb-card')).toBeNull();
  store.state = { ...store.state!, productions: store.state!.productions.map(item => ({ ...item, col: 'cut' })) };
  await act(async () => pending.resolve({ requestId: 'r2', revision: 2, result: {} })); render(<ProductionPage />, { view: 'production-board' });
  expect(host.querySelector('.mist-kb-col .mist-kb-card')?.textContent).toContain('本单产品');
});
it('imports an actual CSV file only after review, and retains its rows if the command fails', async () => {
  render(<FinancePage />);
  const file = new File(['日期,付款方,金额,币种,附言\n2026-10-13,客户乙,25.50,USD,引用B'], 'receipts.csv', { type: 'text/csv' });
  const picker = getByLabelText(host, '银行流水文件') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(store.run).not.toHaveBeenCalled(); expect(getByRole(host, 'dialog').textContent).toContain('客户乙');
  store.run.mockRejectedValueOnce(new Error('导入未提交')); await click(getByRole(host, 'button', { name: '确认导入 1 笔' }));
  expect(store.run).toHaveBeenCalledWith({ type: 'finance.importReceipts', payload: { receipts: [{ date: '2026-10-13', payer: '客户乙', amount: 25.5, currency: 'USD', ref: '引用B' }] } });
  expect(getByRole(host, 'dialog').textContent).toContain('导入未提交'); expect(getByRole(host, 'dialog').textContent).toContain('客户乙');
});
it('payment vouchers use their own payment command and keep the form after failure', async () => {
  render(<FinancePage />); await click(getByRole(host, 'tab', { name: /付款凭证/ }));
  await click(getAllByRole(host, 'button', { name: '登记付款' })[0]);
  input('收款方', '供应商甲'); input('金额', '88.90'); input('附言', '加工费');
  store.run.mockRejectedValueOnce(new Error('付款记录未保存')); await click(getByRole(host, 'button', { name: '保存付款' }));
  expect(store.run.mock.calls[0][0]).toMatchObject({ type: 'finance.payment.save', payload: { payee: '供应商甲', amount: 88.9, currency: 'USD', ref: '加工费' } });
  expect((getByLabelText(host, /^收款方/) as HTMLInputElement).value).toBe('供应商甲'); expect(host.textContent).toContain('付款记录未保存');
});
it('parses quoted bank CSV values and rejects invalid amounts before creating a command', () => {
  expect(parseMistReceiptCsv('日期,付款方,金额,币种,附言\n2026-10-13,"Client, Ltd","1,250.50",usd,"SO-A"')).toEqual([{ date: '2026-10-13', payer: 'Client, Ltd', amount: 1250.5, currency: 'USD', ref: 'SO-A' }]);
  expect(() => parseMistReceiptCsv('日期,付款方,金额,币种,附言\n2026-10-13,Client,-2,USD,SO-A')).toThrow('第 2 行');
  const range = productionWindow('week', new Date('2026-10-14T12:00:00')); expect(range.start.getDay()).toBe(1); expect((range.end.getTime() - range.start.getTime()) / 86400000).toBe(7);
});
it('opens a fabric list in its incoming family and retains that scope when opening an order',async()=>{store.state!.orders.push({...store.state!.orders[0],id:'fabric-order',code:'SO-FABRIC',type:'fabric'});render(<OrderListPage/>,{view:'orders',section:'fabric',customerId:'customer-a'});expect(getByRole(host,'tab',{name:/面料订单/}).getAttribute('aria-selected')).toBe('true');await click(getByRole(host,'row',{name:/SO-FABRIC/}));expect(go).toHaveBeenCalledWith('orders/detail','fabric-order',{customerId:'customer-a',section:'fabric'});});
