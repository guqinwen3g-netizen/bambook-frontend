// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAllByRole, getByLabelText, getByRole } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { applyMistCommand, createMistState, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { developmentDomain } from '../../../../server/src/shared/mistDevelopmentDomain';
import { Nav, type Route } from '../nav';
const store = vi.hoisted(() => ({ state: null as MistState | null, loading: false, error: '', workspace: { id: 'a' } as { id: string }, run: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({ write: true }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => ({ status: 'authenticated', sessionKey: 's', user: { id: 'u', displayName: '业务员甲' }, hasPermission: () => auth.write }) }));
import { OrderCreatePage } from './OrderCreatePage';
import { OrderListPage } from './OrderListPage';
import { currentLineStage, lineShipping, lineStages } from './orderLineTrack';
import { OrderLineSourceValue } from './orderLineSource';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root, sequence = 0;
const go = vi.fn();
const context = { id: () => `id-${++sequence}`, now: '2026-10-13T02:00:00.000Z', actorName: '业务员甲' };
const product = { id: 'prd-1', sku: 'CC-COAT-14', name: '双面羊毛大衣', category: 'garment', status: 'active', season: 'AW27', supplierId: '', supplierCode: '', composition: '', specification: '双面呢', color: '', unit: '件', cost: '', currency: 'USD', sourceDevId: '', sourceVersionId: '' };
function render(route: Route, page: React.ReactNode) { act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route, go, openAI: vi.fn(), theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn() }}>{page}</Nav.Provider></ToastProvider></MistRoot>)); }
function input(label: string, value: string, scope: HTMLElement = host) {
  const node = getByLabelText(scope, new RegExp(`^${label}\\s*\\*?$`)) as HTMLInputElement;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
beforeEach(() => {
  sequence = 0; auth.write = true; go.mockReset();
  store.state = createMistState(context, 'empty');
  store.state.customers.push({ id: 'customer-a', code: 'C-A', name: '客户甲', country: '', city: '', industry: '', owner: '业务员甲', grade: 'A', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-01-01' });
  store.state.market.products.push({ ...product, createdAt: '', updatedAt: '' } as never);
  store.run.mockReset();
  store.run.mockImplementation(async command => { const result = applyMistCommand(store.state!, command, context); Object.assign(store.state!, result.state); return { requestId: 'r', revision: 2, result: result.result }; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

it('carries a product archive source into the draft and stamps it on the created line', async () => {
  render({ view: 'orders/new', id: 'product:prd-1', customerId: 'customer-a', section: 'garment' }, <OrderCreatePage />);
  expect(host.textContent).toContain('来源：数字档案 CC-COAT-14');
  input('季节 / 批次', 'AW27 复购'); await click(getByRole(host, 'button', { name: '下一步' }));
  expect((getByLabelText(host, /^品名/) as HTMLInputElement).value).toBe('双面羊毛大衣');
  expect((getByLabelText(host, /^款号 \/ 品号/) as HTMLInputElement).value).toBe('CC-COAT-14');
  input('数量', '300'); input('单价 USD', '62'); await click(getByRole(host, 'button', { name: '下一步' }));
  input('交期', '2026-12-01'); await click(getByRole(host, 'button', { name: '下一步' })); await click(getByRole(host, 'button', { name: '下一步' }));
  await click(getByRole(host, 'button', { name: '创建订单草稿' }));
  // BB-ORD-2：来源随 order.create 一次写入，不再二次调用 order.governance.saveDraft
  expect(store.run.mock.calls.map(call => call[0].type)).toEqual(['order.create']);
  expect(store.run.mock.calls[0][0].payload.lines[0]).toMatchObject({ sourceProductId: 'prd-1', qty: 300 });
  const order = store.state!.orders[0], line = store.state!.orderLines.find(row => row.orderId === order.id) as { sourceProductId?: string; qty: number };
  expect(line.sourceProductId).toBe('prd-1'); expect(line.qty).toBe(300);
  expect(go).toHaveBeenCalledWith('orders/detail', order.id, { customerId: 'customer-a', section: 'garment' });
});

it('converts an accepted quotation from the new-order source dialog and keeps manual entry available', async () => {
  store.state!.market.quotations.push({ id: 'qt-1', code: 'QT-0042', customerId: 'customer-a', currency: 'USD', season: 'AW27', validUntil: '2026-10-31', deliveryTerms: 'FOB', paymentTerms: 'TT', status: 'Accepted', lines: [{ id: 'ql', productId: 'prd-1', sourceDevId: '', sourceVersionId: '', name: '双面羊毛大衣', style: 'CC-COAT-14', specification: '', qty: '600', unit: '件', price: '64', amount: '38400', cost: '' }], total: '38400.00', deliveryEvidence: '', responseEvidence: '', approval: null, convertedOrderId: null, createdAt: '', updatedAt: '' } as never);
  render({ view: 'orders' }, <OrderListPage />);
  await click(getAllByRole(host, 'button', { name: '新建订单' })[0]);
  const dialog = getByRole(document.body, 'dialog');
  expect(getByRole(dialog, 'button', { name: /从开发版本转单/ }).hasAttribute('disabled')).toBe(true);
  await click(getByRole(dialog, 'button', { name: /从报价转单/ }));
  await click(getByRole(document.body, 'radio', { name: /QT-0042/ }));
  input('订单交期', '2026-12-10', document.body);
  await click(getByRole(document.body, 'button', { name: '转为订单草稿' }));
  expect(store.run).toHaveBeenCalledWith({ type: 'market.quotation.convert', payload: { id: 'qt-1', type: 'garment', due: '2026-12-10', owner: '业务员甲', lineIds: ['ql'] } });
  const order = store.state!.orders[0];
  expect(go).toHaveBeenCalledWith('orders/detail', order.id, { customerId: undefined, section: 'garment' });
  await click(getAllByRole(host, 'button', { name: '新建订单' })[0]);
  expect(getByRole(document.body, 'button', { name: /从报价转单/ }).hasAttribute('disabled')).toBe(true);
  await click(getByRole(document.body, 'button', { name: /手工新建/ }));
  expect(go).toHaveBeenLastCalledWith('orders/new', undefined, { customerId: undefined, section: 'garment' });
});

it('BB-QUO-5 converts only the ticked quotation lines and keeps the rest available for a later order', async () => {
  const line = (id: string, qty: string) => ({ id, productId: 'prd-1', sourceDevId: '', sourceVersionId: '', name: '双面羊毛大衣 ' + id, style: 'CC-COAT-14', specification: '', qty, unit: '件', price: '64', amount: String(Number(qty) * 64), cost: '' });
  store.state!.market.quotations.push({ id: 'qt-2', code: 'QT-0050', customerId: 'customer-a', currency: 'USD', season: 'AW27', validUntil: '2026-10-31', deliveryTerms: 'FOB', paymentTerms: 'TT', status: 'Accepted', lines: [line('qa', '100'), line('qb', '200')], total: '19200.00', deliveryEvidence: '', responseEvidence: '', approval: null, convertedOrderId: null, createdAt: '', updatedAt: '' } as never);
  render({ view: 'orders' }, <OrderListPage />);
  await click(getAllByRole(host, 'button', { name: '新建订单' })[0]);
  await click(getByRole(document.body, 'button', { name: /从报价转单/ }));
  await click(getByRole(document.body, 'radio', { name: /QT-0050/ }));
  const box = (name: string) => getByRole(getByRole(document.body, 'group', { name: '本次转单条目' }), 'checkbox', { name: new RegExp(name) }) as HTMLInputElement;
  expect(box('qa').checked).toBe(true); expect(box('qb').checked).toBe(true);
  await click(box('qb'));
  input('订单交期', '2026-12-10', document.body);
  await click(getByRole(document.body, 'button', { name: '转为订单草稿' }));
  expect(store.run).toHaveBeenCalledWith({ type: 'market.quotation.convert', payload: { id: 'qt-2', type: 'garment', due: '2026-12-10', owner: '业务员甲', lineIds: ['qa'] } });
  const first = store.state!.orders[0];
  expect(store.state!.orderLines.filter(row => row.orderId === first.id).map(row => row.qty)).toEqual([100]);
  await click(getAllByRole(host, 'button', { name: '新建订单' })[0]);
  await click(getByRole(document.body, 'button', { name: /从报价转单/ }));
  const radio = getByRole(document.body, 'radio', { name: /QT-0050/ });
  expect(radio.textContent).toContain('1/2 个条目可转');
  await click(radio);
  expect(box('qb').checked).toBe(true);
  expect(() => box('qa')).toThrow();
});

it('derives line stages and short shipment only from recorded facts', () => {
  const s = store.state!; const order = { id: 'o', code: 'SO-1', type: 'garment', customer: '客户甲' } as never;
  const line = { id: 'l', orderId: 'o', name: '大衣', style: 'C1', img: 'coat', qty: 100, unit: '件', price: 1, made: 0, qc: 0 } as never;
  s.productions.push({ id: 'p', code: 'P-1', orderId: 'o', lineId: 'l', order: 'SO-1', name: '大衣', factory: '甲厂', qty: 100, due: '2026-11-01', pct: 80, img: 'coat', col: 'qc' });
  const task = (id: string, kind: 'sample' | 'production') => ({ id, code: id, kind, domain: 'garment', source: { kind: 'orderLine', orderId: 'o', lineId: 'l', ...(kind === 'production' ? { productionId: 'p' } : {}) }, factory: '甲厂', location: '', contact: '', due: '', requestedBy: '', assignee: '', state: 'reported', reportIds: [id + 'r'], createdAt: '' });
  s.fulfillment.qcTasks.push(task('qs', 'sample') as never, task('qp', 'production') as never);
  s.fulfillment.qcReports.push({ id: 'qsr', taskId: 'qs', result: 'pass' } as never, { id: 'qpr', taskId: 'qp', result: 'reject' } as never);
  s.fulfillment.shipments.push({ id: 'sh', code: 'SHP-1', state: 'departed', plannedDate: '2026-10-01', lines: [{ lineId: 'l', orderId: 'o', productionId: 'p', quantity: 96, factoryConfirmedAt: '' }] } as never);
  const stages = lineStages(s, order, line);
  expect(stages.map(stage => [stage.key, stage.state])).toEqual([['pp', 'done'], ['material', 'todo'], ['cut', 'done'], ['inspection', 'blocked'], ['completion', 'todo'], ['shipment', 'now']]);
  expect(currentLineStage(stages)?.key).toBe('inspection');
  expect(currentLineStage(stages)?.target).toEqual({ view: 'qc-workbench', id: 'qp' });
  expect(lineShipping(s, line)).toMatchObject({ planned: 96, departed: 96, variance: -4, variancePercent: -4 });
});

it('BB-QUO-4: blocks converting a quotation whose development version lacks requester approval and explains which line/version', async () => {
  const demo = createMistState(context, 'demo');
  const version = demo.versions.find(v => !v.archivedAt && developmentDomain(demo.devs.find(d => d.id === v.devId)!.values) !== 'fabric')!;
  const dev = demo.devs.find(d => d.id === version.devId)!;
  store.state!.devs.push(dev); store.state!.versions.push({ ...version, confirmations: [] });
  store.state!.market.quotations.push({ id: 'qt-2', code: 'QT-0043', customerId: 'customer-a', currency: 'USD', season: 'AW27', validUntil: '2026-10-31', deliveryTerms: 'FOB', paymentTerms: 'TT', status: 'Accepted', lines: [{ id: 'ql2', productId: '', sourceDevId: dev.id, sourceVersionId: version.id, name: '版本来源大衣', style: dev.style, specification: '', qty: '10', unit: '件', price: '64', amount: '640', cost: '' }], total: '640.00', deliveryEvidence: '', responseEvidence: '', approval: null, convertedOrderId: null, createdAt: '', updatedAt: '' } as never);
  render({ view: 'orders' }, <OrderListPage />);
  await click(getAllByRole(host, 'button', { name: '新建订单' })[0]);
  await click(getByRole(getByRole(document.body, 'dialog'), 'button', { name: /从报价转单/ }));
  await click(getByRole(document.body, 'radio', { name: /QT-0043/ }));
  const submit = getByRole(document.body, 'button', { name: '转为订单草稿' });
  expect(submit.hasAttribute('disabled')).toBe(true);
  const text = document.body.querySelector('[data-convert-blockers]')?.textContent || '';
  expect(text).toContain('版本来源大衣'); expect(text).toContain(version.label); expect(text).toContain('尚无需求方确认');
  expect(store.run).not.toHaveBeenCalled();
});

const versionFixture = (result: 'approved' | 'needs_adjustment', customerId = 'customer-a') => {
  const s = store.state!;
  s.devs.push({ id: 'dev-1', code: 'DEV-001', name: '羊毛大衣开发', style: 'CC-COAT-20', customerId, customer: '客户甲', img: 'coat', values: { domain: 'garment' }, versionIds: ['ver-1'] } as never);
  s.versions.push({ id: 'ver-1', devId: 'dev-1', label: 'R1-A', factory: '甲厂', img: 'coat', confirmations: [{ id: 'c1', result }], archivedAt: null } as never);
};
async function createFromVersion() {
  render({ view: 'orders/new', versionId: 'ver-1', customerId: 'customer-a', section: 'garment' }, <OrderCreatePage />);
  input('季节 / 批次', 'AW27'); await click(getByRole(host, 'button', { name: '下一步' }));
  input('数量', '120'); input('单价 USD', '50'); await click(getByRole(host, 'button', { name: '下一步' }));
  input('交期', '2026-12-01'); await click(getByRole(host, 'button', { name: '下一步' })); await click(getByRole(host, 'button', { name: '下一步' }));
  await click(getByRole(host, 'button', { name: '创建订单草稿' }));
}

it('BB-ORD-2 writes an approved development version source in one order.create and shows it on the line', async () => {
  versionFixture('approved');
  await createFromVersion();
  expect(store.run.mock.calls.map(call => call[0].type)).toEqual(['order.create']);
  const order = store.state!.orders[0], line = store.state!.orderLines.find(row => row.orderId === order.id)!;
  expect(line).toMatchObject({ sourceDevId: 'dev-1', sourceVersionId: 'ver-1', qty: 120 });
  act(() => root.render(<MistRoot><ToastProvider><OrderLineSourceValue state={store.state!} line={line} go={go} /></ToastProvider></MistRoot>));
  const link = getByRole(host, 'button', { name: '开发案 DEV-001 · R1-A' });
  await click(link);
  expect(go).toHaveBeenLastCalledWith('development/detail', 'dev-1', { versionId: 'ver-1' });
});

it('BB-ORD-2 shows the server reason and creates nothing when the version is not approved by the customer', async () => {
  versionFixture('needs_adjustment');
  await createFromVersion();
  expect(store.run.mock.calls.map(call => call[0].type)).toEqual(['order.create']);
  expect(store.state!.orders).toHaveLength(0);
  expect(host.textContent).toContain('尚未获得客户认可（需求方要求调整）');
});

it('BB-ORD-2 line detail shows a product archive source and a manual line without source', async () => {
  const s = store.state!;
  const line = { id: 'l', orderId: 'o', name: '大衣', style: 'C1', img: 'coat', qty: 1, unit: '件', price: 1, made: 0, qc: 0, sourceProductId: 'prd-1' } as never;
  act(() => root.render(<MistRoot><ToastProvider><OrderLineSourceValue state={s} line={line} go={go} /></ToastProvider></MistRoot>));
  await click(getByRole(host, 'button', { name: '产品档案 CC-COAT-14' }));
  expect(go).toHaveBeenLastCalledWith('products', 'prd-1');
  act(() => root.render(<MistRoot><ToastProvider><OrderLineSourceValue state={s} line={{ ...(line as object), sourceProductId: undefined } as never} go={go} /></ToastProvider></MistRoot>));
  expect(host.textContent).toContain('手工新建 · 无来源记录');
});
