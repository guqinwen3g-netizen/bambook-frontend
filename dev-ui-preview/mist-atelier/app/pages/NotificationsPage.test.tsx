// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMistState, applyMistCommand, type MistCommand } from '../../../../server/src/shared/mistWorkspace';
import { MistRoot, ToastProvider } from '../../../../components/mist';
import { Nav } from '../nav';
const seam = vi.hoisted(() => ({ value: null as any, route: { view: 'notifications' } as any, session: { sessionKey: 'one', user: { id: 'owner', displayName: '当前员工' }, hasPermission: () => true, canAccessView: (_view: string): boolean => true } }));
vi.mock('../runtime/workspace', () => ({ useMistWorkspace: () => seam.value }));
vi.mock('../runtime/auth', () => ({ useMistSession: () => seam.session }));
import { NotificationsPage, notificationRows } from './NotificationsPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLElement, count = 0;
const go = vi.fn();
const ctx = () => ({ id: () => `record-${++count}`, now: '2026-10-15T08:00:00.000Z', actorName: '当前员工' });
const element = () => <MistRoot><ToastProvider><Nav.Provider value={{ route: seam.route, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() } as any}><NotificationsPage /></Nav.Provider></ToastProvider></MistRoot>;
const paint = () => root!.render(element());
const render = () => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(paint); };
const button = (text: string) => { const value = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text); expect(value).toBeDefined(); return value!; };
const click = async (target: HTMLElement) => act(async () => target.click());
const notes = () => [
  { id: 'n-qc', category: 'qc', title: 'QC 报告已回传', detail: '样品评审通过', at: '2026-10-15T07:00:00Z', readAt: null, target: { view: 'qc-workbench', id: 'qc-1' } },
  { id: 'n-ship', category: 'shipping', title: '出运准备提醒', detail: '本周出运', at: '2026-10-14T07:00:00Z', readAt: null, target: { view: 'shipments', id: 'sh-1' } },
  { id: 'n-old', category: 'general', title: '已读的工作通知', detail: '订单已确认', at: '2026-10-13T07:00:00Z', readAt: '2026-10-13T08:00:00Z', target: { view: 'orders/detail', id: 'o-1' } },
];
beforeEach(() => {
  vi.clearAllMocks(); count = 0; seam.route = { view: 'notifications' };
  seam.session = { sessionKey: 'one', user: { id: 'owner', displayName: '当前员工' }, hasPermission: () => true, canAccessView: () => true };
  const state = createMistState(ctx(), 'empty'); state.notifications = notes() as any;
  seam.value = { state, workspace: { id: 'w1', name: '空间' }, loading: false, saving: false, pending: null, error: '',
    run: vi.fn(async (command: MistCommand) => { seam.value.state = applyMistCommand(seam.value.state, command, ctx()).state; paint(); return { result: {} }; }) };
});
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; });

describe('notification center', () => {
  it('filters by read state, type and text, newest first', () => {
    const rows = notes() as any;
    expect(notificationRows(rows, 'unread', 'all', '').map(n => n.id)).toEqual(['n-qc', 'n-ship']);
    expect(notificationRows(rows, 'all', 'all', '').map(n => n.id)).toEqual(['n-qc', 'n-ship', 'n-old']);
    expect(notificationRows(rows, 'all', 'general', '').map(n => n.id)).toEqual(['n-old']);
    expect(notificationRows(rows, 'all', 'all', '订单').map(n => n.id)).toEqual(['n-old']);
  });
  it('shows unread by default and marks one read before opening its exact object', async () => {
    render(); expect(host.querySelector('h1')?.textContent).toContain('通知中心');
    expect(host.textContent).toContain('QC 报告已回传'); expect(host.textContent).not.toContain('已读的工作通知');
    await click([...host.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === '打开')[0]);
    expect(seam.value.run).toHaveBeenCalledWith({ type: 'notification.read', payload: { id: 'n-qc' } });
    expect(go).toHaveBeenCalledWith('qc-workbench', 'qc-1', { view: 'qc-workbench', id: 'qc-1' });
  });
  it('marks everything read through the workspace command', async () => {
    render(); await click(button('全部标为已读'));
    expect(seam.value.run).toHaveBeenCalledWith({ type: 'notification.readAll', payload: {} });
    expect(seam.value.state.notifications.every((n: any) => n.readAt)).toBe(true);
    expect(host.textContent).toContain('没有未读通知'); expect((button('全部标为已读')).disabled).toBe(true);
  });
  it('respects module access and disabled categories, and links to subscription settings', async () => {
    seam.session.canAccessView = (view: string) => view !== 'shipments'; seam.value.state.settings.notifications.qc = false; seam.route = { view: 'notifications', section: 'all' };
    render(); expect(host.textContent).not.toContain('QC 报告已回传'); expect(host.textContent).not.toContain('出运准备提醒'); expect(host.textContent).toContain('已读的工作通知');
    expect(host.textContent).toContain('已关闭：QC 报告回传');
    await click(button('通知订阅')); expect(go).toHaveBeenCalledWith('settings', undefined, { section: 'notify' });
  });
  it('does not fake a read state when the command fails', async () => {
    seam.value.run = vi.fn(async () => { throw new Error('未保存'); }); render();
    await click([...host.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === '打开')[0]);
    expect(go).not.toHaveBeenCalled(); expect(seam.value.state.notifications[0].readAt).toBeNull(); expect(host.textContent).toContain('未保存');
  });
});
