// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_PAGES } from './PlatformPages';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';
import { riskSignals } from '../../../../../server/src/shared/mistRisk';

const bridge = vi.hoisted(() => ({ current: null as any, perms: null as string[] | null }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => ({ useMistSession: () => ({ user: { id: 'demo-buyer', displayName: '沈禾' }, hasPermission: (p: string) => bridge.perms === null || bridge.perms.includes(p), hasRole: () => false, canAccessView: () => true }) }));
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset(); bridge.perms = null;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; const ctx: MistContext = { id: () => `r-test-${++n}`, actorName: '演示', now: '2026-10-14T02:00:00.000Z' };
  state = createMistState(ctx, 'demo');
  bridge.current = { state, run: vi.fn(async () => ({ result: { id: 'saved' } })), error: '', refresh: vi.fn(), loading: false, saving: false, pending: null, upload: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id?: string, section?: string) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = PLATFORM_PAGES.risks; await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'risks', id, section }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>)); }
const button = (label: string, scope: ParentNode = document.body) => [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(b: HTMLButtonElement | undefined) { expect(b).toBeTruthy(); await act(async () => b!.click()); }
async function type(label: string, value: string) { const c = document.body.querySelector(`[role="dialog"] [aria-label="${label}"]`) as HTMLTextAreaElement; expect(c, label).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(c, value); c.dispatchEvent(new Event('input', { bubbles: true })); }); }
const risk = (state_: string) => state.platform!.risks.find(r => r.state === state_)!;
const row = (text: string) => [...host.querySelectorAll<HTMLElement>('[role="row"][tabindex]')].find(r => r.textContent?.includes(text));

describe('风险管理与合规', () => {
  it('预警页：汇总、已登记的预警显示负责人；未登记预警可带来源登记', async () => {
    await mount();
    const summary = host.querySelector('[data-risk-summary]')!.textContent!;
    expect(summary).toContain('未登记预警'); expect(summary).toContain('待审批升级');
    expect(host.textContent).toContain('汇率风险尚未接入汇率数据源');
    const cert = risk('Open'); expect(row(cert.title)!.textContent).toContain('沈禾');
    const free = riskSignals(state, '2026-10-14').find(s => !state.platform!.risks.some(r => r.signalKey === s.key))!;
    expect(free).toBeTruthy();
    await act(async () => row(free.title)!.click());
    const d = host.querySelector(`[data-signal-detail="${free.key}"]`)!;
    expect(d.textContent).toContain(free.basis);
    await click(button('打开原记录', d)); expect(go).toHaveBeenCalled();
    await click(button('登记风险', d));
    const dialog = document.body.querySelector('[role="dialog"]')!; expect((dialog.querySelector('[aria-label="风险标题"]') as HTMLInputElement).value).toBe(free.title);
    await click(button('登记', dialog as HTMLElement));
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'platform.risk.save', payload: expect.objectContaining({ signalKey: free.key, type: free.type, source: { kind: free.source.kind, id: free.source.id }, owner: '沈禾' }) });
  });
  it('升级待审批：审批人可批准，写入审批意见', async () => {
    const r = risk('Escalated'); await mount(r.id);
    const d = host.querySelector(`[data-risk-detail="${r.id}"]`)!;
    expect(d.textContent).toContain('待 周敏 审批升级'); expect(d.textContent).toContain('分两期付清');
    expect(button('关闭风险', d)!.disabled).toBe(true); expect(d.textContent).toContain('升级审批尚未答复');
    await click(button('批准', d)); await type('审批意见', '同意首期到账后放行一票');
    await click(button('批准', document.body.querySelector('[role="dialog"]') as HTMLElement));
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'platform.risk.decide', payload: { id: r.id, escalationId: r.escalations![0].id, decision: 'approved', note: '同意首期到账后放行一票' } });
  });
  it('已关闭风险只读回看：审批记录与关闭依据', async () => {
    const r = risk('Resolved'); await mount(r.id);
    const d = host.querySelector(`[data-risk-detail="${r.id}"]`)!;
    expect(d.textContent).toContain('已授权'); expect(d.textContent).toContain('关闭依据'); expect(d.textContent).toContain(r.resolution);
    expect(button('关闭风险', d)).toBeUndefined(); expect(button('申请升级', d)).toBeUndefined();
  });
  it('无写权限与无审批权限：动作可见但禁用并写明原因', async () => {
    bridge.perms = ['risk:read']; const r = risk('Escalated'); await mount(r.id);
    const d = host.querySelector(`[data-risk-detail="${r.id}"]`)!;
    expect(button('批准', d)!.disabled).toBe(true); expect(d.textContent).toContain('需要风险审批权限');
    expect(d.textContent).toContain('需要风险写权限'); expect(button('手工登记')).toBeUndefined();
    expect(host.textContent).toContain('只读查看');
  });
});
