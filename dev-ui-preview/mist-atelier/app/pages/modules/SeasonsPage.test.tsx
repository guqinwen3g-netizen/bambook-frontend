// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { seasonBusiness, trendCustomers } from './SeasonsPage';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'demo-buyer', displayName: '沈禾' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
const season = (code: string) => state.market.seasons.find(s => s.code === code)!;
const show = (name: string) => state.market.shows.find(s => s.name.startsWith(name))!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; const ctx: MistContext = { id: () => `s-test-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' };
  state = createMistState(ctx, 'demo');
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'saved' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id?: string, section?: string) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.seasons; await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'seasons', id, section }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string, scope: ParentNode = document.body) => [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(b: HTMLButtonElement | undefined) { expect(b).toBeTruthy(); await act(async () => b!.click()); }

describe('季节性与趋势', () => {
  it('季节业务与趋势客户由订单、报价和面料档案推出', () => {
    const b = seasonBusiness(state, season('AW27'));
    expect(b.orders.length).toBeGreaterThan(0); expect(b.trends.length).toBeGreaterThanOrEqual(3); expect(b.shows.length).toBe(1);
    const trend = state.market.trends.find(t => t.name === '软糯双面呢回归')!;
    expect(trendCustomers(state, trend).length).toBeGreaterThan(0);
    const craft = state.market.trends.find(t => t.name === '轻量无衬里结构')!;
    expect(trendCustomers(state, craft)).toEqual([]);
  });
  it('季节页显示时间线、今天线与当前季节的里程碑和业务', async () => {
    await mount(season('AW27').id);
    const tl = host.querySelector('[data-season-timeline]')!;
    expect(tl.querySelectorAll('.mist-season-row').length).toBe(state.market.seasons.length);
    expect(tl.querySelector('.mist-season-today')).toBeTruthy();
    expect(tl.querySelector('.mist-season-bar[data-status="Closed"]')).toBeTruthy();
    const d = host.querySelector(`[data-season-detail="${season('AW27').id}"]`)!;
    expect(d.textContent).toContain('首样评审'); expect(d.textContent).toContain('订货会'); expect(d.textContent).toContain('21 天后');
    expect(d.querySelector('[data-season-business]')).toBeTruthy();
    await click(button('打开', d)); expect(go).toHaveBeenCalledWith('orders/detail', expect.any(String), undefined);
  });
  it('已结束季节显示回顾操作，趋势详情列出面料档案与客户', async () => {
    await mount(season('AW26').id);
    expect(host.querySelector(`[data-season-detail="${season('AW26').id}"]`)!.textContent).toContain('已结束');
    await act(async () => root!.unmount()); host.remove();
    const trend = state.market.trends.find(t => t.name === '软糯双面呢回归')!;
    await mount(trend.id, 'trends');
    const d = host.querySelector(`[data-trend-detail="${trend.id}"]`)!;
    expect(d.textContent).toContain('Première Vision 面料趋势区');
    expect(d.querySelector('[data-trend-customers]')).toBeTruthy();
    await click(button('客户业务', d)); expect(go).toHaveBeenCalledWith('crm', expect.any(String), expect.objectContaining({ customerId: expect.any(String) }));
  });
  it('展会线索：逾期提醒、已转客户直达商机、转入 CRM 走真实命令', async () => {
    const pv = show('Première Vision');
    await mount(pv.id, 'shows');
    const d = host.querySelector(`[data-show-detail="${pv.id}"]`)!;
    expect(d.textContent).toContain('条线索跟进逾期'); expect(d.textContent).toMatch(/逾期 6 天/);
    expect(button('客户业务 · 商机', d)).toBeTruthy();
    const rossi = [...d.querySelectorAll('[role="listitem"]')].find(r => r.textContent?.includes('Anna Rossi'))!;
    await click(button('转入 CRM', rossi));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('新建客户：Studio Rossi Milano');
    await click(button('转入 CRM', dialog as HTMLElement));
    const lead = state.market.leads.find(l => l.name === 'Anna Rossi')!;
    expect(bridge.current.run).toHaveBeenCalledWith(expect.objectContaining({ type: 'market.lead.convertToCrm', payload: expect.objectContaining({ id: lead.id }) }));
  });
  it('旧的展会线索深链落到展会页签', async () => {
    const pv = show('Première Vision');
    await mount(undefined, `show-leads:${pv.id}`);
    expect(host.querySelector(`[data-show-detail="${pv.id}"]`)).toBeTruthy();
  });
});
