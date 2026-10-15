// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkAssistantPage } from './WorkAssistantPage';

vi.mock('../../runtime/auth', () => ({ useMistSession: () => ({ sessionKey: 's', user: { id: 'u-1', displayName: '业务员甲' }, hasPermission: () => true }) }));

type Handler = (method: string, params: any) => unknown;
let root: Root | undefined, host: HTMLDivElement, emit: (e: unknown) => void = () => undefined;
const calls: Array<[string, any]> = [];
const install = (handler: Handler) => {
  (window as any).bambookAssistant = {
    request: async (method: string, params: any) => { calls.push([method, params]); try { return { ok: true, result: await handler(method, params) }; } catch (e: any) { return { ok: false, error: { code: e.code ?? 'E', message: e.message } }; } },
    onEvent: (cb: (e: unknown) => void) => { emit = cb; return () => { emit = () => undefined; }; },
  };
};
const provider = { id: 'p-1', name: '我的 ChatGPT', format: 'chatgpt-subscription', base_url: 'https://chatgpt.com/backend-api/codex', model: 'gpt-6-luna', context_window: 272000, max_tokens: 8192, has_api_key: false };
const base: Handler = method => ({ 'host.status': { state: 'running' }, 'account.select': {}, 'providers.list': [provider], 'sessions.list': [], 'chatgpt.status': { connected: true, email: 'me@example.com', plan: 'pro', connectedAt: null } } as Record<string, unknown>)[method];

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; calls.length = 0; });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); delete (window as any).bambookAssistant; });
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<WorkAssistantPage />)); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function type(text: string) { const field = host.querySelector('textarea[aria-label="给工作助手的指令"]') as HTMLTextAreaElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('explains that the assistant needs the desktop app when the bridge is absent', async () => {
  await mount();
  expect(host.textContent).toContain('需在 Bambook 桌面端使用');
  expect(host.querySelector('textarea')).toBeNull();
});

it('binds the local runtime to the signed-in account and asks to connect a personal model first', async () => {
  install(method => (method === 'providers.list' ? [] : base(method, {})));
  await mount();
  expect(calls.find(c => c[0] === 'account.select')?.[1]).toEqual({ accountKey: `${location.origin}|u-1`, displayName: '业务员甲' });
  expect(host.textContent).toContain('先连接你的模型');
  expect(button('用 ChatGPT 登录')).toBeTruthy();
});

it('streams a run, shows a confirmation card and answers with the issued token only on click', async () => {
  install((method, params) => method === 'run.start' ? { runId: 'r1', sessionId: 's1' } : method === 'sessions.get' ? { meta: { id: 's1' }, messages: [{ role: 'user', content: '发邮件给客户' }] } : method === 'confirm.resolve' ? { ok: true } : base(method, params));
  await mount();
  await type('发邮件给客户');
  await act(async () => button('发送')!.click());
  expect(calls.find(c => c[0] === 'run.start')?.[1]).toEqual({ providerId: 'p-1', text: '发邮件给客户', sessionId: undefined });
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

it('shows host failures with a manual restart and surfaces run errors', async () => {
  install((method, params) => method === 'host.restart' ? { state: 'starting' } : method === 'run.start' ? { runId: 'r2', sessionId: 's2' } : method === 'sessions.get' ? { meta: { id: 's2' }, messages: [] } : base(method, params));
  await mount();
  await act(async () => emit({ type: 'host_status', status: { state: 'failed', reason: '内存超过 1536MB' } }));
  expect(host.textContent).toContain('工作助手已停止');
  await act(async () => button('重新启动')!.click());
  expect(calls.some(c => c[0] === 'host.restart')).toBe(true);
  await type('做事');
  await act(async () => button('发送')!.click());
  await act(async () => emit({ type: 'run_error', runId: 'r2', sessionId: 's2', code: 'MODEL_LIMITED', message: 'ChatGPT用量已达上限，请稍后再试' }));
  expect(host.textContent).toContain('ChatGPT用量已达上限');
});
