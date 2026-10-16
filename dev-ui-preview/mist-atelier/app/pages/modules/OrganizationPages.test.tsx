// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Nav } from '../../nav';
import { AdminPanelPage, PLATFORM_PAGES } from './PlatformPages';

const bridge = vi.hoisted(() => ({ roles: ['owner'] as string[], perms: ['*'] as string[], localMode: false, changeMember: vi.fn(), members: [] as any[], calls: [] as Array<{ method: string; url: string; body: any }>, routes: {} as Record<string, (body: any) => any> }));
vi.mock('../../runtime/auth', () => ({ useMistSession: () => ({ user: { id: 'owner-1', displayName: '老板', roles: bridge.roles, roleLabels: [] }, sessionKey: 'k', localMode: bridge.localMode, hasRole: (...r: string[]) => r.some(x => bridge.roles.includes(x)), hasPermission: (p: string) => bridge.perms.includes('*') || bridge.perms.includes(p), canAccessView: () => true }) }));
vi.mock('../../runtime/workspace', () => ({ useMistWorkspace: () => ({ state: { members: bridge.members }, workspace: { id: 'w', name: '空间', ownerId: 'owner-1', access: { canManageMembers: bridge.roles.includes('owner') } }, changeMember: bridge.changeMember }) }));
vi.mock('../../../../../services/apiService', () => ({ apiService: { getAuthHeaders: () => ({ Authorization: 'Bearer t' }), getCompanyExporterProfile: vi.fn(async () => ({ value: { nameEn: 'X' }, version: 1 })), updateCompanyExporterProfile: vi.fn() } }));

const departments = [{ id: 'root', name: '公司', parentId: null }, { id: 'd1', name: '面料业务部', parentId: 'root', businessAttributes: ['fabric_business'] }];
const roles = [{ id: 'role-super-admin', name: '老板', description: null, isSystem: true, permissions: ['*'] }, { id: 'role-sales', name: '业务员', description: null, isSystem: true, permissions: ['order:read'] }];
let root: Root | undefined, host: HTMLDivElement; const go = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  bridge.roles = ['owner']; bridge.perms = ['*']; bridge.localMode = false; bridge.members = []; bridge.calls = []; bridge.changeMember.mockReset(); bridge.changeMember.mockResolvedValue(undefined); go.mockReset();
  bridge.routes = {
    'GET /api/admin/users': () => ({ ok: true, departments, users: [{ id: 'u1', displayName: '张三', email: 'z@x.test', status: 'pending', roles: [], roleIds: [], departmentId: null, department: null, lastLoginAt: null, createdAt: '2026-10-01T00:00:00Z' }] }),
    'GET /api/admin/roles': () => ({ ok: true, roles }),
    'POST /api/admin/users': () => ({ ok: true, userId: 'u2', reactivated: false }),
    'POST /api/admin/users/u1/approve': () => ({ ok: true }),
    'GET /api/hr/personnel': () => ({ ok: true, departments, positions: [], personnel: [{ id: 'u3', displayName: '李四', email: 'l@x.test', status: 'active', roles: ['业务员'], departmentId: 'd1', department: '面料业务部', lastLoginAt: null }] }),
    'GET /api/hr/teams': () => ({ ok: true, teams: [{ id: 't1', name: '面料一组', description: null, leaderId: null, departmentId: 'd1', department: '面料业务部', businessAttributes: ['fabric_business'], status: 'active', memberCount: 1, members: [{ id: 'm1', userId: 'u3', role: 'member', leftAt: null }] }] }),
    'POST /api/hr/departments': () => ({ ok: true, department: { id: 'd2' } }),
    'GET /api/hr/employees/u3': () => null,
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(init.body) : undefined;
    bridge.calls.push({ method, url, body });
    const handler = bridge.routes[`${method} ${url}`];
    const data = handler ? handler(body) : undefined;
    if (data === null || !handler) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'NOT_FOUND' }) };
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.unstubAllGlobals(); });
async function render(Page: React.FC, view: string, section?: string) {
  if (!root) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => root!.render(<Nav.Provider value={{ route: { view, section }, go, theme: 'light', toggleTheme: vi.fn(), openPalette: vi.fn(), openAI: vi.fn() } as any}><Page /></Nav.Provider>));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
