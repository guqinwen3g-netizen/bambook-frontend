// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_PAGES } from './PlatformPages';
import { Nav } from '../../nav';
import { createMistState, type MistContext, type MistState } from '../../../../../server/src/shared/mistWorkspace';
import { riskSignals, type RiskRecord } from '../../../../../server/src/shared/mistRisk';

const bridge = vi.hoisted(() => ({ current: null as any, perms: null as string[] | null, user: { id: 'demo-buyer', displayName: '沈禾' } }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: bridge.user, hasPermission: (p: string) => bridge.perms === null || bridge.perms.includes(p), hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset(); bridge.perms = null; bridge.user = { id: 'demo-buyer', displayName: '沈禾' };
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

/** 汇总栏某项的数值（SummaryBar：<small>标签</small><div class=mist-sumbar-big>值</div>）。 */
const summaryValue = (label: string) => [...host.querySelectorAll('[data-risk-summary] .mist-sumbar > div')].find(d => d.querySelector('small')?.textContent === label)?.querySelector('.mist-sumbar-big')?.textContent;
const detail = (id: string) => host.querySelector(`[data-risk-detail="${id}"]`)!;
/** 直接放一条订单来源的风险（不经种子），用于分级与负责人场景。 */
/** owner 为来源订单负责人姓名；ownerId 为服务端绑定的负责人账号（缺省为空，即旧资料未绑定）。 */
function orderRisk(patch: Partial<RiskRecord>, owner?: string, ownerId?: string): RiskRecord {
  const o = state.orders[0]; if (owner) o.owner = owner; if (ownerId) o.ownerId = ownerId; else if (owner) delete o.ownerId;
  const r: RiskRecord = { id: 'risk-x', orderId: o.id, title: '订单交期风险', level: 'warning', basis: '工厂回复晚 3 天', owner: o.owner, state: 'InProgress', resolution: '', createdAt: '2026-10-13T02:00:00.000Z', type: 'delivery', source: { kind: 'order', id: o.id, label: o.code }, createdBy: o.owner, acknowledgedAt: '2026-10-13T03:00:00.000Z', plan: '夜班追回', escalations: [], ...patch };
  state.platform!.risks.unshift(r); return r;
}

describe('风险管理与合规', () => {
  it('预警页：汇总、已登记的预警显示负责人；未登记预警可带来源登记', async () => {
    await mount();
    const summary = host.querySelector('[data-risk-summary]')!.textContent!;
    expect(summary).toContain('未登记预警'); expect(summary).toContain('待审批申请');
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
  it('统一审批中的申请：显示申请事项与部门主管，风险页不直接答复，可去审批中心', async () => {
    const r = risk('Escalated'); await mount(r.id);
    const d = detail(r.id);
    expect(d.textContent).toContain('待部门主管审批 · 带风险放行'); expect(d.textContent).toContain('分两期付清');
    expect(button('批准', d)).toBeUndefined(); expect(button('驳回', d)).toBeUndefined();
    expect(button('撤回申请', d)).toBeUndefined();
    await click(button('到审批中心', d)); expect(go).toHaveBeenCalledWith('approvals');
  });
  it('申请人可撤回自己的申请', async () => {
    bridge.user = { id: 'demo-finance', displayName: '林舒' };
    const r = risk('Escalated'); await mount(r.id);
    await click(button('撤回申请', detail(r.id))); await type('撤回原因', '客户已付清');
    await click(button('撤回', document.body.querySelector('[role="dialog"]') as HTMLElement));
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'platform.risk.withdraw', payload: { id: r.id, escalationId: r.escalations![0].id, reason: '客户已付清' } });
  });
  it('早期自由填写审批人的升级：仍由风险审批权限者直接答复', async () => {
    const r = risk('Escalated'); const e = r.escalations![0]; delete e.requesterId; delete e.reviewerIds; delete e.action; e.approver = '周敏';
    await mount(r.id); const d = detail(r.id);
    expect(d.textContent).toContain('待 周敏 审批升级');
    await click(button('批准', d)); await type('审批意见', '同意首期到账后放行一票');
    await click(button('批准', document.body.querySelector('[role="dialog"]') as HTMLElement));
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'platform.risk.decide', payload: { id: r.id, escalationId: e.id, decision: 'approved', note: '同意首期到账后放行一票' } });
  });
  it('已关闭风险只读回看：审批记录（申请事项）与关闭依据', async () => {
    const r = risk('Resolved'); await mount(r.id);
    const d = detail(r.id);
    expect(d.textContent).toContain('已批准'); expect(d.textContent).toContain('其他受控授权'); expect(d.textContent).toContain('关闭依据'); expect(d.textContent).toContain(r.resolution);
    expect(button('关闭风险', d)).toBeUndefined(); expect(button('申请审批', d)).toBeUndefined();
  });
  it('高风险（严重）不能直接关闭：改为申请关闭，提交给部门主管', async () => {
    const r = orderRisk({ level: 'critical' }); await mount(r.id);
    const d = detail(r.id);
    expect(d.textContent).toContain('高风险'); expect(button('关闭风险', d)).toBeUndefined();
    await click(button('申请关闭', d));
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect((dialog.querySelector('[aria-label="申请事项"]') as HTMLSelectElement).value).toBe('close');
    expect(dialog.textContent).toContain('部门的主管'); expect(dialog.querySelector('[aria-label="审批人"]')).toBeNull();
    await type('依据与申请范围', '工厂已补产，客户确认新交期');
    await click(button('提交审批', dialog));
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'platform.risk.escalate', payload: { id: r.id, action: 'close', reason: '工厂已补产，客户确认新交期' } });
  });
  it('登记等级低于当前预警等级时按当前等级处理', async () => {
    const r = risk('Open'); r.level = 'info'; r.state = 'InProgress'; r.plan = '更换认证供应商';
    const live = riskSignals(state, '2026-10-14').find(s => s.key === r.signalKey)!; expect(live.level).toBe('critical');
    await mount(r.id); const d = detail(r.id);
    expect(d.textContent).toContain('来源预警当前已升为严重'); expect(button('关闭风险', d)).toBeUndefined(); expect(button('申请关闭', d)).toBeTruthy();
  });
  it('低风险由处理人直接关闭', async () => {
    const r = orderRisk({ level: 'warning' }); await mount(r.id);
    const d = detail(r.id); expect(button('申请关闭', d)).toBeUndefined();
    await click(button('关闭风险', d)); await type('关闭依据', '工厂排期已确认');
    await click(button('确认关闭', document.body.querySelector('[role="dialog"]') as HTMLElement));
    expect(bridge.current.run).toHaveBeenCalledWith({ type: 'platform.risk.transition', payload: { id: r.id, state: 'Resolved', resolution: '工厂排期已确认' } });
  });
  it('业务员（订单写、无风险写）：只能处理本人订单上的风险', async () => {
    bridge.perms = ['risk:read', 'orders:write'];
    const mine = orderRisk({ id: 'risk-mine', state: 'Open', plan: undefined }, '沈禾', 'demo-buyer');
    await mount(mine.id);
    expect(host.textContent).toContain('按负责人处理');
    expect(button('接手', detail(mine.id))!.disabled).toBe(false);
    expect(button('手工登记')!.disabled).toBe(false);
    await act(async () => root!.unmount()); host.remove();
    // 同显示名（沈禾）但负责人绑定的是另一个账号：不能处理，也不能把该订单当作本人订单登记。
    state.orders[0].ownerId = 'demo-buyer-2'; state.orders.slice(1).forEach(o => { delete o.ownerId; }); await mount(mine.id);
    expect(button('接手', detail(mine.id))!.disabled).toBe(true); expect(detail(mine.id).textContent).toContain('只有来源负责人（沈禾）本人');
    expect(button('手工登记')!.disabled).toBe(true);
    await act(async () => root!.unmount()); host.remove();
    // 旧资料：负责人只有姓名、未绑定账号，即使与我同名也不按姓名认定。
    delete state.orders[0].ownerId; await mount(mine.id);
    expect(button('接手', detail(mine.id))!.disabled).toBe(true); expect(detail(mine.id).textContent).toContain('尚未绑定账号');
    await act(async () => root!.unmount()); host.remove();
    state.orders[0].owner = '顾言'; state.orders[0].ownerId = 'demo-sales'; await mount(mine.id);
    expect(button('接手', detail(mine.id))!.disabled).toBe(true); expect(detail(mine.id).textContent).toContain('只有来源负责人（顾言）');
    const cert = state.platform!.risks.find(r => r.source?.kind === 'supplier')!; await act(async () => root!.unmount()); host.remove(); await mount(cert.id);
    expect(detail(cert.id).textContent).toContain('供应商来源的风险需要风险处理权限');
  });
  it('无处理权限：只读，动作可见但禁用并写明原因', async () => {
    bridge.perms = ['risk:read']; const r = risk('Open'); await mount(r.id);
    expect(button('接手', detail(r.id))!.disabled).toBe(true);
    expect(button('手工登记')).toBeUndefined(); expect(host.textContent).toContain('只读查看');
  });
});

