// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getByRole, getByLabelText, queryByRole } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { applyMistCommand, createMistState, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';
const store = vi.hoisted(() => ({ state: null as MistState | null, loading: false, error: '', run: vi.fn(), refresh: vi.fn(), downloadFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => ({ status: 'authenticated', sessionKey: 't', user: { id: 'sales', displayName: '业务员甲' }, hasPermission: () => true }) }));
import { OrderDetailPage } from './OrderDetailPage';
import { OrderListPage } from './OrderListPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, orderId: string, sequence = 0;
const go = vi.fn();
const context = { id: () => `term-${++sequence}`, now: '2026-10-13T02:00:00.000Z', actorName: '业务员甲' };
type G = { governance: { status: string; approvedSnapshot?: unknown; cancellation?: Record<string, unknown>; termination?: Record<string, unknown> } };
const gov = (i = 0) => (store.state!.orders[i] as unknown as G).governance;
function render(view: 'orders/detail' | 'orders' = 'orders/detail') {
  act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route: { view, id: view === 'orders' ? undefined : orderId }, go, openAI: vi.fn(), theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn() }}>{view === 'orders' ? <OrderListPage /> : <OrderDetailPage />}</Nav.Provider></ToastProvider></MistRoot>));
}
beforeEach(() => {
  sequence = 0; go.mockClear(); store.run.mockReset();
  const empty = createMistState(context, 'empty');
  empty.customers.push({ id: 'customer-a', code: 'C-A', name: '客户甲', country: '', city: '', industry: '', owner: '业务员甲', grade: 'A', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-01-01' });
  const result = applyMistCommand(empty, { type: 'order.create', payload: { type: 'garment', customerId: 'customer-a', season: 'AW28', currency: 'USD', due: '2026-10-30', owner: '业务员甲', lines: [{ name: '外套', style: 'T-01', img: 'coat', qty: 10, unit: '件', price: 1 }] } }, context);
  store.state = result.state; orderId = result.result.orderId!;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('voids a draft only with a reason and sends the void command', async () => {
  render();
  await act(async () => getByRole(host, 'button', { name: '作废订单' }).click());
  const dialog = getByRole(document.body, 'dialog', { name: /作废订单/ });
  expect(dialog.textContent).toContain('记录不删除');
  await act(async () => getByRole(dialog, 'button', { name: '确认作废' }).click());
  expect(dialog.textContent).toContain('请填写作废原因'); expect(store.run).not.toHaveBeenCalled();
  const input = getByLabelText(dialog, '作废原因') as HTMLTextAreaElement;
  await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!; set.call(input, '客户未下单'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  store.run.mockResolvedValue({});
  await act(async () => getByRole(dialog, 'button', { name: '确认作废' }).click());
  expect(store.run).toHaveBeenCalledWith({ type: 'order.governance.void', payload: { orderId, reason: '客户未下单' } });
});

it('shows a voided order as read-only without edit, submit or termination actions', () => {
  Object.assign(gov(), { status: 'void', termination: { kind: 'void', reason: '客户未下单', at: context.now, byName: '业务员甲' } });
  store.state!.orders[0].state = '已作废';
  render();
  expect(host.textContent).toContain('订单已作废，只读');
  expect(host.textContent).not.toContain('待审批');
  expect(host.textContent).not.toContain('批准前不能采购或履约');
  expect((getByRole(host, 'button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true);
  expect(queryByRole(host, 'button', { name: '提交主单审批' })).toBeNull();
  expect(queryByRole(host, 'button', { name: '作废订单' })).toBeNull();
});

it('offers cancellation for an approved order and blocks it after departure, pointing to line closure', async () => {
  Object.assign(gov(), { status: 'approved' });
  render();
  await act(async () => getByRole(host, 'button', { name: '申请取消订单' }).click());
  let dialog = getByRole(document.body, 'dialog', { name: /申请取消订单/ });
  expect(dialog.textContent).toContain('申请人不能审批自己的申请');
  expect((getByRole(dialog, 'button', { name: '提交取消审批' }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => getByRole(dialog, 'button', { name: '返回' }).click());
  store.state!.fulfillment.shipments.push({ id: 'sh', code: 'SH-9', lines: [{ orderId, lineId: store.state!.orderLines[0].id, quantity: 5 }], state: 'departed' } as never);
  render();
  await act(async () => getByRole(host, 'button', { name: '申请取消订单' }).click());
  dialog = getByRole(document.body, 'dialog', { name: /申请取消订单/ });
  expect(dialog.textContent).toContain('不能整单取消，请改用条目结案');
  expect(dialog.textContent).toContain('SH-9');
  expect((getByRole(dialog, 'button', { name: '提交取消审批' }) as HTMLButtonElement).disabled).toBe(true);
});

it('locks the order while cancellation is pending', () => {
  Object.assign(gov(), { status: 'approved', cancellation: { id: 'c', status: 'pending', reason: '客户撤单', requesterName: '业务员甲', requesterId: 'sales', reviewerIds: ['leader'], requestedAt: context.now } });
  render();
  expect(host.textContent).toContain('取消订单审批中，订单已锁定');
  expect((getByRole(host, 'button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true);
  expect(queryByRole(host, 'button', { name: '申请取消订单' })).toBeNull();
});

it('hides voided and cancelled orders from the list and in-transit count by default but allows filtering them', async () => {
  const base = store.state!.orders[0];
  store.state!.orders.push({ ...base, id: 'void', code: 'SO-VOID', state: '已作废', governance: { ...gov(), status: 'void' } } as never, { ...base, id: 'cx', code: 'SO-CANCEL', state: '已取消', governance: { ...gov(), status: 'cancelled' } } as never);
  render('orders');
  expect(host.textContent).not.toContain('SO-VOID'); expect(host.textContent).not.toContain('SO-CANCEL');
  expect(host.textContent).toContain(base.code);
  expect(host.textContent).toContain('全部（不含作废 / 取消）');
});
