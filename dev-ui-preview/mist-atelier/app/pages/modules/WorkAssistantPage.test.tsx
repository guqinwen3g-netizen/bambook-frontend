// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkAssistantPage, parseBusinessLink } from './WorkAssistantPage';
import { Nav } from '../../nav';

const ctx = vi.hoisted(() => ({
  user: { id: 'u-1', displayName: '业务员甲' } as { id: string; displayName: string } | null,
  sessionKey: 's', canChat: true,
  workspace: { id: 'w-1', name: '甲工作区' } as { id: string; name: string } | null,
}));
vi.mock('../../runtime/auth', () => { const useMistSession = () => ({ sessionKey: ctx.sessionKey, user: ctx.user, hasPermission: (p: string) => p === 'ai:chat' && ctx.canChat }); return { useMistSession, useOptionalMistSession: useMistSession }; });
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => ({ workspace: ctx.workspace }) }));
vi.mock('../../../../../services/apiService', () => ({ apiService: { getAuthHeaders: () => ({ Authorization: 'Bearer personal' }) } }));

type Handler = (method: string, params: any) => unknown;
let root: Root | undefined, host: HTMLDivElement, emit: (e: unknown) => void = () => undefined, renders = 0;
const calls: Array<[string, any]> = [];
const go = vi.fn();
const install = (handler: Handler) => {
  (window as any).bambookAssistant = {
    request: async (method: string, params: any) => { calls.push([method, params]); try { return { ok: true, result: await handler(method, params) }; } catch (e: any) { return { ok: false, error: { code: e.code ?? 'E', message: e.message } }; } },
    onEvent: (cb: (e: unknown) => void) => { emit = cb; return () => { emit = () => undefined; }; },
  };
};
const provider = { id: 'p-1', name: '我的 ChatGPT', format: 'chatgpt-subscription', base_url: 'https://chatgpt.com/backend-api/codex', model: 'gpt-6-luna', context_window: 272000, max_tokens: 8192, has_api_key: false };
const delegationHandler = (_m: string, params: any) => params.clear ? { connected: false, workspaceId: null } : { connected: true, workspaceId: params.workspaceId };
const base: Handler = (method, params) => method === 'session.delegation' ? delegationHandler(method, params) : ({ 'host.status': { state: 'running' }, 'account.select': {}, 'providers.list': [provider], 'sessions.list': [], 'chatgpt.status': { connected: true, email: 'me@example.com', plan: 'pro', connectedAt: null } } as Record<string, unknown>)[method];
const later = () => new Date(Date.now() + 2 * 3600_000).toISOString();
const grant = (token = 'dlg-1', expiresAt = later()) => new Response(JSON.stringify({ delegation: { token, expiresAt }, readable: [{ type: 'order', label: '订单' }, { type: 'customer', label: '客户' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;
const delegationPosts = () => fetchMock.mock.calls.filter(c => c[0] === '/api/mist/agent/delegations');
const binds = () => calls.filter(c => c[0] === 'session.delegation' && !c[1].clear).map(c => c[1]);
const clears = () => calls.filter(c => c[0] === 'session.delegation' && c[1].clear);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; calls.length = 0; go.mockReset();
  ctx.user = { id: 'u-1', displayName: '业务员甲' }; ctx.sessionKey = 's'; ctx.canChat = true; ctx.workspace = { id: 'w-1', name: '甲工作区' };
  fetchMock = vi.fn(async () => grant()); vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); delete (window as any).bambookAssistant; vi.unstubAllGlobals(); vi.useRealTimers(); });
const page = () => <Nav.Provider value={{ route: { view: 'assistant' }, go, theme: 'light', toggleTheme: () => undefined, openPalette: () => undefined, openAI: () => undefined }}><WorkAssistantPage tabs={<span data-render={++renders} />} /></Nav.Provider>;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(page())); await settle(); }
async function rerender() { await act(async () => root!.render(page())); await settle(); }
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function type(text: string) { const field = host.querySelector('textarea[aria-label="给工作助手的指令"]') as HTMLTextAreaElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

it('explains that the assistant needs the desktop app when the bridge is absent', async () => {
  await mount();
  expect(host.textContent).toContain('需在 Bambook 桌面端使用');
  expect(host.querySelector('textarea')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('binds the local runtime to the signed-in account and asks to connect a personal model first', async () => {
  install((method, params) => (method === 'providers.list' ? [] : base(method, params)));
  await mount();
  expect(calls.find(c => c[0] === 'account.select')?.[1]).toEqual({ accountKey: `${location.origin}|u-1`, displayName: '业务员甲' });
  expect(host.textContent).toContain('先连接你的模型');
  expect(button('用 ChatGPT 登录')).toBeTruthy();
});

it('issues a delegation with the personal session and hands only the short token to the local host', async () => {
  install(base);
  await mount();
  expect(delegationPosts()).toHaveLength(1);
  const [, init] = delegationPosts()[0];
  expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', headers: expect.objectContaining({ Authorization: 'Bearer personal' }) });
  expect(binds()).toEqual([expect.objectContaining({ accountKey: `${location.origin}|u-1`, token: 'dlg-1', workspaceId: 'w-1', apiBase: location.origin })]);
  expect(JSON.stringify(binds())).not.toContain('personal');
  expect(host.textContent).toContain('业务读取已连接 · 甲工作区');
  expect(host.textContent).toContain('可读：订单、客户');
});

it('streams a run, shows a confirmation card and answers with the issued token only on click', async () => {
  install((method, params) => method === 'run.start' ? { runId: 'r1', sessionId: 's1' } : method === 'sessions.get' ? { meta: { id: 's1' }, messages: [{ role: 'user', content: '发邮件给客户' }] } : method === 'confirm.resolve' ? { ok: true } : base(method, params));
  await mount();
  await type('发邮件给客户');
  await act(async () => button('发送')!.click());
  expect(calls.find(c => c[0] === 'run.start')?.[1]).toEqual({ providerId: 'p-1', text: '发邮件给客户', sessionId: undefined, accountKey: `${location.origin}|u-1`, workspaceId: 'w-1' });
  await act(async () => emit({ type: 'run', runId: 'r1', sessionId: 's1', event: { type: 'text', delta: '我先起草' } }));
  expect(host.textContent).toContain('我先起草');
  await act(async () => emit({ type: 'confirm_request', runId: 'r1', sessionId: 's1', token: 'tok-1', request: { tool: 'send_mail', risk: 'external', summary: '发给 buyer@example.com', groupKey: 'send_mail:*' } }));
  expect(host.textContent).toContain('需要你确认：对外发送');
  expect(calls.some(c => c[0] === 'confirm.resolve')).toBe(false);
  await act(async () => button('不执行')!.click());
  expect(calls.find(c => c[0] === 'confirm.resolve')?.[1]).toEqual({ runId: 'r1', token: 'tok-1', approved: false });
  expect(host.textContent).not.toContain('需要你确认');
  expect(button('停止')).toBeTruthy();
  await act(async () => emit({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'completed', text: '好的' }));
  expect(button('发送')).toBeTruthy();
});

it('shows host failures with a manual restart, reconnects the delegation after restart and surfaces run errors', async () => {
  install((method, params) => method === 'host.restart' ? { state: 'starting' } : method === 'run.start' ? { runId: 'r2', sessionId: 's2' } : method === 'sessions.get' ? { meta: { id: 's2' }, messages: [] } : base(method, params));
  await mount();
  await act(async () => emit({ type: 'host_status', status: { state: 'failed', reason: '内存超过 1536MB' } }));
  expect(host.textContent).toContain('工作助手已停止');
  await act(async () => button('重新启动')!.click());
  expect(calls.some(c => c[0] === 'host.restart')).toBe(true);
  await act(async () => emit({ type: 'host_status', status: { state: 'running' } }));
  await settle();
  // 新 host 进程没有内存里的旧委托，必须重新签发并绑定。
  expect(delegationPosts()).toHaveLength(2);
  expect(binds()).toHaveLength(2);
  await type('做事');
  await act(async () => button('发送')!.click());
  await act(async () => emit({ type: 'run_error', runId: 'r2', sessionId: 's2', code: 'MODEL_LIMITED', message: 'ChatGPT用量已达上限，请稍后再试' }));
  expect(host.textContent).toContain('ChatGPT用量已达上限');
});

it('renews before expiry on its own and dedupes reconnect requests from the host', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const soon = new Date(Date.now() + 10 * 60_000 + 45_000).toISOString();
  fetchMock.mockImplementationOnce(async () => grant('dlg-1', soon));
  install(base);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(page()); await vi.advanceTimersByTimeAsync(0); });
  for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(binds().map(b => b.token)).toEqual(['dlg-1']);
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(binds().map(b => b.token)).toEqual(['dlg-1', 'dlg-1']);
  expect(delegationPosts()).toHaveLength(2);
  // 同一时刻多次 delegation_needed 只发起一次签发；其他工作区的事件忽略。
  const gate = deferred<Response>();
  fetchMock.mockImplementationOnce(() => gate.promise);
  await act(async () => { emit({ type: 'delegation_needed', workspaceId: 'w-1', reason: 'expired' }); emit({ type: 'delegation_needed', workspaceId: 'w-1', reason: 'rejected' }); emit({ type: 'delegation_needed', workspaceId: 'w-other', reason: 'missing' }); await vi.advanceTimersByTimeAsync(0); });
  expect(delegationPosts()).toHaveLength(3);
  await act(async () => { gate.resolve(grant('dlg-2')); await vi.advanceTimersByTimeAsync(0); });
  for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(binds().map(b => b.token)).toEqual(['dlg-1', 'dlg-1', 'dlg-2']);
});

it('shows failures and lets the user retry; accounts without ai:chat never request a delegation', async () => {
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: '当前账号不能使用工作助手' } }), { status: 403 }));
  install(base);
  await mount();
  expect(host.textContent).toContain('当前账号不能使用工作助手');
  expect(button('发送')!.disabled).toBe(true);
  await act(async () => button('重新连接')!.click());
  await settle();
  expect(host.textContent).toContain('业务读取已连接');
  await act(async () => root!.unmount()); root = undefined; host.remove();
  ctx.canChat = false; fetchMock.mockClear();
  await mount();
  expect(host.textContent).toContain('无工作助手使用权限');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('drops a late delegation for the previous workspace and clears host authorization on switch and unmount', async () => {
  const gate = deferred<Response>();
  fetchMock.mockImplementationOnce(() => gate.promise);
  install((method, params) => method === 'sessions.list' ? [{ id: 'a', title: '甲空间对话', workspaceId: 'w-1', providerId: null, createdAt: '', updatedAt: '2026-10-15T00:00:00Z', messageCount: 1 }, { id: 'b', title: '乙空间对话', workspaceId: 'w-2', providerId: null, createdAt: '', updatedAt: '2026-10-15T00:00:00Z', messageCount: 1 }] : base(method, params));
  await mount();
  expect(host.textContent).toContain('甲空间对话');
  expect(host.textContent).not.toContain('乙空间对话');
  ctx.workspace = { id: 'w-2', name: '乙工作区' };
  const clearsBefore = clears().length;
  await rerender();
  expect(clears().length).toBeGreaterThan(clearsBefore);
  await act(async () => { gate.resolve(grant('late-w1')); });
  await settle();
  expect(binds().map(b => [b.token, b.workspaceId])).toEqual([['dlg-1', 'w-2']]);
  expect(host.textContent).toContain('乙空间对话');
  expect(host.textContent).not.toContain('甲空间对话');
  const beforeUnmount = clears().length;
  await act(async () => root!.unmount()); root = undefined;
  expect(clears().length).toBe(beforeUnmount + 1);
});

