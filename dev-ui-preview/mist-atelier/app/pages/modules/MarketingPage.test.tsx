// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_PAGES } from './MarketPages';
import { CAMPAIGN_NEXT, campaignLeads, campaignReminder } from './MarketingPage';
import { Nav } from '../../nav';
import { createMistState, type MistState } from '../../../../../server/src/shared/mistWorkspace';
const bridge = vi.hoisted(() => ({ current: null as any, permissions: true }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => bridge.current }));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ user: { id: 'sales' }, hasPermission: () => bridge.permissions, hasRole: () => false, canAccessView: () => true }); return { useMistSession, useOptionalMistSession: useMistSession }; });
let host: HTMLDivElement, root: Root | undefined, state: MistState; const go = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; go.mockReset(); bridge.permissions = true;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-14T04:00:00Z'));
  let n = 0; state = createMistState({ id: () => `marketing-test-${++n}`, now: '2026-10-14T02:00:00.000Z', actorName: '演示' }, 'demo');
  bridge.current = { state, loading: false, saving: false, error: '', pending: null, run: vi.fn(async () => ({ result: { id: 'saved' } })), refresh: vi.fn(), uploadFile: vi.fn(), downloadFile: vi.fn() };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
async function mount(id?: string, section?: string) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const Page = MARKET_PAGES.marketing;
  await act(async () => root!.render(<Nav.Provider value={{ route: { view: 'marketing', id, section }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() }}><Page /></Nav.Provider>));
}
const button = (label: string, scope: ParentNode = document.body) => [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function click(label: string, scope: ParentNode = document.body) { const b = button(label, scope); expect(b, label).toBeTruthy(); await act(async () => b!.click()); }
async function fill(label: string, value: string) {
  const e = document.body.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
  expect(e, label).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
}
describe('营销推广工作台', () => {
  it('只统计活动准确来源线索，不混入展会，不将过期已转线索算逾期', () => {
    const c = state.market.campaigns.find(c => c.name.startsWith('AW27'))!, l = state.market.leads.find(l => l.source === 'campaign' && l.status !== 'Converted')!;
    state.market.leads.forEach(l => { l.followUpDate = '2026-12-01'; });
    state.market.leads.push({ ...l, id: 'other', source: 'show', parentId: c.id }, { ...l, id: 'converted', status: 'Converted', followUpDate: '2026-01-01' });
    expect(campaignLeads(state.market.leads, c.id).some(x => x.id === 'other')).toBe(false);
    c.actualCost = '4000'; c.endDate = '2026-10-01'; l.followUpDate = '2026-10-10';
    expect(campaignReminder(c, state.market.leads, '2026-10-14')).toMatchObject({ overdue: 1, ended: true, overBudget: true });
    expect(CAMPAIGN_NEXT.Completed).toEqual([]); expect(CAMPAIGN_NEXT.Draft).not.toContain('Completed');
  });
  it('工作台筛选无结果可清除，详情展示原币预算与禁用发送原因', async () => {
    const c = state.market.campaigns.find(c => c.name.startsWith('AW27'))!; await mount(c.id);
    const detail = host.querySelector(`[data-campaign-detail="${c.id}"]`)!;
    expect(detail.textContent).toContain('USD 3000.00'); expect(detail.textContent).toContain('外部推广发送服务');
    expect(button('发送推广邮件', detail)!.disabled).toBe(true);
    const search = host.querySelector('input[placeholder="搜索活动、编号、负责人或目标群体"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '不存在活动'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.textContent).toContain('没有符合条件的活动'); await click('清除筛选'); expect(host.textContent).not.toContain('没有符合条件的活动');
    expect(bridge.current.run).not.toHaveBeenCalled();
  });
  it('终态必须确认后才提交真实命令；失败保留确认框与重试', async () => {
    const c = state.market.campaigns.find(c => c.name.startsWith('AW27'))!; c.status = 'Active'; await mount(c.id);
    await click('完成活动'); expect(bridge.current.run).not.toHaveBeenCalled();
    const d = document.querySelector('[role="dialog"]')!; expect(d.textContent).toContain('不能直接恢复');
    bridge.current.run.mockRejectedValueOnce(new Error('版本冲突，请重新载入')); await click('确认', d);
    expect(d.textContent).toContain('版本冲突，请重新载入'); await click('确认', d);
    expect(bridge.current.run).toHaveBeenLastCalledWith({ type: 'market.campaign.status', payload: { id: c.id, status: 'Completed' } });
  });
  it('只读账号可看活动但不能编辑、推进或发送', async () => {
    bridge.permissions = false; const c = state.market.campaigns.find(c => c.name.startsWith('AW27'))!; await mount(c.id);
    expect(host.textContent).toContain('只读查看'); expect(button('创建活动')).toBeUndefined();
    expect(button('编辑活动')!.disabled).toBe(true); expect(button('完成活动')!.disabled).toBe(true);
    expect(button('管理线索')!.disabled).toBe(false); expect(bridge.current.run).not.toHaveBeenCalled();
  });
  it('线索转 CRM 使用准确来源与既有命令，缺业务板块不凭需求文字猜', async () => {
    const c = state.market.campaigns.find(c => c.name.startsWith('AW27'))!, l = state.market.leads.find(x => x.source === 'campaign' && x.parentId === c.id && x.status !== 'Converted')!;
    l.status = 'New'; await mount(l.id, `campaign-leads:${c.id}`); await click('转入 CRM');
    const d = document.querySelector('[role="dialog"]')!; expect(d.textContent).toContain(`新建客户：${l.company}`);
    expect((d.querySelector('[aria-label="业务板块"]') as HTMLSelectElement).value).toBe('');
    await click('转入 CRM', d); expect(bridge.current.run).toHaveBeenCalledWith({ type: 'market.lead.convertToCrm', payload: { id: l.id, customerId: undefined, opportunity: null } });
  });
  it('已转线索可回客户和开发，已流失必须先恢复联系', async () => {
    const c = state.market.campaigns.find(c => c.name.startsWith('AW27'))!, l = state.market.leads.find(x => x.source === 'campaign' && x.parentId === c.id && x.status !== 'Converted')!;
    l.status = 'Converted'; l.customerId = state.customers[0].id; await mount(l.id, `campaign-leads:${c.id}`);
    expect(button('转入 CRM')!.disabled).toBe(true); await click('从客户发起开发');
    expect(go).toHaveBeenCalledWith('development/new', undefined, { customerId: l.customerId });
    await act(async () => root!.unmount()); root = undefined; host.remove(); l.status = 'Lost'; await mount(l.id, `campaign-leads:${c.id}`);
    expect(button('转入 CRM')!.disabled).toBe(true); expect(host.textContent).toContain('请先恢复联系');
  });
  it('画册预览 Prepared 使用冻结快照，PDF/发送明确未接入', async () => {
    const b = state.market.lookbooks[0]; b.status = 'Prepared'; b.snapshots = [{ id: b.productIds[0], sku: 'FROZEN-SKU', name: '冻结产品名称', specification: '冻结规格' }];
    await mount(b.id, 'lookbooks'); expect(host.textContent).toContain('冻结产品名称'); expect(host.textContent).toContain('冻结规格');
    expect(button('导出画册 PDF')!.disabled).toBe(true); expect(button('发送画册')!.disabled).toBe(true);
    expect(host.textContent).toContain('CSV'); expect(bridge.current.run).not.toHaveBeenCalled();
  });
  it('失效来源深链不提供新建线索入口', async () => {
    await mount(undefined, 'campaign-leads:missing'); expect(host.textContent).toContain('来源活动不存在'); expect(button('新建')).toBeUndefined();
  });
});
