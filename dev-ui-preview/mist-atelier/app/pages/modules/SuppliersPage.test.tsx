// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { supplierFlags, supplierPerformance } from './SuppliersPage';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';

const bridge = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'demo-buyer', displayName: '沈禾' }, hasPermission: () => true, hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
const named = (n: string) => state.market.suppliers.find(s => s.name === n)!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; const ctx: MistContext = { id: () => `s-test-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' };
  state = createMistState(ctx, 'demo');
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'saved' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id?: string) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.suppliers; await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'suppliers', id }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(label: string) { const b = button(label); expect(b, label).toBeTruthy(); await act(async () => b!.click()); }

describe('供应商管理', () => {
  it('交付表现与提醒由采购、到货与认证记录推出', () => {
    const huasheng = supplierPerformance(state, named('华盛毛纺').id);
    expect(huasheng.completed.length).toBe(1); expect(huasheng.onTime).toBe(1); expect(huasheng.open.length).toBe(1);
    expect(huasheng.receipts).toBe(1); expect(huasheng.clean).toBe(0);
    expect(supplierFlags(named('华盛毛纺'), '2026-10-14').map(f => f.label)).toContain('认证 30 天内到期');
    expect(supplierFlags(named('江南成衣'), '2026-10-14').map(f => f.key)).toContain('certExpired');
    expect(supplierFlags(named('远山服装'), '2026-10-14').map(f => f.key)).toEqual(['noCert', 'unrated']);
  });
  it('列表显示评级、认证提醒、在手单与暂停状态', async () => {
    await mount();
    const list = host.querySelector('[aria-label="供应商列表"]')!;
    expect(list.textContent).toContain('恒彩印花'); expect(list.textContent).toContain('已暂停');
    expect(list.textContent).toContain('已过期 5 天'); expect(list.textContent).toContain('20 天后到期');
    expect(list.textContent).toContain('100%');
  });
  it('认证过期的供应商：详情提示、认证有效期、评级历史；询价比价未接入并说明原因', async () => {
    await mount(named('江南成衣').id);
    const detail = host.querySelector('[data-supplier-detail]')!;
    expect(detail.textContent).toContain('有认证已过期');
    expect(host.querySelector('[data-supplier-certs]')!.textContent).toMatch(/BSCI.*已过期 5 天.*ISO 9001/);
    expect(detail.textContent).toMatch(/A · 2026 Q3.*B · 2026 Q2/);
    expect(button('询价比价')!.disabled).toBe(true);
    expect(detail.textContent).toContain('多家回价对比后转采购，尚未接入');
  });
  it('已暂停的供应商显示原因与生效日，只能恢复合作', async () => {
    await mount(named('恒彩印花').id);
    const detail = host.querySelector('[data-supplier-detail]')!;
    expect(detail.textContent).toContain('已暂停 · 2026-10-14 起');
    expect(detail.textContent).toContain('色牢度两批不达标');
    expect(button('恢复合作')).toBeTruthy(); expect(button('暂停合作')).toBeUndefined();
  });
  it('暂停前列出在手业务，说明继续执行与转移未接入', async () => {
    await mount(named('华盛毛纺').id);
    const lining = state.fulfillment.purchases.find(p => p.description.includes('里布'))!;
    expect(host.querySelector('[data-supplier-detail]')!.textContent).toContain(lining.code);
    await click('暂停合作');
    expect(document.body.textContent).toContain(`在手业务 1 单（${lining.code}）不受影响`);
    expect(document.body.textContent).toContain('转移尚未接入');
    expect(bridge.current.run).not.toHaveBeenCalled();
  });
});