it('releases sending when the context switches mid-send and ignores the late result', async () => {
  const start = deferred<{ runId: string; sessionId: string }>();
  install((method, params) => method === 'run.start' ? start.promise : base(method, params));
  await mount();
  await type('查订单');
  await act(async () => button('发送')!.click());
  ctx.workspace = { id: 'w-2', name: '乙工作区' };
  await rerender();
  await act(async () => { start.resolve({ runId: 'old', sessionId: 'old-s' }); });
  await settle();
  expect(button('停止')).toBeUndefined();
  await type('查乙空间订单');
  expect(button('发送')!.disabled).toBe(false);
  expect(host.querySelector('[aria-busy="true"]')).toBeNull();
});

it('does not reselect the previous account when its initialization finishes late', async () => {
  const status = deferred<unknown>();
  let first = true;
  install((method, params) => { if (method === 'host.status' && first) { first = false; return status.promise; } return base(method, params); });
  await mount();
  ctx.user = { id: 'u-2', displayName: '业务员乙' };
  await rerender();
  await act(async () => { status.resolve({ state: 'running' }); });
  await settle();
  expect(calls.filter(c => c[0] === 'account.select').map(c => c[1].accountKey)).toEqual([`${location.origin}|u-2`]);
});

it('keeps a late session-load error inside its own conversation', async () => {
  const slow = deferred<unknown>();
  install((method, params) => method === 'sessions.list' ? [{ id: 'a', title: '对话甲', workspaceId: 'w-1', providerId: null, createdAt: '', updatedAt: '2026-10-15T00:00:00Z', messageCount: 1 }, { id: 'b', title: '对话乙', workspaceId: 'w-1', providerId: null, createdAt: '', updatedAt: '2026-10-15T00:00:00Z', messageCount: 1 }]
    : method === 'sessions.get' ? (params.id === 'a' ? slow.promise : { meta: { id: 'b', workspaceId: 'w-1' }, messages: [{ role: 'assistant', content: '乙的回答' }] }) : base(method, params));
  await mount();
  const openRow = (title: string) => [...host.querySelectorAll('button.mist-wa-open')].find(b => b.textContent?.includes(title)) as HTMLButtonElement;
  await act(async () => openRow('对话甲').click());
  await act(async () => openRow('对话乙').click());
  await settle();
  await act(async () => { slow.reject(Object.assign(new Error('会话不存在或已删除'), { code: 'SESSION_NOT_FOUND' })); });
  await settle();
  expect(host.textContent).toContain('乙的回答');
  expect(host.textContent).not.toContain('会话不存在或已删除');
});