async function click(text: string) { const b = button(text); expect(b, text).toBeTruthy(); await act(async () => b!.click()); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function type(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = control.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value); control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
}
const labelled = (label: string) => [...document.querySelectorAll('label.mist-field')].find(l => l.querySelector('.mist-field-label')?.textContent?.replace('*', '').trim() === label)?.querySelector('input,select') as HTMLInputElement | HTMLSelectElement;

describe('管理后台 · 账号', () => {
  it('lists accounts, flags pending registrations and approves with department, roles and workspace access', async () => {
    await render(AdminPanelPage, 'admin-panel');
    expect(document.body.textContent).toContain('1 个注册申请待审批');
    await act(async () => (document.querySelector('[role="row"][tabindex]') as HTMLElement).click());
    await click('审批通过');
    await type(labelled('任职部门'), 'd1');
    const sales = [...document.querySelectorAll('label.mist-check')].find(l => l.textContent?.includes('业务员'))!.querySelector('input')!;
    await act(async () => sales.click());
    await click('通过审批');
    expect(bridge.calls.find(c => c.url === '/api/admin/users/u1/approve')?.body).toEqual({ roles: ['role-sales'], departmentId: 'd1' });
    expect(bridge.changeMember).toHaveBeenCalledWith('add', 'u1');
  });
  it('locks the 老板 role for administrators who are not the owner and offers no workspace grant', async () => {
    bridge.roles = ['admin'];
    await render(AdminPanelPage, 'admin-panel');
    await click('新建账号');
    const boss = [...document.querySelectorAll('label.mist-check')].find(l => l.textContent?.includes('老板'))!.querySelector('input')!;
    expect(boss.disabled).toBe(true);
    expect(document.body.textContent).toContain('你不是「空间」的所有者');
    expect(button('AI 模型订阅')).toBeUndefined();
  });
  it('shows only the exporter profile to non-managers', async () => {
    bridge.roles = []; bridge.perms = [];
    await render(AdminPanelPage, 'admin-panel', 'accounts');
    expect(document.body.textContent).toContain('账号管理仅限老板与管理员');
    expect(bridge.calls.some(c => c.url.startsWith('/api/admin/users'))).toBe(false);
  });
});

describe('人事管理', () => {
  it('shows departments with business attributes and creates a department under the company root', async () => {
    await render(PLATFORM_PAGES.hr, 'hr');
    expect(document.body.textContent).toContain('面料业务部');
    expect(document.body.textContent).toContain('面料业务');
    await click('新建部门');
    await type(labelled('部门名称'), '成衣业务部');
    const garment = [...document.querySelectorAll('label.mist-check')].find(l => l.textContent?.trim() === '成衣业务')!.querySelector('input')!;
    await act(async () => garment.click());
    await click('保存');
    expect(bridge.calls.find(c => c.method === 'POST' && c.url === '/api/hr/departments')?.body).toEqual({ name: '成衣业务部', parentId: 'root', businessAttributes: ['garment_business'] });
  });
  it('lists people with their team and offers to create a missing employee profile', async () => {
    await render(PLATFORM_PAGES.hr, 'hr', 'people');
    expect(document.body.textContent).toContain('李四');
    expect(document.body.textContent).toContain('面料一组');
    await act(async () => (document.querySelector('[role="row"][tabindex]') as HTMLElement).click());
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(document.body.textContent).toContain('尚未建立员工档案');
    await click('建立员工档案');
    await click('保存');
    expect(document.body.textContent).toContain('建档须填写入职日期');
  });
  it('explains that local workspaces have no company organization and calls nothing', async () => {
    bridge.localMode = true;
    await render(PLATFORM_PAGES.hr, 'hr');
    expect(document.body.textContent).toContain('本地工作区没有公司组织架构');
    expect(bridge.calls).toHaveLength(0);
  });
  it('is read-only without hr:write', async () => {
    bridge.perms = ['hr:read'];
    await render(PLATFORM_PAGES.hr, 'hr');
    expect(button('新建部门')).toBeUndefined();
  });
});
