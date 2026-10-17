// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAllByRole, getByLabelText, getByRole } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { applyMistCommand, createMistState, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { Nav, type Route } from '../nav';
const store = vi.hoisted(() => ({ state: null as MistState | null, loading: false, error: '', workspace: { id: 'a', ownerId: 'u' } as { id: string; ownerId?: string }, run: vi.fn(), refresh: vi.fn() }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store }));
vi.mock('../runtime/auth', () => { const useMistSession = () => ({ status: 'authenticated', sessionKey: 's', user: { id: 'u', displayName: '业务员甲' }, hasPermission: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
import { OrderCreatePage } from './OrderCreatePage';
import { OrderLineFulfillment } from './OrderLineFulfillment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, sequence = 0;
const go = vi.fn();
const context = { id: () => `id-${++sequence}`, now: '2026-10-16T02:00:00.000Z', actorName: '业务员甲', actorId: 'u' };
function render(route: Route, page: React.ReactNode) { act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route, go, openAI: vi.fn(), theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn() }}>{page}</Nav.Provider></ToastProvider></MistRoot>)); }
function input(label: string | RegExp, value: string) {
  const node = getByLabelText(host, typeof label === 'string' ? new RegExp(`^${label.replace(/[()（）/]/g, m => '\\' + m)}\\s*\\*?$`) : label) as HTMLInputElement;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
const next = () => click(getByRole(host, 'button', { name: '下一步' }));
beforeEach(() => {
  sequence = 0; go.mockReset();
  store.state = createMistState(context, 'empty');
  store.state.customers.push({ id: 'customer-a', code: 'C-A', name: '客户甲', country: '', city: '', industry: '', owner: '业务员甲', grade: 'A', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-01-01' });
  store.run.mockReset();
  store.run.mockImplementation(async command => { const result = applyMistCommand(store.state!, command, context); Object.assign(store.state!, result.state); return { requestId: 'r', revision: 2, result: result.result }; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

it('BB-ORD-3 creates a 2 colour × 4 size garment order; quantity follows the grid and reads back', async () => {
  render({ view: 'orders/new', customerId: 'customer-a', section: 'garment' }, <OrderCreatePage />);
  input('季节 / 批次', 'AW27'); await next();
  input('品名', '大衣'); input('款号 / 品号', 'C1'); input('单价 USD', '50');
  await click(getByRole(host, 'button', { name: '按颜色 × 尺码填写数量' }));
  await click(getByRole(host, 'button', { name: '添加颜色' }));
  input('条目 1 颜色 1', '藏青'); input('条目 1 颜色 2', '黑');
  ['10', '20', '30', '40'].forEach((v, i) => input(`条目 1 藏青 · ${['S', 'M', 'L', 'XL'][i]} 数量`, v));
  input('条目 1 黑 · S 数量', '5'); input('条目 1 黑 · L 数量', '15');
  expect(host.querySelector('[data-breakdown-total]')!.textContent).toBe('合计 120 件');
  expect((getByLabelText(host, /^数量/) as HTMLInputElement).disabled).toBe(true);
  await next(); input('交期', '2026-12-01'); await next();
  expect(host.querySelector('[data-breakdown-summary]')!.textContent).toBe('藏青：S 10 / M 20 / L 30 / XL 40；黑：S 5 / M 0 / L 15 / XL 0（合计 120 件）');
  await next();
  expect(host.textContent).toContain('C1 · 分色分码');
  await click(getByRole(host, 'button', { name: '创建订单草稿' }));
  const payload = store.run.mock.calls[0][0].payload.lines[0];
  expect(payload).toMatchObject({ qty: 120, breakdown: { kind: 'garment', sizes: ['S', 'M', 'L', 'XL'] } });
  expect(payload.seed).toBeUndefined();
  const order = store.state!.orders[0], line = store.state!.orderLines.find(row => row.orderId === order.id)!;
  expect(line).toMatchObject({ qty: 120, breakdown: { rows: [{ color: '藏青', quantities: [10, 20, 30, 40] }, { color: '黑', quantities: [5, 0, 15, 0] }] } });
  act(() => root.render(<MistRoot><ToastProvider><OrderLineFulfillment state={store.state!} order={order} line={line} go={go} /></ToastProvider></MistRoot>));
  expect(host.querySelector('[data-line-breakdown-summary]')!.textContent).toContain('黑：S 5 / M 0 / L 15 / XL 0（合计 120 件）');
});

it('BB-ORD-3 blocks an all-zero grid before submission and keeps legacy lines as "未分色分码"', async () => {
  render({ view: 'orders/new', customerId: 'customer-a', section: 'garment' }, <OrderCreatePage />);
  input('季节 / 批次', 'AW27'); await next();
  input('品名', '大衣'); input('款号 / 品号', 'C1'); input('单价 USD', '50');
  await click(getByRole(host, 'button', { name: '按颜色 × 尺码填写数量' }));
  input('条目 1 颜色 1', '藏青');
  await next();
  expect(host.textContent).toContain('分色分码至少一格大于 0');
  await click(getByRole(host, 'button', { name: '清除分色分码' }));
  input('数量', '7'); await next();
  expect(host.textContent).not.toContain('分色分码至少一格大于 0');
  const line = { id: 'l', orderId: 'o', name: '大衣', style: 'C1', img: 'coat', qty: 7, unit: '件', price: 1, made: 0, qc: 0 } as never;
  act(() => root.render(<MistRoot><ToastProvider><OrderLineFulfillment state={store.state!} order={{ id: 'o', code: 'SO', type: 'garment', customer: '客户甲' } as never} line={line} go={go} /></ToastProvider></MistRoot>));
  expect(host.querySelector('[data-line-breakdown-summary]')!.textContent).toBe('未分色分码');
});

it('BB-ORD-3 brings colours, width, weight and composition from a fabric development version', async () => {
  const s = store.state!;
  s.devs.push({ id: 'dev-f', code: 'DEV-F1', name: '双面呢开发', style: 'F-01', customerId: 'customer-a', customer: '客户甲', img: 'clay', values: { domain: 'fabric' }, versionIds: ['ver-f'] } as never);
  s.versions.push({ id: 'ver-f', devId: 'dev-f', label: 'R1-A', factory: '织厂', img: 'clay', size: '', sampleColor: '藏青 NV-01，黑 BK-02', fabricRequirements: { composition: '100% 羊毛', widthValue: '150', widthUnit: 'cm', weightValue: '320', weightUnit: 'g/m²' }, confirmations: [{ id: 'c', result: 'approved' }], archivedAt: null } as never);
  render({ view: 'orders/new', versionId: 'ver-f', customerId: 'customer-a', section: 'fabric' }, <OrderCreatePage />);
  input('季节 / 批次', 'AW27'); await next();
  input('单价 USD', '8');
  await click(getByRole(host, 'button', { name: '填写面料规格与分色数量' }));
  expect((getByLabelText(host, '条目 1 门幅（cm）') as HTMLInputElement).value).toBe('150');
  expect((getByLabelText(host, '条目 1 克重（g/m²）') as HTMLInputElement).value).toBe('320');
  expect((getByLabelText(host, '条目 1 成分') as HTMLInputElement).value).toBe('100% 羊毛');
  input('条目 1 藏青 NV-01 数量', '300'); input('条目 1 黑 BK-02 数量', '200.5');
  await next(); input('交期', '2026-12-01'); await next(); await next();
  await click(getByRole(host, 'button', { name: '创建订单草稿' }));
  const line = store.state!.orderLines.find(row => row.orderId === store.state!.orders[0]?.id)!;
  expect(line).toMatchObject({ qty: 500.5, sourceVersionId: 'ver-f', breakdown: { kind: 'fabric', width: 150, weight: 320, composition: '100% 羊毛', rows: [{ color: '藏青 NV-01', quantity: 300 }, { color: '黑 BK-02', quantity: 200.5 }] } });
  expect(getAllByRole).toBeTruthy();
});
