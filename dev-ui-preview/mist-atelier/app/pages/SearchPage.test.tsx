// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Nav } from '../nav';
import { SearchPage } from './SearchPage';

const bridge = vi.hoisted(() => ({ state: null as any, can: (_: string) => true }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => ({ canAccessView: (v: string) => bridge.can(v) }) }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => ({ state: bridge.state, workspace: bridge.state ? { name: '真实空间' } : null }) }));
let root: Root | undefined, host: HTMLDivElement; const go = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset(); bridge.can = () => true;
  bridge.state = { devs: [], drafts: [], customers: [{ id: 'c1', name: 'Panda Trading', code: 'C1' }], orders: Array.from({ length: 10 }, (_, i) => ({ id: 'o' + i, code: 'SO-' + i, customer: 'Panda Trading' })), invoices: [], market: {}, fulfillment: {}, platform: {} };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
async function render(section?: string) {
  if (!root) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'search', section }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() } as any}><SearchPage /></Nav.Provider>));
}
it('groups results, previews eight per group and opens a record at its route', async () => {
  await render('panda');
  expect(host.textContent).toContain('全部11');
  expect(host.querySelectorAll('[aria-label="订单"] [role="listitem"]')).toHaveLength(8);
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '显示全部 10 条')!.click());
  expect(host.querySelectorAll('[aria-label="订单"] [role="listitem"]')).toHaveLength(10);
  await act(async () => (host.querySelector('[aria-label="客户"] [role="listitem"]') as HTMLButtonElement).click());
  expect(go).toHaveBeenCalledWith('crm', 'c1', { customerId: 'c1' });
});
it('hides records from pages the account cannot enter and says so when nothing matches', async () => {
  bridge.can = v => v !== 'orders' && v !== 'crm';
  await render('panda');
  expect(host.textContent).toContain('没有找到「panda」');
});
it('submits a new query through the route', async () => {
  await render();
  expect(host.textContent).toContain('输入关键词开始搜索');
  const input = host.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' SO-3 '); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(go).toHaveBeenCalledWith('search', undefined, { section: 'SO-3' });
});
