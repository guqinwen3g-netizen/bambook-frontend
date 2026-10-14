// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { relationBusiness, relationIdentities } from './RelationsPage';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => ({ useMistSession: () => ({ user: { id: 'demo-buyer', displayName: '沈禾' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }) }));
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
const named = (n: string) => state.market.relations.find(r => r.name.includes(n))!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; const ctx: MistContext = { id: () => `r-test-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' };
  state = createMistState(ctx, 'demo');
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'saved' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id?: string) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.relations; await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'relations', id }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(label: string) { const b = button(label); expect(b, label).toBeTruthy(); await act(async () => b!.click()); }


describe('关系智库', () => {
  it('同一组织同时是客户和供应商；冻结与在手业务由记录推出', () => {
    const boyuan = named('博远');
    expect(relationIdentities(boyuan)).toEqual(['customer', 'supplier']);
    expect(state.market.relations.filter(r => r.name.includes('博远')).length).toBe(1);
    const lune = state.market.relations.find(r => r.hold)!;
    expect(lune.hold!.reason).toContain('尾款逾期');
    expect(relationBusiness(state, lune).total).toBeGreaterThan(0);
  });
  it('列表把冻结的组织排在最前，按身份计数（双重身份两边都计）', async () => {
    await mount();
    const rows = [...host.querySelectorAll<HTMLElement>('[role="row"][tabindex]')];
    expect(rows[0].textContent).toContain('已冻结');
    expect(host.textContent).toMatch(/客户\s*6/); expect(host.textContent).toMatch(/供应商\s*6/);
  });
  it('冻结的客户：显示原因与影响，只能解冻；有在手业务时不能归档', async () => {
    const lune = state.market.relations.find(r => r.hold)!;
    await mount(lune.id);
    const detail = host.querySelector('[data-relation-detail]')!;
    expect(detail.textContent).toContain('往来已冻结');
    expect(detail.textContent).toContain('不能新建报价、发送报价、转订单或新建订单');
    expect(button('解冻')).toBeTruthy(); expect(button('冻结往来')).toBeUndefined();
    expect(button('归档')!.disabled).toBe(true);
    expect(detail.textContent).toMatch(/还有在手业务 \d+ 项/);
  });
  it('双重身份：客户联系人与供应商联系人分开维护，不再提供关联', async () => {
    await mount(named('博远').id);
    const detail = host.querySelector('[data-relation-detail]')!;
    expect(detail.textContent).toContain('既是客户也是供应商');
    expect(detail.textContent).toMatch(/供应商联系人 · 1.*何静/);
    expect(button('关联供应商身份')).toBeUndefined();
    expect(button('打开供应商')).toBeTruthy(); expect(button('打开客户业务')).toBeTruthy();
  });
  it('普通客户可关联供应商身份；在手业务交接未接入并说明原因', async () => {
    await mount(named('Cedar').id);
    expect(button('关联供应商身份')!.disabled).toBe(false);
    expect(host.querySelector('[data-relation-detail]')!.textContent).toMatch(/联系人 · 3.*Emma Clarke/);
    expect(button('在手业务交接')!.disabled).toBe(true);
    expect(host.querySelector('[data-relation-detail]')!.textContent).toContain('离职 / 调岗时逐项转给新负责人，尚未接入');
    await click('冻结往来');
    expect(document.body.textContent).toMatch(/已有在手业务 \d+ 项不受影响/);
    expect(bridge.current.run).not.toHaveBeenCalled();
  });
});
