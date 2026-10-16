import {createMistState as newModuleFixture} from '../../../server/src/shared/mistWorkspace';
// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import * as auth from '../../../services/authService';
import type { MistState } from '../../../server/src/shared/mistWorkspace';
import type { MistWorkspaceContext } from './runtime/workspace';

const probes = vi.hoisted(() => ({ home: vi.fn(), development: vi.fn(), detail: vi.fn(), order: vi.fn(), customer: vi.fn(), settings: vi.fn() }));
const workspaces = vi.hoisted(() => ({ version: 0, listeners: new Set<() => void>(), actors: new Map<string, any>(), empty: null as any }));
vi.mock('./runtime/workspace', async () => {
  const React = await import('react'), { useMistSession } = await import('./runtime/auth');
  return {
    MistWorkspaceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useMistWorkspace: () => {
      React.useSyncExternalStore(listener => { workspaces.listeners.add(listener); return () => { workspaces.listeners.delete(listener); }; }, () => workspaces.version, () => 0);
      const session = useMistSession();
      return session.status === 'authenticated' ? workspaces.actors.get(session.user!.id) ?? workspaces.empty : workspaces.empty;
    },
  };
});
vi.mock('./pages/HomePage', async () => {
  const React = await import('react'), { useNav } = await import('./nav');
  return { HomePage: function Home() {
    const nav = useNav(); probes.home();
    return <section aria-label="首页测试接缝"><button onClick={() => nav.go('development/detail', 'dev-a', { versionId: 'version-a', batchId: 'batch-a', section: 'overview', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a' })}>打开准确版本</button></section>;
  } };
});
vi.mock('./pages/DevListPage', async () => {
  const React = await import('react'), { useMistWorkspace } = await import('./runtime/workspace');
  return { DevListPage: function List() { const workspace = useMistWorkspace(); probes.development(); return <section aria-label="开发列表测试接缝">{workspace.state?.devs.map(item => item.name).join(',')}</section>; } };
});
vi.mock('./pages/DevDetailPage', async () => {
  const React = await import('react'), { useNav } = await import('./nav');
  return { DevDetailPage: function Detail() {
    const nav = useNav(); probes.detail(); const [draft, setDraft] = React.useState('');
    return <section aria-label="准确对象测试接缝"><output data-testid="exact-route">{JSON.stringify(nav.route)}</output>
      <input aria-label="本批次草稿" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => nav.go('development/detail', nav.route.id, { versionId: 'version-a', batchId: 'batch-b', section: 'qc', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a' })}>切换同版本批次</button>
      <button onClick={() => nav.go('development/detail', nav.route.id, { versionId: 'version-b', batchId: 'batch-c', section: 'overview', customerId: 'customer-b', orderLineId: 'line-b', productionId: 'production-b' })}>切换工厂版本</button></section>;
  } };
});
vi.mock('./pages/OrderDetailPage', async () => {
  const React = await import('react'), { useNav } = await import('./nav');
  return { OrderDetailPage: function Detail() { const nav = useNav(); probes.order(); return <section aria-label="订单测试接缝"><output data-testid="exact-route">{JSON.stringify(nav.route)}</output></section>; } };
});
vi.mock('./pages/CustomerPage', async () => {
  const React = await import('react'), { useNav } = await import('./nav');
  return { CustomerPage: function Customer() { const nav = useNav(); probes.customer(); return <section aria-label="客户测试接缝"><output data-testid="exact-route">{JSON.stringify(nav.route)}</output></section>; } };
});
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => { probes.settings(); return null; } }));
vi.mock('./pages/DevCreatePage', () => ({ DevCreatePage: () => null }));
vi.mock('./pages/OrderListPage', () => ({ OrderListPage: () => null }));
vi.mock('./pages/OrderCreatePage', () => ({ OrderCreatePage: () => null }));
vi.mock('./pages/CalendarPage', () => ({ CalendarPage: () => null }));
vi.mock('./pages/FinancePage', () => ({ FinancePage: () => null }));
vi.mock('./pages/ProductionPage', () => ({ ProductionPage: () => null }));
vi.mock('./pages/StatesPage', () => ({ StatesPage: () => null }));
vi.mock('./pages/DesignSystemPage', () => ({ DesignSystemPage: () => null }));
vi.mock('./pages/ModuleTemplatePage', () => ({ ModuleTemplatePage: () => null }));
import { ReferenceApp } from './ReferenceApp';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const user = (id: string, permissions = ['products:read', 'orders:read', 'crm:read']): auth.AuthUser => ({ id, displayName: id, email: `${id}@example.com`, roles: ['sales'], roleIds: ['sales-role'], permissions, permissionCeiling: permissions, departmentIds: ['team-a'], department: 'Team A' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const originalScrollTo = HTMLElement.prototype.scrollTo;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let host: HTMLDivElement | undefined, root: Root | undefined, actor: auth.AuthUser | null;
let requests: Array<{ path: string; method: string; body?: any; authorization?: string }>;
let override: ((url: URL, init: RequestInit) => Promise<Response> | null) | undefined;
function fixture(id: string): MistState {
  const values = { name: `开发-${id}`, customer: `客户-${id}`, style: `STYLE-${id}`, season: 'AW27', category: '外套', kind: 'new' as const, fabric: '羊毛', color: '深蓝', target: '样衣', sizeBase: 'M', goal: '确认版型', factories: ['工厂'], due: '2026-10-30', collaborators: [], sampleQuantity: 1 };
  return {
    ...newModuleFixture({actorName:'测试',now:'2026-10-13T00:00:00.000Z',id:()=>crypto.randomUUID()},'empty'),schemaVersion: 1, devs: [{ id: `dev-${id}`, code: `DEV-${id}`, name: values.name, style: values.style, owner: id, due: values.due, dueRel: '', stage: 1, state: '打样中', tone: 'accent', ver: 'A', fac: 1, img: 'coat', factory: '工厂', sample: '样衣', fabric: values.fabric, goal: values.goal, customer: values.customer, customerId: `customer-${id}`, currentVersionId: `version-${id}`, versionIds: [`version-${id}`], values, fileIds: [], createdAt: '2026-10-13', updatedAt: '2026-10-13' }],
    versions: [], drafts: [], fabrics: [], orderLines: [], productions: [], receipts: [], invoices: [], allocations: [], payments: [], contacts: [], files: [], events: [], tasks: [], notifications: [], calendar: [],
    orders: [{ id: `order-${id}`, code: `SO-${id}`, type: 'garment', customerId: `customer-${id}`, customer: values.customer, season: 'AW27', lines: 1, qty: 1, amount: 10, currency: 'USD', due: values.due, progress: 10, state: '生产中', tone: 'accent', owner: id, img: 'coat', checklist: [], handoffAt: null, createdAt: '2026-10-13', updatedAt: '2026-10-13' }],
    customers: [{ id: `customer-${id}`, name: values.customer, code: `C-${id}`, country: '中国', city: '上海', industry: '服装', owner: id, grade: 'A', currency: 'USD', terms: 'T/T', incoterm: 'FOB', categories: '成衣', creditLimit: 1000, since: '2026-01-01' }],
    settings: { theme: 'light', density: 'default', reducedMotion: false, notifications: { qc: true, shipping: true, suggestions: true, digest: false }, workspaceName: `工作区-${id}`, profileName: id, profileEmail: `${id}@example.com`, locale: 'zh-CN' },
  };
}
function context(id: string): MistWorkspaceContext {
  const state = fixture(id);
  return { state, workspace: { id: `workspace-${id}`, ownerId: id, name: state.settings.workspaceName, revision: 0, state }, workspaces: [{ id: `workspace-${id}`, name: state.settings.workspaceName }], loading: false, saving: false, error: '', pending: null,
    run: vi.fn().mockResolvedValue({ requestId: 'saved', revision: 1, result: {} }), recover: vi.fn().mockResolvedValue(undefined), refresh: vi.fn().mockResolvedValue(undefined), switchWorkspace: vi.fn().mockResolvedValue(undefined), createWorkspace: vi.fn().mockResolvedValue(undefined), uploadFile: vi.fn(), fileUrl: vi.fn(), downloadFile: vi.fn(), prepareCreditDocument: vi.fn().mockResolvedValue(undefined), issueCreditDocument: vi.fn().mockResolvedValue({}), downloadCreditDocument: vi.fn().mockResolvedValue(undefined) };
}
function publish() { workspaces.version++; workspaces.listeners.forEach(listener => listener()); }
function currentContext(id = 'staff-a') { return workspaces.actors.get(id) as MistWorkspaceContext; }
async function waitFor(check: () => void) {
  let failure: unknown;
  for (let index = 0; index < 100; index++) { try { check(); return; } catch (error) { failure = error; await act(async () => { await new Promise(resolve => setTimeout(resolve, 3)); }); } }
  throw failure;
}
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<React.StrictMode><ReferenceApp /></React.StrictMode>));
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
function input(element: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
function currentRoute() { return JSON.parse(host!.querySelector('[data-testid="exact-route"]')!.textContent!); }
async function signIn(id = 'staff-a', permissions?: string[]) {
  actor = user(id, permissions); if (!workspaces.actors.has(id)) workspaces.actors.set(id, context(id));
  await act(async () => auth.login(id, 'password'));
}
async function openSearch() {
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })));
  await waitFor(() => expect(queryByRole(host!, 'dialog', { name: '搜索' })).not.toBeNull());
}
function searchInput() { return getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'textbox') as HTMLInputElement; }
beforeEach(async () => {
  Object.values(probes).forEach(probe => probe.mockClear()); workspaces.actors.clear(); workspaces.listeners.clear(); workspaces.version++;
  workspaces.empty = { ...context('anonymous'), state: null, workspace: null, workspaces: [], loading: false };
  actor = null; override = undefined; requests = []; localStorage.clear(); sessionStorage.clear();
  history.replaceState(null, '', '/?intro=0&theme=light');
  localStorage.setItem('panda_system_config', JSON.stringify({ cloudEndpoint: 'https://mist-entry.example/api' }));
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (source: unknown, init: RequestInit = {}) => {
    const url = new URL(String(source), location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, method: init.method ?? 'GET', body, authorization: new Headers(init.headers).get('Authorization') ?? undefined });
    const special = override?.(url, init); if (special) return special;
    if(url.pathname==='/api/mist/session')return json({message:'Not found'},404);
    if (url.pathname.endsWith('/auth/logout')) return json({ ok: true });
    if (url.pathname.endsWith('/auth/login')) { const signedIn = actor && actor.id === body.identifier ? actor : user(body.identifier); actor = signedIn; return json({ user: signedIn, token: `token-${signedIn.id}` }); }
    if(url.pathname.endsWith('/api/mist/reviews')) return json({reviews:[]});
    if (url.pathname.endsWith('/auth/me')) return actor ? json({ user: actor }) : json({ message: '未登录' }, 401);
    throw new Error(`Unexpected entry test request: ${url.pathname}`);
  }));
  await auth.logout(); requests = [];
});
afterEach(() => {
  if (root) act(() => root!.unmount()); host?.remove(); root = undefined; host = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); HTMLElement.prototype.scrollTo = originalScrollTo;
});

