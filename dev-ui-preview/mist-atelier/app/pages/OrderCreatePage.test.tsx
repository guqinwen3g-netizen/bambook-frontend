// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getAllByLabelText, getByLabelText, getByRole, getByText } from '@testing-library/dom';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { applyMistCommand, createMistState, type MistState } from '../../../../server/src/shared/mistWorkspace';
import { Nav } from '../nav';
const store = vi.hoisted(() => ({ state: null as MistState | null, loading: false, error: '', workspace:{id:'a',ownerId:'sales'} as {id:string;ownerId?:string}, run: vi.fn() }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => store }));
vi.mock('../runtime/auth', () => { const useMistSession = () => ({ status: 'authenticated', sessionKey: 's', user: { id: 'sales', displayName: '业务员甲' }, hasPermission: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
import { OrderCreatePage } from './OrderCreatePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root;
const go = vi.fn();
let sequence = 0;
const context = { id: () => `amount-${++sequence}`, now: '2026-10-13T02:00:00.000Z', actorName: '业务员甲', actorId: 'sales' };
function input(label: string, value: string) {
  const node = getByLabelText(host, new RegExp(`^${label}\\s*\\*?$`)) as HTMLInputElement|HTMLTextAreaElement;
  act(() => { Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function next() { await act(async () => getByRole(host, 'button', { name: '下一步' }).click()); }
async function enterLine(qty: string, price: string) {
  input('季节 / 批次', 'AW28'); await next();
  input('品名', '精确金额条目'); input('款号 / 品号', 'ROUND-01'); input('数量', qty); input('单价 USD', price);
}
function amount(label: string) { return getByText(host, label, { selector: 'dt' }).nextElementSibling?.textContent; }
beforeEach(() => {
  sequence = 0; store.workspace={id:'a',ownerId:'sales'}; store.state = createMistState(context, 'empty');
  store.state.customers.push({ id: 'customer-a', code: 'C-A', name: '客户甲', country: '', city: '', industry: '', owner: '业务员甲', grade: 'A', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-01-01' });
  store.run.mockReset(); go.mockReset();
  store.run.mockImplementation(async command => {
    const result = applyMistCommand(store.state!, command, context); store.state = result.state;
    return { requestId: 'request-a', revision: 2, result: result.result };
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<MistRoot><ToastProvider><Nav.Provider value={{ route: { view: 'orders/new', customerId: 'customer-a' }, go, openAI: vi.fn(), theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn() }}><OrderCreatePage /></Nav.Provider></ToastProvider></MistRoot>));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('shows the same half-cent rounded line and total as the server through submission', async () => {
  await enterLine('1.005', '1'); await next(); input('交期', '2026-10-30'); await next();
  expect(amount('订单总金额')).toBe('1.01 USD');
  expect(amount('ROUND-01 · 精确金额条目')).toBe('1.005 件 × 1.00 = 1.01 USD');
  await next(); expect(amount('总金额')).toBe('1.01 USD');
  await act(async () => getByRole(host, 'button', { name: '创建订单草稿' }).click());
  expect(store.state!.orders[0].amount).toBe(1.01);
  expect(store.run).toHaveBeenCalledOnce(); expect(go).toHaveBeenCalledWith('orders/detail', store.state!.orders[0].id,{customerId:'customer-a',section:'garment'});
});

it('rounds each line before accumulating the total in cents', async () => {
  await enterLine('1.005', '1');
  await act(async () => getByRole(host, 'button', { name: '添加条目' }).click());
  const fields = (label: string) => getAllByLabelText(host, new RegExp(`^${label}\\s*\\*?$`)) as HTMLInputElement[];
  for (const [label, value] of [['品名', '第二个条目'], ['款号 / 品号', 'ROUND-02'], ['数量', '1.005'], ['单价 USD', '1']]) {
    const node = fields(label)[1];
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  await next(); input('交期', '2026-10-30'); await next();
  expect(amount('订单总金额')).toBe('2.02 USD');
});

it.each([
  ['1.00001', '1', '数量最多支持四位小数'],
  ['1', '1.001', '金额须为最多两位小数的非负数'],
  ['999999999', '999999999999.99', '条目金额超出支持范围'],
])('keeps invalid precision or range editable without a render exception (%s × %s)', async (qty, price, message) => {
  await enterLine(qty, price); await next();
  expect(host.textContent).toContain(message);
  expect((getByLabelText(host, /^数量/) as HTMLInputElement).value).toBe(qty);
  expect(store.run).not.toHaveBeenCalled();
  input('数量', '1.005'); input('单价 USD', '1'); await next();
  expect(getByLabelText(host, /^交期/)).toBeTruthy();
});
it('preserves entered units and quantities when the business type is changed',async()=>{await enterLine('5','2');await act(async()=>getByRole(host,'button',{name:'上一步'}).click());const select=getByRole(host,'combobox',{name:'订单类型'}) as HTMLSelectElement;act(()=>{select.value='fabric';select.dispatchEvent(new Event('change',{bubbles:true}));});await next();expect((getByLabelText(host,/^单位/) as HTMLInputElement).value).toBe('件');expect((getByLabelText(host,/^数量/) as HTMLInputElement).value).toBe('5');});
it('does not navigate from an old create acknowledgement after switching workspaces',async()=>{await enterLine('1','2');await next();input('交期','2026-10-30');await next();await next();let finish!:(value:unknown)=>void;store.run.mockReturnValue(new Promise(resolve=>finish=resolve));await act(async()=>getByRole(host,'button',{name:'创建订单草稿'}).click());store.workspace={id:'b'};act(()=>root.render(<MistRoot><ToastProvider><Nav.Provider value={{route:{view:'orders/new',customerId:'customer-a'},go,openAI:vi.fn(),theme:'light',toggleTheme:vi.fn(),openPalette:vi.fn()}}><OrderCreatePage/></Nav.Provider></ToastProvider></MistRoot>));await act(async()=>finish({result:{id:'old-order'}}));expect(go).not.toHaveBeenCalled();expect(getByRole(host,'button',{name:'下一步'})).toBeTruthy();expect((getByLabelText(host,/^季节/) as HTMLInputElement).value).toBe('');});

it('creates only a governed draft and preserves uploaded customer contract evidence',async()=>{
  (store as any).uploadFile=vi.fn(async(file:File)=>{const stored={id:'customer-po',name:file.name,mimeType:file.type,size:file.size,storageKey:'workspace/customer-po',createdAt:context.now};store.state!.files.push(stored);return stored;});
  input('PO / 合同号','PO-2026-10');await enterLine('10','10');await next();input('交期','2026-12-01');input('付款条款原文','T/T 30%定金，余款按合同');input('定金比例（%）','30');input('贸易术语','FOB');input('指定地点 / 港口','上海');
  await act(async()=>{const picker=host.querySelector<HTMLInputElement>('input[type="file"]')!;Object.defineProperty(picker,'files',{value:[new File(['confirmed purchase order'],'customer-po.pdf',{type:'application/pdf'})],configurable:true});picker.dispatchEvent(new Event('change',{bubbles:true}));});
  await next();await next();await act(async()=>getByRole(host,'button',{name:'创建订单草稿'}).click());
  expect(store.state!.orders[0].governance).toMatchObject({status:'draft',contract:{kind:'external',poNumber:'PO-2026-10',confirmationFileIds:['customer-po'],paymentMethod:'TT',depositPercent:30,incoterm:'FOB',deliveryPlace:'上海'}});expect(store.state!.orders[0].state).toBe('订单草稿');
});
