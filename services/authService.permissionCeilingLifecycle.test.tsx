// @vitest-environment jsdom
// Actual signed-ceiling contract; the original DTO-loss source is a recorded RED control.
// Actual Express/auth DTO, actual authService, actual QC component + React DOM.
// Only persistence and business API seams are synthetic; no auth/permission helper is mocked.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const serverRequire = createRequire(resolve(process.cwd(), 'server/package.json'));
const express = serverRequire('express');
const cookieParser = serverRequire('cookie-parser');
import http from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createAuthRouter } from '../server/src/auth/route';
import { createAuthService } from '../server/src/auth/service';
import { createAuthorizationSnapshotGuard } from '../server/src/auth/authorizationSnapshotGuard';
import { requirePermission } from '../server/src/auth/permissionGuard';
const native = vi.hoisted(() => ({
  workbench: vi.fn(), locations: vi.fn(), lines: vi.fn(), orders: vi.fn(), users: vi.fn(),
  create: vi.fn(), start: vi.fn(), cancel: vi.fn(), remove: vi.fn(),
}));
vi.mock('../services/apiService', () => ({ apiService: {
  getQcWorkbench: native.workbench, listQcLocations: native.locations, listBusinessLines: native.lines,
  listOrders: native.orders, listUserAccounts: native.users, createQcAssignment: native.create,
  startQcAssignment: native.start, cancelQcAssignment: native.cancel, deleteQcAssignment: native.remove,
  getStoredConfig: () => ({ cloudEndpoint: '' }), buildApiUrl: (path: string) => path, getAuthHeaders: () => ({}),
} }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const base = process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
const probeNonce = process.env.BAMBOOK_ACCEPTANCE_PROBE_NONCE!;
const signing = createAuthService();
const grants = ['qc:read', 'qc:write', 'orders:read', 'dictionary:write'];
const caps: Array<[string, string[] | undefined]> = [['empty', []], ['read-only', ['qc:read']], ['subset', ['qc:read', 'orders:read']], ['absent', undefined]];
const observations: unknown[] = [];
let passwordHash: string;
let server: http.Server;
let url: string;
let row: any;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let profileUpdates: any[];
function storage() {
  const exact = ({ where }: any) => {
    if (where?.id && where.id !== row.id) return null;
    if (where?.deletedAt === null && row.deletedAt !== null) return null;
    if (where?.OR && !where.OR.some((part: any) => part.email?.equals?.toLowerCase() === row.email.toLowerCase() || part.displayName?.equals?.toLowerCase() === row.displayName.toLowerCase())) return null;
    return structuredClone(row);
  };
  return {
    userAccount: { findUnique: async (q: any) => exact(q), findFirst: async (q: any) => exact(q),
      update: async ({ where, data }: any) => { if (where.id !== row.id) throw new Error('ROW_NOT_FOUND'); profileUpdates.push(structuredClone(data)); Object.assign(row, data); return structuredClone(row); } },
    userPermissionOverrides: { findMany: async ({ where }: any) => { if (where.userId !== row.id || where.isActive !== true || where.deletedAt !== null) throw new Error('unexpected override query'); return []; } },
    auditLog: { create: async ({ data }: any) => ({ ...data }) },
  };
}
function credential(cap?: string[]) {
  return signing.signToken({ userId: row.id, displayName: row.displayName, roles: ['viewer'], roleIds: ['role-qc'], permissions: [...grants], authorizationLoaded: true,
    departmentIds: ['company'], ...(cap !== undefined ? { permissionCeiling: cap } : {}) });
}
function cached(cap?: string[]) {
  return { id: row.id, displayName: row.displayName, email: row.email, roles: ['viewer'], roleIds: ['role-qc'], permissions: [...grants], departmentIds: ['company'], department: null,
    ...(cap !== undefined ? { permissionCeiling: cap } : {}) } as any;
}
async function realFetch(target: string, init: RequestInit = {}): Promise<Response> {
  const endpoint = new URL(target);
  if (endpoint.origin !== url) throw new Error('probe must use its own actual Express origin');
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method: init.method || 'GET', headers: { ...(init.headers as any), ...(init.body ? { 'Content-Length': Buffer.byteLength(String(init.body)) } : {}) } }, res => {
      const parts: Buffer[] = []; res.on('data', chunk => parts.push(Buffer.from(chunk))); res.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8'); observations.push({ kind: 'http', method: init.method || 'GET', path: endpoint.pathname, status: res.statusCode, body: JSON.parse(body || '{}') });
        resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, status: res.statusCode, headers: { get: (key: string) => { const value = res.headers[key.toLowerCase()]; return Array.isArray(value) ? value.join('; ') : value || null; } }, text: async () => body, json: async () => JSON.parse(body) } as Response);
      });
    }); req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (init.body) req.write(String(init.body)); req.end();
  });
}
async function read(path: string, token: string, method = 'GET', body?: unknown, cookie?: string) {
  const res = await realFetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
function buttonCount(text: string) { return [...host!.querySelectorAll('button')].filter(node => node.textContent?.trim() === text).length; }
async function frontend(cap?: string[]) {
  const auth = await import('../services/authService');
  await auth.devLoginAs(credential(cap), cached(cap));
  const { default: QcWorkbench } = await import('../components/QcWorkbenchManager');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<QcWorkbench />));
  expect(buttonCount('新建任务')).toBe(cap === undefined ? 1 : 0);
  expect(auth.hasPermission('qc:write')).toBe(cap === undefined);
  return auth;
}
beforeAll(async () => { passwordHash = await signing.hashPassword('private-synthetic-password'); });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); sessionStorage.clear();
  row = { id: 'audit-qc', displayName: 'Actual Synthetic QC', email: 'audit-qc@acceptance.invalid', passwordHash, status: 'active', deletedAt: null, primaryDeptId: 'company', primaryDepartment: { name: 'Company' },
    roles: [{ roleId: 'role-qc', departmentId: 'company', role: { name: 'Quality', permissions: grants.map(scope => ({ permission: { scope } })) } }] };
  profileUpdates = [];
  const prisma = storage(); const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: prisma as any }));
  app.use('/api/auth', createAuthRouter({ prisma: prisma as any, loginRateLimit: false, requireEmailVerification: false }));
  // Actual middleware-only probes, synthetic terminal read/write endpoints. No business mutation claim.
  app.get('/api/probe/read', requirePermission('qc:read'), (_req, res) => res.json({ ok: true }));
  app.post('/api/probe/write', requirePermission('qc:write'), (_req, res) => res.json({ ok: true }));
  server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  localStorage.setItem('panda_system_config', JSON.stringify({ cloudEndpoint: url })); vi.stubEnv('DEV', true); vi.stubGlobal('fetch', realFetch);
  native.workbench.mockResolvedValue({ assigned: [], inProgress: [], completed: [] });
  for (const fn of [native.locations, native.lines, native.orders, native.users]) fn.mockResolvedValue([]);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); host = undefined; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => { if (!process.env.BAMBOOK_ACCEPTANCE_PROBE_OUT) return; const marker = JSON.parse(readFileSync(`${base}/marker.json`, 'utf8')); if (marker.nonce !== probeNonce || marker.frozen !== false) throw new Error('private marker invalid'); writeFileSync(`${process.env.BAMBOOK_ACCEPTANCE_PROBE_OUT}/lifecycle-observations.json`, JSON.stringify(observations, null, 2)); });