describe('风险审批与操作记录的日期口径', () => {
  it('同一审批事件跨 UTC 日界：风险详情、审批记录、操作记录都按北京时间显示同一天', async () => {
    // 北京时间 2026-10-17 01:30 = UTC 2026-10-16 17:30。
    const at = '2026-10-16T17:30:00.000Z';
    const r = orderRisk({ id: 'risk-tz', state: 'InProgress', acknowledgedAt: at, escalations: [{ id: 'esc-tz', approver: '部门主管', reason: '夜班加工费', requestedBy: '沈禾', requestedAt: at, decision: 'approved', decisionNote: '同意', decidedBy: '周敏', decidedAt: at, action: 'authorize', requesterId: 'demo-buyer', reviewerIds: ['demo-reviewer'] }] }, '沈禾', 'demo-buyer');
    state.events.unshift({ id: 'ev-tz', entityType: 'risk', entityId: r.id, at, actor: '周敏', text: '批准受控授权申请：同意', fileIds: [] });
    await mount(r.id);
    const text = detail(r.id).textContent!;
    expect(text).toContain('周敏 · 10/17'); expect(text).toContain('沈禾 · 10/17');
    expect(text).not.toContain('10/16');
    expect(text).toContain('2026/10/17');
  });
  it('关闭事件跨 UTC 日界与月界：短日期与“本月关闭”都按上海业务日归入 11 月', async () => {
    // 上海 2026-11-01 00:30 = UTC 2026-10-31 16:30；页面当前时间为上海 11-01 09:00。
    vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
    const at = '2026-10-31T16:30:00.000Z';
    const r = orderRisk({ id: 'risk-month', state: 'Resolved', resolution: '已追回', closedAt: at, closedBy: '周敏', disposition: 'closed' });
    // 上海 2026-10-31 23:30 关闭的仍属 10 月，不计入。
    orderRisk({ id: 'risk-oct', state: 'Resolved', resolution: '已追回', closedAt: '2026-10-31T15:30:00.000Z', closedBy: '周敏' });
    await mount(r.id, 'ledger');
    expect(summaryValue('本月关闭')).toBe('1');
    const text = detail(r.id).textContent!;
    expect(text).toContain('周敏 · 11/01'); expect(text).not.toContain('10/31');
    expect(state.platform!.risks.find(x => x.id === r.id)!.closedAt).toBe(at); // 原始时间戳不改
  });
  it('月末反向边界：UTC 仍在 11/30、上海已是 12/01 的关闭不计入 11 月', async () => {
    vi.setSystemTime(new Date('2026-11-30T08:00:00Z')); // 上海 11-30 16:00
    const r = orderRisk({ id: 'risk-dec', state: 'Resolved', resolution: '已追回', closedAt: '2026-11-30T16:30:00.000Z', closedBy: '周敏' });
    await mount(r.id, 'ledger');
    expect(summaryValue('本月关闭')).toBe('0');
    expect(detail(r.id).textContent).toContain('周敏 · 12/01');
  });
});