describe('one Mist entry with real authentication and workspace state', () => {
  it('automatically enters the server-backed local workspace and switches identities without a password form', async () => {
    const profiles=[{id:'local-operator',name:'本地业务员'},{id:'local-reviewer',name:'本地审批人'}];
    let profileId='local-operator';
    for (const profile of profiles) workspaces.actors.set(profile.id,context(profile.id));
    override=(url,init)=>{
      if(url.pathname!=='/api/mist/session')return null;
      if(init.method==='POST')profileId=JSON.parse(String(init.body)).profileId;
      return Promise.resolve(json({mode:'local',user:{...user(profileId,['*']),displayName:profiles.find(p=>p.id===profileId)!.name},profiles}));
    };
    await mount();await waitFor(()=>expect(probes.home).toHaveBeenCalled());
    expect(queryByRole(host!,'form',{name:'登录'})).toBeNull();
    expect(host!.querySelector('input[type="password"]')).toBeNull();
    expect(requests.some(r=>r.path.includes('/auth/'))).toBe(false);
    await click(getByRole(host!,'button',{name:'打开准确版本'}));
    input(getByRole(host!,'textbox',{name:'本批次草稿'}) as HTMLInputElement,'属于原身份的草稿');
    await click(host!.querySelector<HTMLButtonElement>('.mist-me')!);
    const drawer=getByRole(host!,'dialog',{name:'本地工作区'});
    expect(queryByRole(drawer,'button',{name:'退出登录'})).toBeNull();
    await click(getByRole(drawer,'button',{name:'本地审批人'}));
    await waitFor(()=>expect(new URLSearchParams(location.search).get('view')).toBe('cockpit'));
    expect(queryByRole(host!,'dialog',{name:'本地工作区'})).toBeNull();
    expect(queryByRole(host!,'textbox',{name:'本批次草稿'})).toBeNull();
    const switchRequest=requests.find(r=>r.path==='/api/mist/session'&&r.method==='POST');
    expect(switchRequest?.body).toEqual({profileId:'local-reviewer'});
    await click(host!.querySelector<HTMLButtonElement>('.mist-me')!);
    expect(getByRole(host!, 'dialog', { name: '本地工作区' }).textContent).toContain('本地审批人');
  });

  it('shows a reconnect action rather than an old password form when local session discovery fails', async () => {
    override=url=>url.pathname==='/api/mist/session'?Promise.resolve(json({message:'本地工作区暂不可达'},503)):null;
    await mount();await waitFor(()=>expect(host!.textContent).toContain('本地工作区暂不可达'));
    expect(queryByRole(host!,'form',{name:'登录'})).toBeNull();
    expect(queryByRole(host!,'button',{name:'重新进入本地工作区'})).not.toBeNull();
    expect(requests.some(r=>r.path.includes('/auth/'))).toBe(false);
  });

  it('keeps StrictMode boot behind real /me verification without loading a business page anonymously', async () => {
    const response = deferred<Response>(); override = url => url.pathname.endsWith('/auth/me') ? response.promise : null;
    await mount(); expect(probes.home).not.toHaveBeenCalled(); expect(probes.development).not.toHaveBeenCalled();
    expect(host!.querySelector('form')).toBeNull(); expect(requests.every(request => request.path.endsWith('/auth/me') || request.path==='/api/mist/session')).toBe(true);
    await act(async () => response.resolve(json({ message: '未登录' }, 401)));
    await waitFor(() => expect(queryByRole(host!, 'form', { name: '登录' })).not.toBeNull());
    expect(probes.home).not.toHaveBeenCalled(); expect(requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('preserves every authorized deep-link identifier through a real login response', async () => {
    const expected = { view: 'development/detail', id: 'dev-a', versionId: 'version-a', batchId: 'batch-a', section: 'overview', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a', detail: 'full' };
    history.replaceState(null, '', '/?intro=0&theme=light&' + new URLSearchParams(expected));
    await mount(); await waitFor(() => expect(queryByRole(host!, 'form', { name: '登录' })).not.toBeNull());
    const response = deferred<Response>(); override = url => url.pathname.endsWith('/auth/login') ? response.promise : null;
    input(host!.querySelector('input[type="email"]')!, 'staff-a'); input(host!.querySelector('input[type="password"]')!, 'password');
    await act(async () => host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(probes.detail).not.toHaveBeenCalled(); expect(requests.filter(request => request.path.endsWith('/auth/login'))).toHaveLength(1);
    actor = user('staff-a'); workspaces.actors.set(actor.id, context(actor.id)); await act(async () => response.resolve(json({ user: actor, token: 'token-staff-a' })));
    await waitFor(() => expect(currentRoute()).toMatchObject(expected));
    for (const [key, value] of Object.entries(expected)) expect(new URLSearchParams(location.search).get(key)).toBe(value);
    expect(probes.home).not.toHaveBeenCalled();
  });

  it('opens authenticated workspace settings without granting system administration permission', async () => {
    await signIn('staff-a', ['products:read']);
    history.replaceState(null, '', '/?intro=0&view=workspace-settings');
    await mount(); await waitFor(() => expect(probes.settings).toHaveBeenCalled());
    expect(actor?.permissions).not.toContain('settings:system:read');
    expect(host!.textContent).toContain('工作空间设置');
    expect(host!.textContent).not.toContain('没有查看权限');
  });
  it('switches a member appearance locally without writing owner-managed settings', async () => {
    await signIn(); const ctx = currentContext();
    ctx.workspace!.ownerId = 'another-owner';
    ctx.workspace!.access = { role: 'member', canManageMembers: false, hidden: [] };
    await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    await click(getByRole(host!, 'button', { name: '切换深色' }));
    expect(host!.querySelector('.mist-root')?.getAttribute('data-theme')).toBe('dark');
    expect(ctx.run).not.toHaveBeenCalled(); expect(ctx.state!.settings.theme).toBe('light');
    await click(getByRole(host!, 'button', { name: '切换浅色' }));
    expect(host!.querySelector('.mist-root')?.getAttribute('data-theme')).toBe('light');
    expect(ctx.run).not.toHaveBeenCalled();
  });
  it('keeps the member command-palette theme action local too', async () => {
    await signIn(); const ctx = currentContext();
    ctx.workspace!.ownerId = 'another-owner';
    ctx.workspace!.access = { role: 'member', canManageMembers: false, hidden: [] };
    await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled()); await openSearch();
    input(searchInput(), '切换深浅色');
    await click(getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'button', { name: /切换深浅色/ }));
    expect(host!.querySelector('.mist-root')?.getAttribute('data-theme')).toBe('dark');
    expect(ctx.run).not.toHaveBeenCalled(); expect(ctx.state!.settings.theme).toBe('light');
  });
  it('still persists an owner theme through the existing workspace command', async () => {
    await signIn(); const ctx = currentContext();
    ctx.workspace!.access = { role: 'owner', canManageMembers: true, hidden: [] };
    await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    await click(getByRole(host!, 'button', { name: '切换深色' }));
    expect(ctx.run).toHaveBeenCalledExactlyOnceWith({ type: 'settings.update', payload: { theme: 'dark' } });
  });
  it.each(['development/detail', 'orders/detail', 'system-settings'])('does not mount an unauthorized direct link to %s', async view => {
    await signIn('limited', []); requests = []; history.replaceState(null, '', `/?intro=0&theme=light&view=${view}&id=dev-a&versionId=version-a`);
    await mount(); await waitFor(() => expect(host!.textContent).toContain('没有查看权限'));
    expect(probes.detail).not.toHaveBeenCalled(); expect(probes.order).not.toHaveBeenCalled(); expect(probes.settings).not.toHaveBeenCalled();
    expect(requests.every(request => (request.path.endsWith('/auth/me') || request.path === '/api/mist/reviews' || request.path === '/api/mist/session') || request.path === '/api/mist/reviews')).toBe(true);
  });

  it('preserves exact version, batch, customer, order-line and production history and resets route-local drafts', async () => {
    await signIn(); await mount(); await waitFor(() => expect(queryByRole(host!, 'button', { name: '打开准确版本' })).not.toBeNull());
    await click(getByRole(host!, 'button', { name: '打开准确版本' })); expect(currentRoute()).toMatchObject({ id: 'dev-a', versionId: 'version-a', batchId: 'batch-a', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a' });
    input(getByRole(host!, 'textbox', { name: '本批次草稿' }) as HTMLInputElement, '仅属于批次A');
    await click(getByRole(host!, 'button', { name: '切换同版本批次' })); expect(currentRoute().batchId).toBe('batch-b');
    expect((getByRole(host!, 'textbox', { name: '本批次草稿' }) as HTMLInputElement).value).toBe('');
    await click(getByRole(host!, 'button', { name: '切换工厂版本' })); expect(currentRoute()).toMatchObject({ versionId: 'version-b', batchId: 'batch-c', customerId: 'customer-b', orderLineId: 'line-b', productionId: 'production-b' });
    await act(async () => history.back()); await waitFor(() => expect(currentRoute()).toMatchObject({ versionId: 'version-a', batchId: 'batch-b', section: 'qc', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a' }));
    act(() => root!.unmount()); host!.remove(); root = undefined; host = undefined;
    await mount(); await waitFor(() => expect(currentRoute()).toMatchObject({ id: 'dev-a', versionId: 'version-a', batchId: 'batch-b', section: 'qc', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a' }));
  });

  it('searches live workspace development, orders and customers without reading legacy development endpoints', async () => {
    await signIn(); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled()); await openSearch();
    input(searchInput(), 'STYLE-staff-a'); await click(getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'button', { name: /开发-staff-a/ }));
    expect(currentRoute()).toMatchObject({ view: 'development/detail', id: 'dev-staff-a', versionId: 'version-staff-a' });
    await openSearch(); input(searchInput(), 'SO-staff-a'); await click(getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'button', { name: /SO-staff-a/ }));
    expect(currentRoute()).toMatchObject({ view: 'orders/detail', id: 'order-staff-a' });
    await openSearch(); input(searchInput(), 'C-staff-a'); await click(getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'button', { name: /客户-staff-a/ }));
    expect(currentRoute()).toMatchObject({ view: 'crm', id: 'customer-staff-a', customerId: 'customer-staff-a' });
    expect(requests.every(request => (request.path.includes('/auth/') || request.path === '/api/mist/reviews' || request.path === '/api/mist/session'))).toBe(true);
  });

  it('does not disclose records from unreadable modules in global search', async () => {
    await signIn('limited', ['orders:read']); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    await openSearch(); const palette = getByRole(host!, 'dialog', { name: '搜索' });
    expect(palette.textContent).toContain('SO-limited');
    expect(queryByRole(palette, 'button', { name: /开发-limited/ })).toBeNull();
    expect(queryByRole(palette, 'button', { name: /^客户-limited/ })).toBeNull();
  });

  it('does not disclose inaccessible development records through the workspace assistant', async () => {
    await signIn('limited', ['orders:read']); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true, cancelable: true })));
    await waitFor(() => expect(queryByRole(host!, 'dialog', { name: '小竹' })).not.toBeNull());
    const assistant = getByRole(host!, 'dialog', { name: '小竹' });
    expect(assistant.textContent).not.toContain('DEV-limited'); expect(assistant.textContent).not.toContain('开发-limited');
  });

  it('does not restore stale history metadata for a different exact object in the URL', async () => {
    await signIn();
    const target = { view: 'development/detail', id: 'dev-a', versionId: 'version-a', batchId: 'batch-a', section: 'qc', customerId: 'customer-a', orderLineId: 'line-a', productionId: 'production-a' };
    history.replaceState({ mistRoute: { ...target, batchId: 'other-batch', workbenchTarget: { stale: true } } }, '', '/?intro=0&theme=light&' + new URLSearchParams(target));
    await mount(); await waitFor(() => expect(currentRoute()).toMatchObject(target));
    expect(currentRoute().workbenchTarget).toBeUndefined();
  });

  it('replaces search and assistant session content when another account signs in', async () => {
    await signIn(); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled()); await openSearch();
    input(searchInput(), 'STYLE-staff-a'); expect(getByRole(host!, 'dialog', { name: '搜索' }).textContent).toContain('开发-staff-a');
    await signIn('staff-b'); await waitFor(() => expect(queryByRole(host!, 'dialog', { name: '搜索' })).toBeNull());
    await openSearch(); expect(searchInput().value).toBe(''); expect(getByRole(host!, 'dialog', { name: '搜索' }).textContent).toContain('开发-staff-b');
    expect(getByRole(host!, 'dialog', { name: '搜索' }).textContent).not.toContain('开发-staff-a');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true, cancelable: true })));
    await waitFor(() => expect(host!.textContent).toContain('DEV-staff-b'));
    await signIn('staff-c'); await waitFor(() => expect(queryByRole(host!, 'dialog')).toBeNull());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true, cancelable: true })));
    await waitFor(() => expect(host!.textContent).toContain('DEV-staff-c')); expect(host!.textContent).not.toContain('DEV-staff-b');
  });

  it('marks a notification read before following its precise target and keeps the drawer on rejection', async () => {
    await signIn(); const ctx = currentContext();
    ctx.state!.notifications.push({ id: 'notice-a', title: '审核完成', detail: '指定版本可以继续', at: '2026-10-13', readAt: null, target: { view: 'orders/detail', id: 'order-staff-a', orderLineId: 'line-a', productionId: 'production-a', customerId: 'customer-staff-a' } });
    await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled()); await click(getByRole(host!, 'button', { name: '通知' }));
    const first = deferred<any>(); vi.mocked(ctx.run).mockReturnValueOnce(first.promise);
    await click(getByRole(getByRole(host!, 'dialog', { name: '通知' }), 'button', { name: '阅读' }));
    expect(ctx.run).toHaveBeenLastCalledWith({ type: 'notification.read', payload: { id: 'notice-a' } }); expect(probes.order).not.toHaveBeenCalled();
    await act(async () => first.reject(new Error('未保存已读'))); expect(getByRole(host!, 'dialog', { name: '通知' }).textContent).toContain('审核完成'); expect(host!.textContent).toContain('未保存已读');
    const next = deferred<any>(); vi.mocked(ctx.run).mockReturnValueOnce(next.promise);
    await click(getByRole(getByRole(host!, 'dialog', { name: '通知' }), 'button', { name: '阅读' })); expect(probes.order).not.toHaveBeenCalled();
    await act(async () => next.resolve({ requestId: 'notice-read', revision: 1, result: {} }));
    expect(currentRoute()).toMatchObject({ view: 'orders/detail', id: 'order-staff-a', orderLineId: 'line-a', productionId: 'production-a', customerId: 'customer-staff-a' });
    expect(queryByRole(host!, 'dialog', { name: '通知' })).toBeNull();
  });

  it('awaits the global recovery receipt, retains failed intent and clears only acknowledged pending state', async () => {
    await signIn(); const ctx = currentContext(); ctx.pending = { workspaceId: 'workspace-staff-a', requestId: 'original-request', expectedRevision: 0, kind: 'command', command: { type: 'settings.update', payload: { density: 'compact' } } };
    await mount(); await waitFor(() => expect(queryByRole(host!, 'button', { name: '核对原请求' })).not.toBeNull());
    const first = deferred<any>(); vi.mocked(ctx.recover).mockReturnValueOnce(first.promise);
    await click(getByRole(host!, 'button', { name: '核对原请求' })); expect(ctx.recover).toHaveBeenCalledTimes(1); expect(host!.textContent).toContain('上次操作的结果需要核对');
    await act(async () => first.reject(new Error('原请求仍待核对'))); expect(host!.textContent).toContain('原请求仍待核对'); expect(ctx.pending?.requestId).toBe('original-request');
    vi.mocked(ctx.recover).mockImplementationOnce(async () => { ctx.pending = null; ctx.workspace!.revision = 1; publish(); return { requestId: 'original-request', revision: 1, result: {} }; });
    await click(getByRole(host!, 'button', { name: '核对原请求' })); expect(host!.textContent).not.toContain('上次操作的结果需要核对'); expect(ctx.run).not.toHaveBeenCalled();
  });

  it('clears account-local panels, messages and page drafts on logout and shows real login', async () => {
    await signIn(); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    await click(getByRole(host!, 'button', { name: '打开准确版本' })); input(getByRole(host!, 'textbox', { name: '本批次草稿' }) as HTMLInputElement, '私有未提交输入');
    await click(host!.querySelector<HTMLButtonElement>('.mist-me')!); expect(getByRole(host!, 'dialog', { name: '账号' }).textContent).toContain('staff-a');
    await click(getByRole(getByRole(host!, 'dialog', { name: '账号' }), 'button', { name: '退出登录' }));
    await waitFor(() => expect(queryByRole(host!, 'form', { name: '登录' })).not.toBeNull()); expect(queryByRole(host!, 'dialog')).toBeNull(); expect(host!.textContent).not.toContain('私有未提交输入');
    await signIn('staff-b'); await waitFor(() => expect(queryByRole(host!, 'textbox', { name: '本批次草稿' })).not.toBeNull());
    expect((getByRole(host!, 'textbox', { name: '本批次草稿' }) as HTMLInputElement).value).toBe('');
    expect(requests.filter(request => request.path.endsWith('/auth/logout'))).toHaveLength(1);
  });
  it('opens approvals outside the menu from global search and restores it from a direct link', async () => {
    await signIn(); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    await openSearch(); input(searchInput(), '审批与放行');
    await click(getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'button', { name: /审批与放行/ }));
    expect(new URLSearchParams(location.search).get('view')).toBe('approvals');
    await waitFor(() => expect(host!.textContent).toContain('没有待你审批的事项'));
    act(() => root!.unmount()); host!.remove(); root = undefined; host = undefined;
    await mount(); await waitFor(() => expect(host!.textContent).toContain('没有待你审批的事项'));
    expect(host!.querySelector('h1')?.textContent).toContain('审批与放行'); expect(host!.textContent).not.toContain('没有查看权限');
  });
  it('opens the notification center outside the menu from global search and restores it from a direct link', async () => {
    await signIn(); await mount(); await waitFor(() => expect(probes.home).toHaveBeenCalled());
    await openSearch(); input(searchInput(), '通知中心');
    await click(getByRole(getByRole(host!, 'dialog', { name: '搜索' }), 'button', { name: /通知中心/ }));
    expect(new URLSearchParams(location.search).get('view')).toBe('notifications');
    await waitFor(() => expect(host!.querySelector('h1')?.textContent).toContain('通知中心'));
    act(() => root!.unmount()); host!.remove(); root = undefined; host = undefined;
    await mount(); await waitFor(() => expect(host!.querySelector('h1')?.textContent).toContain('通知中心'));
    expect(host!.textContent).not.toContain('没有查看权限'); expect(host!.textContent).toContain('通知订阅');
  });
  it('keeps the supplier search while opening its exact record', async () => {
    await signIn('staff-a',['suppliers:read']);
    const state=currentContext().state!;
    state.market.suppliers=[
      {id:'supplier-a',code:'SA',name:'甲工厂',type:'成衣加工',country:'中国',address:'',capabilities:'',capacity:0,capacityUnit:'件',leadDays:0,status:'active',blockReason:'',contacts:[],fileIds:[],note:'',createdAt:'2026-10-13',updatedAt:'2026-10-13'},
      {id:'supplier-b',code:'SB',name:'乙工厂',type:'成衣加工',country:'中国',address:'',capabilities:'',capacity:0,capacityUnit:'件',leadDays:0,status:'active',blockReason:'',contacts:[],fileIds:[],note:'',createdAt:'2026-10-13',updatedAt:'2026-10-13'},
    ];
    history.replaceState({},'', '/?intro=0&view=suppliers&theme=light');
    await mount();await waitFor(()=>expect(host!.querySelector('[aria-label="供应商列表"]')).not.toBeNull());
    const query=host!.querySelector<HTMLInputElement>('input[placeholder^="搜索名称"]')!;input(query,'乙工厂');
    await waitFor(()=>expect([...host!.querySelectorAll<HTMLElement>('[role="row"][tabindex]')].some(item=>item.textContent?.includes('甲工厂'))).toBe(false));
    const row=[...host!.querySelectorAll<HTMLElement>('[role="row"][tabindex]')].find(item=>item.textContent?.includes('乙工厂'))!;await click(row);
    expect(new URLSearchParams(location.search).get('id')).toBe('supplier-b');
    await waitFor(()=>expect(host!.querySelector('[data-supplier-detail="supplier-b"]')).not.toBeNull());
    expect(host!.querySelector<HTMLInputElement>('input[placeholder^="搜索名称"]')!.value).toBe('乙工厂');
  });

  it('returns to the workbench after switching through an empty loading state to another workspace', async()=>{
    await signIn();await mount();await waitFor(()=>expect(probes.home).toHaveBeenCalled());
    await click(getByRole(host!,'button',{name:'打开准确版本'}));expect(currentRoute().view).toBe('development/detail');
    const ctx=currentContext();const next=fixture('next-workspace');
    await act(async()=>{ctx.workspace=null;ctx.state=null;ctx.loading=true;publish();});
    await act(async()=>{ctx.workspace={id:'next-workspace',ownerId:'staff-a',name:'Next workspace',revision:0,state:next};ctx.state=next;ctx.loading=false;publish();});
    await waitFor(()=>expect(new URLSearchParams(location.search).get('view')).toBe('cockpit'));
    expect(queryByRole(host!,'region',{name:'准确对象测试接缝'})).toBeNull();
  });

});

it('shows the signed-in member identity instead of the shared workspace owner nickname',async()=>{
  await signIn('finance-member');
  const shared=currentContext('finance-member');
  shared.workspace!.ownerId='another-owner';
  shared.state!.settings.profileName='空间所有者昵称';
  await mount();await waitFor(()=>expect(probes.home).toHaveBeenCalled());
  expect(queryByRole(host!,'button',{name:/空间所有者昵称/})).toBeNull();
  expect(getByRole(host!,'button',{name:/finance-member.*业务员/})).toBeTruthy();
});

it('keeps the owner custom workspace nickname on the owner account',async()=>{
  await signIn('owner-member');
  currentContext('owner-member').state!.settings.profileName='本人的显示名';
  await mount();await waitFor(()=>expect(probes.home).toHaveBeenCalled());
  expect(getByRole(host!,'button',{name:/本人的显示名.*业务员/})).toBeTruthy();
});