for (const [label, cap] of caps) it(`actual refresh -> me -> profile -> QC DOM preserves ${label} ceiling`, async () => {
  const auth = await frontend(cap);
  const refreshed = await realFetch(`${url}/api/auth/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${credential(cap)}` } });
  expect(refreshed.status).toBe(200);
  const dto = await refreshed.json(); expect(dto.user.permissionCeiling).toEqual(cap);
  const cookie = refreshed.headers.get('set-cookie')!;
  const matched = /(?:^|;\s*)bambook_token=([^;]+)/.exec(cookie); expect(matched).not.toBeNull();
  const token = decodeURIComponent(matched![1]); expect(signing.verifyToken(token).permissionCeiling).toEqual(cap);
  // Browser credential storage seam only: consume the token actually issued by Express.
  localStorage.setItem('bambook_auth_token', token); sessionStorage.setItem('bambook_auth_token', token);
  await act(async () => { await auth.checkAuth(); });
  expect(auth.getAuthState().user?.permissionCeiling).toEqual(cap); expect(buttonCount('新建任务')).toBe(cap === undefined ? 1 : 0);
  await act(async () => { await auth.updateMyProfile({ displayName: 'Actual Lifecycle QC' }); });
  expect(auth.getAuthState().user?.permissionCeiling).toEqual(cap); expect(buttonCount('新建任务')).toBe(cap === undefined ? 1 : 0);
  expect(JSON.parse(localStorage.getItem('bambook_auth_user')!).permissionCeiling).toEqual(cap);
  expect((await read('/api/probe/read', token)).status).toBe(cap === undefined || cap.includes('qc:read') ? 200 : 403);
  expect((await read('/api/probe/write', token, 'POST')).status).toBe(cap === undefined || cap.includes('qc:write') ? 200 : 403);
});
it('profile body forged ceiling roles permissions and claimed user cannot expand signed read-only credential', async () => {
  const cap = ['qc:read']; const auth = await frontend(cap);
  await act(async () => { await auth.updateMyProfile({ displayName: 'Changed', permissionCeiling: ['*'], permissions: ['*'], roles: ['owner'], userId: 'another-account' } as any); });
  expect(profileUpdates).toEqual([{ displayName: 'Changed' }]); expect(auth.getAuthState().user?.id).toBe(row.id);
  expect(auth.getAuthState().user?.permissionCeiling).toEqual(cap); expect(auth.getAuthState().user?.permissions).toEqual([...grants].sort());
  expect(buttonCount('新建任务')).toBe(0); expect((await read('/api/probe/write', credential(cap), 'POST')).status).toBe(403);
});
it('current grant withdrawal remains denied even when signed ceiling would permit QC write', async () => {
  const cap = ['qc:read', 'qc:write']; const original = credential(cap);
  row.roles[0].role.permissions = [{ permission: { scope: 'qc:read' } }];
  const auth = await import('./authService'); localStorage.setItem('bambook_auth_token', original); sessionStorage.setItem('bambook_auth_token', original);
  await auth.checkAuth(); expect(auth.getAuthState().user?.permissions).toEqual(['qc:read']); expect(auth.getAuthState().user?.permissionCeiling).toEqual(cap);
  const { default: QcWorkbench } = await import('../components/QcWorkbenchManager'); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<QcWorkbench />)); expect(buttonCount('新建任务')).toBe(0); expect(auth.hasPermission('qc:write')).toBe(false);
  await act(async () => { await auth.updateMyProfile({ displayName: 'Current Read Only' }); });
  expect(auth.getAuthState().user?.permissions).toEqual(['qc:read']); expect(auth.getAuthState().user?.permissionCeiling).toEqual(cap); expect(buttonCount('新建任务')).toBe(0);
  expect((await read('/api/probe/write', original, 'POST')).status).toBe(403);
});
it('serializer copies a provided trusted ceiling and preserves absence versus empty', async () => {
  const { serializeAuthUser } = await import('../server/src/auth/tokenHelpers'); const cap = ['qc:read'];
  const dto = serializeAuthUser(row, ['viewer'], grants, ['company'], { permissionCeiling: cap }); cap.push('qc:write'); expect(dto.permissionCeiling).toEqual(['qc:read']);
  expect(serializeAuthUser(row, ['viewer'], grants, ['company'], { permissionCeiling: [] }).permissionCeiling).toEqual([]);
  expect(Object.hasOwn(serializeAuthUser(row, ['viewer'], grants, ['company']), 'permissionCeiling')).toBe(false);
});
