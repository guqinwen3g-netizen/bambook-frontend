// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../../../../services/authService';
import { View } from '../../../../types';
import { MistSessionProvider, useMistSession, type MistSession } from './auth';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const user = (id: string): auth.AuthUser => ({ id, displayName: id, email: `${id}@example.com`, roles: ['sales'], roleIds: ['sales-role'], permissions: ['orders:read'], permissionCeiling: ['orders:read'], departmentIds: ['team-a'], department: 'Team A' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let actor: auth.AuthUser | null, root: Root | undefined, host: HTMLElement | undefined, session: MistSession;
let override: ((url: URL, init: RequestInit) => Promise<Response> | null) | undefined;
let requests: Array<{ path: string; method: string; body?: unknown }>;
async function waitFor(check: () => void) { let last: unknown; for (let i = 0; i < 60; i++) { try { check(); return; } catch (error) { last = error; await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); }); } } throw last; }
function Probe() { session = useMistSession(); return <div data-status={session.status}>{session.user?.id ?? 'guest'}</div>; }
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<MistSessionProvider><Probe /></MistSessionProvider>)); }
beforeEach(async () => {
  actor = null; override = undefined; requests = []; localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('panda_system_config', JSON.stringify({ cloudEndpoint: 'https://mist-session.example/api' }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input), location.href); const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, method: init.method ?? 'GET', body });
    const special = override?.(url, init); if (special) return special;
    if(url.pathname==='/api/mist/session')return json({message:'Not found'},404);
    if (url.pathname.endsWith('/auth/logout')) return json({ ok: true });
    if (url.pathname.endsWith('/auth/login')) { actor = user(String(body.identifier)); return json({ user: actor, token: `token-${actor.id}` }); }
    if (url.pathname.endsWith('/auth/me')) return actor ? json({ user: actor }) : json({ message: '未登录' }, 401);
    throw new Error(`Unexpected test request: ${url.pathname}`);
  }));
  await auth.logout(); requests = [];
});
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; host = undefined; vi.unstubAllGlobals(); });
describe('Mist session adapter with production auth service', () => {
  it('initializes only through real /me and never automatically logs into a development identity', async () => {
    const response = deferred<Response>(); override = url => url.pathname.endsWith('/auth/me') ? response.promise : null;
    await mount(); expect(session.status).toBe('loading'); expect(session.user).toBeNull(); expect(session.canAccessView(View.Orders)).toBe(false);
    expect(requests.map(request => request.path)).toEqual(['/api/mist/session','/api/auth/me']);
    await expect(session.login('cannot-bypass', 'password')).rejects.toThrow('正在核验');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    await act(async () => response.resolve(json({ message: '未登录' }, 401)));
    await waitFor(() => expect(session.status).toBe('anonymous'));
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('restores a validated session, respects the permission ceiling and exposes no token in its session key', async () => {
    await auth.login('cached-user', 'password'); actor = { ...user('cached-user'), permissions: ['*'], permissionCeiling: ['orders:read'] }; requests = [];
    await mount(); await waitFor(() => expect(session.status).toBe('authenticated'));
    expect(session.user?.id).toBe('cached-user'); expect(session.canAccessView(View.Orders)).toBe(true); expect(session.hasPermission('finance:write')).toBe(false); expect(session.hasRole('sales')).toBe(true);
    expect(session.sessionKey).not.toContain('token-cached-user'); expect(session.sessionKey).not.toContain('cached-user');
    expect(requests.map(request => request.path)).toEqual(['/api/mist/session','/api/auth/me']);
  });
  it('drops the exposed user and advances session identity on a server 401', async () => {
    await auth.login('first', 'password'); await mount(); await waitFor(() => expect(session.status).toBe('authenticated')); const key = session.sessionKey;
    actor = null; await act(async () => session.refresh());
    expect(session.status).toBe('anonymous'); expect(session.user).toBeNull(); expect(session.sessionKey).not.toBe(key); expect(session.hasPermission('orders:read')).toBe(false);
  });
  it('rejects a malformed successful login response without exposing an authenticated page', async () => {
    await mount(); await waitFor(() => expect(session.status).toBe('anonymous'));
    override = url => url.pathname.endsWith('/auth/login') ? Promise.resolve(json({ token: 'malformed-token' })) : null;
    let failure: unknown; await act(async () => { failure = await session.login('first', 'password').catch(error => error); });
    expect((failure as Error).message).toContain('未包含有效账号'); expect(session.status).toBe('anonymous'); expect(session.user).toBeNull();
  });
  it('does not allow a late login to revive an explicitly logged-out session', async () => {
    await mount(); await waitFor(() => expect(session.status).toBe('anonymous'));
    const response = deferred<Response>(); override = url => url.pathname.endsWith('/auth/login') ? response.promise : null;
    let login!: Promise<unknown>;
    act(() => { login = session.login('first', 'password').catch(error => error); });
    await act(async () => session.logout());
    await act(async () => response.resolve(json({ user: user('first'), token: 'late-token' })));
    await login;
    expect(session.status).toBe('anonymous'); expect(session.user).toBeNull(); expect(localStorage.getItem('bambook_auth_token')).toBeNull();
  });
  it('keeps a newer login when an older logout acknowledgement arrives late', async () => {
    await mount(); await waitFor(() => expect(session.status).toBe('anonymous')); await act(async () => session.login('first', 'password'));
    const response = deferred<Response>(); override = url => url.pathname.endsWith('/auth/logout') ? response.promise : null;
    let logout!: Promise<void>; act(() => { logout = session.logout(); });
    await act(async () => session.login('second', 'password'));
    await act(async () => response.resolve(json({ ok: true }))); await logout;
    expect(session.user?.id).toBe('second'); expect(session.status).toBe('authenticated'); expect(localStorage.getItem('bambook_auth_token')).toBe('token-second');
  });
  it('uses session-only token persistence when keep-login is unchecked', async () => {
    await mount(); await waitFor(() => expect(session.status).toBe('anonymous'));
    await act(async () => session.login('session-only', 'password', { remember: false }));
    expect(localStorage.getItem('bambook_auth_token')).toBeNull(); expect(sessionStorage.getItem('bambook_auth_token')).toBe('token-session-only'); expect(session.user?.id).toBe('session-only');
  });
  it('does not reuse an old cached actor after endpoint change fails to revalidate', async () => {
    await auth.login('old-server-user', 'password'); await mount(); await waitFor(() => expect(session.status).toBe('authenticated')); const key = session.sessionKey;
    override = url => url.pathname.endsWith('/auth/me') ? Promise.resolve(json({ message: '离线' }, 503)) : null;
    localStorage.setItem('panda_system_config', JSON.stringify({ cloudEndpoint: 'https://other-server.example/api' }));
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'panda_system_config' })); });
    await waitFor(() => expect(session.status).toBe('anonymous'));
    expect(session.user).toBeNull(); expect(session.sessionKey).not.toBe(key); expect(session.canAccessView(View.Orders)).toBe(false);
    expect(session.error).toContain('登录凭据或服务地址已变化');
    override = undefined; await act(async () => session.login('new-server-user', 'password'));
    expect(session.status).toBe('authenticated'); expect(session.user?.id).toBe('new-server-user');
  });
  it('retired provider callbacks cannot log out a later session', async () => {
    await mount(); await waitFor(() => expect(session.status).toBe('anonymous')); const retired = session;
    act(() => root!.unmount()); root = undefined;
    await auth.login('current-session', 'password'); const before = requests.length;
    await expect(retired.logout()).rejects.toThrow('会话页面已关闭'); await expect(retired.login('retired', 'password')).rejects.toThrow('会话页面已关闭');
    await retired.refresh(); expect(requests).toHaveLength(before); expect(auth.getAuthState().user?.id).toBe('current-session');
  });
  it('applies the latest concurrent /me response and ignores an older account snapshot', async () => {
    await auth.login('first', 'password'); await mount(); await waitFor(() => expect(session.status).toBe('authenticated'));
    const old = deferred<Response>(); let count = 0;
    override = url => url.pathname.endsWith('/auth/me') ? (++count === 1 ? old.promise : Promise.resolve(json({ user: user('second') }))) : null;
    let first!: Promise<void>; act(() => { first = session.refresh(); }); await act(async () => session.refresh());
    await act(async () => old.resolve(json({ user: user('first') }))); await first;
    expect(session.user?.id).toBe('second'); expect(session.status).toBe('authenticated');
  });
});
