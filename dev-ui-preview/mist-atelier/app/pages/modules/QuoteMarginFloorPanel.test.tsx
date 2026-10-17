// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistRoot, ToastProvider } from '../../../../../components/mist';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';
import { MARKET_PAGES } from './MarketPages';
import { Nav } from '../../nav';

const bridge = vi.hoisted(() => ({ current: null as any, perms: new Set<string>() }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'u', displayName: '总领导' }, hasPermission: (p: string) => bridge.perms.has(p), hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
import { QuoteMarginFloorPanel } from './QuoteMarginFloorPanel';
let host: HTMLDivElement, root: Root | undefined, state: MistState;
let seq = 0; const ctx: MistContext = { id: () => 'mf-' + (++seq), actorName: '总领导', now: '2026-10-14T02:00:00.000Z' };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  state = createMistState(ctx, 'demo'); bridge.perms = new Set(['pricing:read', 'pricing:admin', 'quotations:write', 'quotations:read']);
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'f1' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function render(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<MistRoot><ToastProvider>{node}</ToastProvider></MistRoot>)); }
const el = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
async function fill(label: string, value: string) { const e = el(label); await act(async () => { const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }); }
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement;

describe('BB-QUO-3 定价参数 · 报价底价线', () => {
  it('管理层可按板块保存新版本，命令带最低毛利率、生效日与原因', async () => {
    await render(<QuoteMarginFloorPanel />);
    expect(host.querySelector('[data-floor-current="garment"]')?.textContent).toBe('未设置');
    expect(button('保存新版本').disabled).toBe(true);
    await fill('最低毛利率', '15'); await fill('底价线调整原因', '季度定价会');
    expect(button('保存新版本').disabled).toBe(false);
    await act(async () => button('保存新版本').click());
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'market.marginFloor.set', payload: { family: 'garment', minMarginPercent: '15', effectiveFrom: '2026-10-14', reason: '季度定价会' } });
  });
  it('非管理层只读：按钮禁用并写明原因，仍可看当前参数与版本', async () => {
    bridge.perms.delete('pricing:admin');
    state.market.marginFloors = [{ id: 'f', family: 'garment', version: 1, minMarginPercent: '15', effectiveFrom: '2026-10-01', reason: '定价会', createdAt: '2026-10-01T00:00:00.000Z', createdBy: '总领导', createdById: 'boss' }];
    await render(<QuoteMarginFloorPanel />);
    expect(button('保存新版本').disabled).toBe(true);
    expect(host.querySelector('[data-floor-reason]')?.textContent).toBe('仅管理层（定价管理权限）可修改最低毛利率');
    expect(host.querySelector('[data-floor-current="garment"]')?.textContent).toBe('15%');
    expect(el('最低毛利率').disabled).toBe(true);
  });
  it('生效日早于今天时禁用保存并说明不追溯', async () => {
    await render(<QuoteMarginFloorPanel />);
    await fill('最低毛利率', '10'); await fill('底价线调整原因', 'x'); await fill('底价线生效日', '2026-10-01');
    expect(button('保存新版本').disabled).toBe(true);
    expect(host.querySelector('[data-floor-reason]')?.textContent).toContain('不追溯');
  });
  it('报价详情标出低于冻结底价线的条目，并说明须审批', async () => {
    const q = state.market.quotations.find(x => x.code === 'QT-2026-0004')!; q.approval = null; q.requiresApproval = false;
    q.lines = q.lines.map((l, i) => i === 0 ? { ...l, price: '100.00', cost: '88.00', costBasis: 'product', marginFloor: { id: 'f', family: 'fabric', version: 1, minMarginPercent: '15', effectiveFrom: '2026-10-01' } } : { ...l, price: '10.00', cost: '1.00', costBasis: 'product' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.quotations;
    await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'quotations', id: q.id }, go: vi.fn(), theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>));
    expect(host.querySelector('[data-margin-floor-breach]')?.textContent).toBe('低于最低毛利率 15%（V1）');
    expect(host.textContent).toContain('须先审批');
  });
});
