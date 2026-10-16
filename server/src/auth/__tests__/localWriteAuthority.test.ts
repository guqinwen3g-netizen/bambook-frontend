/** Real Express/JWT/current authorization loaders and business services. Prisma
 * delegates and external quote fetching are substituted; this is not PostgreSQL
 * persistence, the full composition root, or a company-role UAT. */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../market/autoQuoteSources', () => ({ runAutoQuoteSync: vi.fn(async () => ({ ok: 0, failed: 0, items: [] })) }));
// Each synthetic app has its own storage adapter. Keep actual service validation,
// encoding and history behavior instead of sharing its production process cache.
vi.mock('../../config/systemConfigService', async importOriginal => {
  const actual: any = await importOriginal();
  return { ...actual, getSystemConfigService: (prisma: any) => actual.createSystemConfigService(prisma) };
});
import { createAuthService } from '../service';
import { createSystemConfigRouter } from '../../config/systemConfigRoute';
import { createMarketQuoteRouter } from '../../market/marketQuoteRoute';
import { createMesRouter } from '../../mes/mesRoute';
import { runAutoQuoteSync } from '../../market/autoQuoteSources';

const auth = createAuthService();
const userId = 'u_local_write_probe';
function token(extra: any = {}) {
  return auth.signToken({ userId, roles: ['owner'], permissions: ['dictionary:write', 'production:write'], authorizationLoaded: true, departmentIds: [], ...extra });
}
function currentUser(scopes = ['dictionary:write', 'production:write'], roleId = 'role-admin') {
  return { id: userId, displayName: 'Synthetic current user', status: 'active', deletedAt: null, primaryDeptId: 'test-dept', primaryDepartment: null,
    roles: [{ roleId, role: { name: 'Fixture role', permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
}
const actions = [
  { name: 'company bank/profile configuration', method: 'put', path: '/config/company.exporterProfile', body: { value: { nameEn: 'SYNTHETIC TEST CO' } }, status: 200 },
  { name: 'manual market configuration', method: 'put', path: '/market/quotes/manual/wool', body: { price: 97500, note: 'Synthetic test quote' }, status: 200 },
  { name: 'explicit market refresh command', method: 'post', path: '/market/quotes/refresh', body: {}, status: 200 },
  { name: 'MES workstation creation', method: 'post', path: '/mes/work-stations', body: { code: 'TEST-WS', name: 'Synthetic workstation', type: 'Sewing' }, status: 201 },
] as const;
function fixture(requireAuth = false) {
  let current: any = currentUser();
  const prisma: any = {
    userAccount: { findFirst: vi.fn(async () => current) }, userPermissionOverrides: { findMany: vi.fn(async () => []) },
    systemConfig: { findUnique: vi.fn(async () => null), upsert: vi.fn(async ({ create }: any) => ({ ...create, version: 1, updatedAt: BigInt(1) })) },
    systemConfigHistory: { create: vi.fn(async ({ data }: any) => ({ id: 'H1', ...data })) },
    workStation: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const onDataChange = vi.fn(), app = express(); app.use(express.json());
  app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/config', createSystemConfigRouter({ prisma, requireAuth }));
  app.use('/market', createMarketQuoteRouter({ prisma, requireAuth }));
  app.use('/mes', createMesRouter({ prisma, requireAuth, apiKeys: new Set(['synthetic-api-key']), onDataChange }));
  vi.mocked(runAutoQuoteSync).mockClear();
  return { app, prisma, onDataChange, setUser: (value: any) => { current = value; } };
}
const send = (f: ReturnType<typeof fixture>, action: typeof actions[number], bearer?: string) => {
  const pending = (request(f.app) as any)[action.method](action.path); if (bearer) pending.set('Authorization', `Bearer ${bearer}`); return pending.send(action.body);
};
function noWrite(f: ReturnType<typeof fixture>) {
  expect(f.prisma.systemConfig.upsert).not.toHaveBeenCalled(); expect(f.prisma.systemConfigHistory.create).not.toHaveBeenCalled();
  expect(f.prisma.workStation.create).not.toHaveBeenCalled(); expect(f.prisma.auditLog.create).not.toHaveBeenCalled(); expect(f.onDataChange).not.toHaveBeenCalled();
  expect(runAutoQuoteSync).not.toHaveBeenCalled();
}
describe.each(actions)('$name strict current write authorization', action => {
  it.each([false, true])('anonymous write is denied even when requireAuth=%s; body identity is ignored', async configured => {
    const f = fixture(configured); const response = await (request(f.app) as any)[action.method](action.path).send({ ...action.body, actor: { userId, roles: ['owner'], permissions: ['*'] } });
    expect(response.status).toBe(401); expect(response.body.error).toBe('UNAUTHORIZED'); expect(f.prisma.userAccount.findFirst).not.toHaveBeenCalled(); noWrite(f);
  });
  it('an API key cannot supply write identity', async () => {
    const f = fixture(); const response = await (request(f.app) as any)[action.method](action.path).set('X-Bambook-API-Key', 'synthetic-api-key').send(action.body);
    expect(response.status).toBe(401); noWrite(f);
  });
  it.each(['absent', 'inactive', 'deleted'])('current %s account refuses a previously signed owner token', async state => {
    const f = fixture(); const user: any = currentUser(); if (state === 'inactive') user.status = 'inactive'; if (state === 'deleted') user.deletedAt = new Date(); f.setUser(state === 'absent' ? null : user);
    const response = await send(f, action, token()); expect(response.status).toBe(401); expect(response.body.error).toBe('ACCOUNT_DISABLED'); noWrite(f);
  });
  it.each(['account', 'overrides'])('a %s loading failure returns 503 without restoring stale/default grants', async failure => {
    const f = fixture(); (failure === 'account' ? f.prisma.userAccount.findFirst : f.prisma.userPermissionOverrides.findMany).mockRejectedValue(Error('synthetic SQL read fault'));
    const response = await send(f, action, token()); expect(response.status).toBe(503); expect(response.body.error).toBe('AUTHORIZATION_UNAVAILABLE'); noWrite(f);
  });
  it('current empty loaded scope refuses stale write permissions', async () => {
    const f = fixture(); f.setUser(currentUser([])); const response = await send(f, action, token()); expect(response.status).toBe(403); noWrite(f);
  });
  it('a signed read-only ceiling constrains current owner technical privilege', async () => {
    const f = fixture(); f.setUser(currentUser(['dictionary:write', 'production:write'], 'role-super-admin')); const response = await send(f, action, token({ permissionCeiling: ['settings:system:read', 'production:read'] })); expect(response.status).toBe(403); noWrite(f);
  });
  it('current loaded grants allow the legitimate command even when the token carried empty legacy scopes', async () => {
    const f = fixture(); const response = await send(f, action, token({ roles: [], permissions: [], authorizationLoaded: undefined })); expect(response.status).toBe(action.status);
    expect(f.prisma.userAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: userId, deletedAt: null } })); expect(f.prisma.userPermissionOverrides.findMany).toHaveBeenCalledTimes(1);
    if (action.path.startsWith('/mes')) { expect(f.prisma.workStation.create).toHaveBeenCalledTimes(1); expect(f.prisma.auditLog.create.mock.calls[0][0].data.actorId).toBe(userId); expect(f.onDataChange).toHaveBeenCalledTimes(1); }
    else if (action.path.endsWith('/refresh')) expect(runAutoQuoteSync).toHaveBeenCalledTimes(1);
    else { expect(f.prisma.systemConfig.upsert).toHaveBeenCalledTimes(1); expect(f.prisma.systemConfig.upsert.mock.calls[0][0].create.updatedBy).toBe(userId); }
  });
});
it('MES production grant belongs to the configured current user, independent of any built-in role mapping', async () => {
  const f = fixture(); f.setUser(currentUser(['production:write'], 'custom-test-production-role')); const response = await send(f, actions[3], token({ roles: [], permissions: [] })); expect(response.status).toBe(201); expect(f.prisma.auditLog.create.mock.calls[0][0].data.actorId).toBe(userId);
});
// Role gates moved to permission scopes: dictionary:write (held by ADMIN/SUPER_ADMIN in the
// matrix) is now the whole gate, so a custom role carrying it may configure company/market.
it.each(actions.slice(0, 3))('current dictionary:write grant on a custom role authorizes company/market configuration: $name', async action => {
  const f = fixture(); f.setUser(currentUser(['dictionary:write'], 'custom-test-settings-role')); const response = await send(f, action, token()); expect(response.status).toBe(action.status);
});
it.each(actions.slice(0, 3))('custom role without dictionary:write stays denied for company/market configuration: $name', async action => {
  const f = fixture(); f.setUser(currentUser(['production:write'], 'custom-test-settings-role')); const response = await send(f, action, token()); expect(response.status).toBe(403); noWrite(f);
});
it('MES anonymous pay-row read remains denied; write hardening does not grant salary visibility', async () => {
  const f = fixture(); const response = await request(f.app).get('/mes/piece-rate-records'); expect(response.status).toBe(403); noWrite(f);
});