it('renders only whitelisted business references as links back to the original record', async () => {
  install((method, params) => method === 'sessions.list' ? [{ id: 'a', title: '查单', workspaceId: 'w-1', providerId: null, createdAt: '', updatedAt: '2026-10-15T00:00:00Z', messageCount: 2 }]
    : method === 'sessions.get' ? { meta: { id: 'a', workspaceId: 'w-1' }, messages: [{ role: 'assistant', content: '见 [订单 SO-1](bambook://open?view=orders/detail&id=o-1)，另有 [伪造](bambook://open?view=admin&id=1)、[外链](https://evil.example/?view=crm&id=1) 和 [脚本](javascript:void(0))。' }] } : base(method, params));
  await mount();
  await act(async () => ([...host.querySelectorAll('button.mist-wa-open')][0] as HTMLButtonElement).click());
  await settle();
  const links = [...host.querySelectorAll('[title="打开业务原记录"]')];
  expect(links.map(l => l.textContent)).toEqual(['订单 SO-1']);
  expect(host.textContent).toContain('[伪造](bambook://open?view=admin&id=1)');
  expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
  await act(async () => (links[0] as HTMLElement).click());
  expect(go).toHaveBeenCalledWith('orders/detail', 'o-1');
  for (const bad of ['bambook://open?view=crm&id=1&x=2', 'bambook://open?view=crm&view=orders/detail&id=1', 'bambook://evil?view=crm&id=1', 'bambook://open/x?view=crm&id=1', 'bambook://open?view=crm&id=%0a1', 'bambook://open?view=crm&id=+'])
    expect(parseBusinessLink(bad)).toBeNull();
  expect(parseBusinessLink('bambook://open?view=crm&id=c-9')).toEqual({ view: 'crm', id: 'c-9' });
});
