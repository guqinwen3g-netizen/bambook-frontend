/**
 * AUTH-A repair regressions. HTTP cases use actual auth routes, password/JWT
 * code and an explicit storage substitute. They do not connect to PG or prove
 * account-status-cache timing, HR API access, Agent execution or complete UAT.
 * Existing scopeRevocationRewash legacy-empty matchers remain unchanged.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { createAuthRouter } from '../route';
import { createAuthService, type TokenPayload } from '../service';
import { createPermissionService, hasScope } from '../permissionService';
import { buildAuthTokenPayload, buildLoadedAuthTokenPayload } from '../tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../authorizationSnapshotGuard';
import { createCurrentWriteActor } from '../currentWriteActor';
import { createModuleAuthGuard } from '../moduleGuard';
import { requirePermission } from '../permissionGuard';

const password = 'SyntheticAuthAuthorizationPassword!';
type Grant = { scope: string; isActive: boolean; deletedAt: Date | null; expiresAt: Date | null };

function database(roleId = 'role-sales', scopes: string[] = ['orders:read'], grants: Grant[] = []) {
  const user = {
    id: 'effective-auth-user', displayName: 'Effective auth user', email: 'effective-auth@example.invalid',
    passwordHash: bcrypt.hashSync(password, 4), status: 'active' as string | undefined,
    deletedAt: null as bigint | null, primaryDeptId: null, primaryDepartment: null,
    roles: [{ roleId, departmentId: null, role: { id: roleId, name: roleId === 'role-sales' ? 'sales' : 'Custom role',
      isSystem: roleId === 'role-sales', permissions: scopes.map(scope => ({ permission: { scope } })) } }],
  };
  const prisma: any = {
    userAccount: {
      findFirst: vi.fn(async () => user),
      findUnique: vi.fn(async (query: any) => {
        // Simulate Prisma's relation filter so the former isSystem-only query
        // would actually omit a configured custom role and fail this probe.
        const systemOnly = query.select?.roles?.where?.role?.isSystem === true;
        return systemOnly ? { ...user, roles: user.roles.filter(row => row.role.isSystem) } : user;
      }),
      update: vi.fn(async ({ data }: any) => ({ ...user, ...data })),
    },
    department: { findMany: vi.fn(async () => []) },
    userPermissionOverrides: { findMany: vi.fn(async ({ where }: any) => grants
      .filter(grant => grant.isActive === where.isActive && grant.deletedAt === where.deletedAt)
      .filter(grant => grant.expiresAt === null || grant.expiresAt > where.OR[1].expiresAt.gt)
      .map(grant => ({ scope: grant.scope }))) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return { user, prisma, grants };
}

function host(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', createAuthRouter({ prisma, requireEmailVerification: false, loginRateLimit: false,
    email: { isReal: false, describe: () => 'No-delivery auth test substitute', send: vi.fn(async () => undefined) } }));
  return app;
}

function priorToken() {
  return createAuthService().signToken({ userId: 'effective-auth-user', displayName: 'Stale owner claim',
    roles: ['owner'], roleIds: ['role-super-admin'], permissions: ['orders:write', 'sensitive:salary'],
    departmentIds: ['stale-department'] });
}

function renewedPayload(response: { headers: Record<string, unknown> }): TokenPayload {
  const headers = response.headers['set-cookie'];
  const cookies = Array.isArray(headers) ? headers.map(String) : [String(headers ?? '')];
  const cookie = cookies.map(value => value.split(';')[0]).find(value => value.startsWith('bambook_token='));
  expect(cookie, 'successful refresh must issue the actual session cookie').toBeDefined();
  return createAuthService().verifyToken(decodeURIComponent(cookie!.slice('bambook_token='.length)));
}

describe.each(['snapshot', 'write'] as const)('%s current-authorization error boundary (actual JWT/loader, substituted storage)', kind => {
  function guardedHost(fixture: ReturnType<typeof database>) {
    const app = express(); app.use(express.json());
    const downstream = vi.fn();
    app.use(kind === 'snapshot' ? createAuthorizationSnapshotGuard({ prisma: fixture.prisma }) : createCurrentWriteActor(fixture.prisma));
    app.post('/guarded', (req, res) => { downstream(); res.json({ actor: (req as any).actor }); });
    return { app, downstream };
  }
  it('current valid DB authorization still proceeds with the loaded actor', async () => {
    const fixture = database(), guarded = guardedHost(fixture);
    const response = await request(guarded.app).post('/guarded').set('Authorization', `Bearer ${priorToken()}`);
    expect(response.status).toBe(200); expect(guarded.downstream).toHaveBeenCalledTimes(1);
    expect(response.body.actor).toMatchObject({ userId: fixture.user.id, permissions: ['orders:read'], authorizationLoaded: true });
  });
  it.each(['account', 'grants'] as const)('%s dependency failure preserves 503/public copy without downstream execution or stale authority', async source => {
    const fixture = database(), guarded = guardedHost(fixture);
    const operation = source === 'account' ? fixture.prisma.userAccount.findFirst : fixture.prisma.userPermissionOverrides.findMany;
    operation.mockRejectedValue(Object.assign(new Error('不存在 SQL SELECT "private_authorization" /private/path'), { code: 'P2022' }));
    const response = await request(guarded.app).post('/guarded').set('Authorization', `Bearer ${priorToken()}`)
      .send({ actor: { roles: ['owner'], permissions: ['*'] } });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_UNAVAILABLE',
      message: kind === 'snapshot' ? '暂时无法核验权限，请稍后重试。' : '暂时无法核验写入权限，请稍后重试。' });
    expect(response.body.actor).toBeUndefined(); expect(guarded.downstream).not.toHaveBeenCalled();
  });
});

describe('current effective authorization: pure snapshot and sensitive-field decisions', () => {
  const actor = (permissions: string[], loaded?: true): TokenPayload => ({ userId: 'scope-user', roles: ['finance'],
    permissions, departmentIds: [], ...(loaded ? { authorizationLoaded: loaded } : {}) });

  it('legacy empty/missing snapshots still retain their compatibility grants', () => {
    expect(hasScope(actor([]), 'finance:read')).toBe(true);
    expect(hasScope({ ...actor([]), permissions: undefined as never }, 'finance:read')).toBe(true);
  });

  it('loaded empty snapshot and a nonempty snapshot lacking the scope both deny role-default authority', () => {
    expect(hasScope(actor([], true), 'finance:read')).toBe(false);
    expect(hasScope(actor(['orders:read']), 'finance:read')).toBe(false);
    expect(hasScope(actor(['finance:read'], true), 'finance:read')).toBe(true);
  });

  it('sensitive field masks obey the same explicit grant/revocation boundary', () => {
    const service = createPermissionService({ prisma: {} as never });
    const record = { purchasePrice: 12.5, salary: 8000, label: 'Synthetic source record' };
    const map = { purchasePrice: 'cost', salary: 'salary' } as const;
    expect(service.canViewSensitiveField(actor([]), 'cost'), 'legacy matrix compatibility control').toBe(true);
    expect(service.stripSensitive(record, map, actor(['pricing:read']))).toEqual({
      purchasePrice: null, salary: null, label: record.label,
    });
    expect(service.stripSensitive(record, map, actor([], true))).toEqual({
      purchasePrice: null, salary: null, label: record.label,
    });
    expect(service.stripSensitive(record, map, actor(['sensitive:cost'], true))).toEqual({
      purchasePrice: 12.5, salary: null, label: record.label,
    });
    expect(record.purchasePrice).toBe(12.5);
  });

  it('limited owner credentials cannot bypass sensitive-field masks; uncapped owner remains authorized', () => {
    const service = createPermissionService({ prisma: {} as never });
    const record = { cost: 12.5, salary: 8000, label: 'Source' }, map = { cost: 'cost', salary: 'salary' } as const;
    const owner: TokenPayload = { ...actor([], true), roles: ['owner'], permissionCeiling: ['orders:read'] };
    expect(service.stripSensitive(record, map, owner)).toEqual({ cost: null, salary: null, label: 'Source' });
    expect(service.stripSensitive(record, map, { ...owner, permissionCeiling: ['orders:read', 'sensitive:cost'] })).toEqual({ cost: 12.5, salary: null, label: 'Source' });
    expect(service.stripSensitive(record, map, { ...owner, permissionCeiling: undefined })).toEqual(record);
    expect(service.stripSensitive(record, map, { ...owner, permissionCeiling: ['*'] })).toEqual(record);
    expect(record).toEqual({ cost: 12.5, salary: 8000, label: 'Source' });
  });

  it('technical SuperAdmin shortcut remains for a loaded empty snapshot', () => {
    expect(hasScope({ ...actor([], true), roles: ['owner'] }, 'orders:write')).toBe(true);
  });
});

describe('current effective authorization: credential ceiling through the actual HTTP composition', () => {
  function limitedHost(fixture: ReturnType<typeof database>, ceiling?: string[]) {
    const prior: TokenPayload = { userId: fixture.user.id, roles: ['owner'], roleIds: ['role-super-admin'],
      permissions: ['*'], departmentIds: [], authorizationLoaded: true,
      ...(ceiling === undefined ? {} : { permissionCeiling: ceiling }) };
    const key = 'synthetic-ceiling-key';
    const actors = new Map([[key, prior]]);
    const app = express(); app.use(express.json());
    app.use(createAuthorizationSnapshotGuard({ prisma: fixture.prisma, apiKeys: new Set([key]), apiKeyActors: actors }));
    app.use(createModuleAuthGuard({ requireAuth: true, apiKeys: new Set([key]), apiKeyActors: actors }));
    app.post('/read', requirePermission('orders:read'), (req, res) => {
      const current = (req as any).actor as TokenPayload;
      res.json({ costAllowed: hasScope(current, 'sensitive:cost'), ceiling: current.permissionCeiling,
        currentPermissions: current.permissions, roles: current.roles });
    });
    return { app, key, token: createAuthService().signToken(prior), prior };
  }

  it.each(['JWT', 'API key'])('%s current owner keeps the credential ceiling after grant refresh and downstream auth', async transport => {
    const fixture = database('role-super-admin', ['orders:read', 'sensitive:cost']);
    const source = limitedHost(fixture, ['orders:read']);
    const response = await request(source.app).post('/read')
      .set(transport === 'JWT' ? 'Authorization' : 'x-bambook-api-key', transport === 'JWT' ? `Bearer ${source.token}` : source.key)
      .send({ actor: { ...source.prior, permissionCeiling: ['*'] } });
    expect(response.status).toBe(200);
    expect(response.body.currentPermissions).toEqual(['orders:read', 'sensitive:cost']);
    expect(response.body.ceiling).toEqual(['orders:read']);
    expect(response.body.costAllowed).toBe(false);
    expect(source.prior.permissionCeiling).toEqual(['orders:read']);
  });

  it.each(['JWT', 'API key'])('%s explicit empty ceiling denies even a current owner', async transport => {
    const source = limitedHost(database('role-super-admin', ['orders:read']), []);
    const response = await request(source.app).post('/read')
      .set(transport === 'JWT' ? 'Authorization' : 'x-bambook-api-key', transport === 'JWT' ? `Bearer ${source.token}` : source.key);
    expect(response.status).toBe(403);
  });

  it.each(['JWT', 'API key'])('%s unlimited credential preserves existing current owner authority', async transport => {
    const source = limitedHost(database('role-super-admin', []));
    const response = await request(source.app).post('/read')
      .set(transport === 'JWT' ? 'Authorization' : 'x-bambook-api-key', transport === 'JWT' ? `Bearer ${source.token}` : source.key);
    expect(response.status).toBe(200); expect(response.body.costAllowed).toBe(true);
  });

  it('a permissive ceiling cannot restore a withdrawn current DB grant for a non-owner account', async () => {
    const source = limitedHost(database('role-custom-reader', []), ['*']);
    const response = await request(source.app).post('/read').set('Authorization', `Bearer ${source.token}`);
    expect(response.status).toBe(403);
  });
});

describe('current effective authorization: shared DB projection', () => {
  it('includes a configured custom role and effective personal grants without manufacturing legacy role authority', async () => {
    const fixture = database('role-custom-report-reader', ['orders:read'], [
      { scope: 'hr:salary:read', isActive: true, deletedAt: null, expiresAt: null },
      { scope: 'sensitive:salary', isActive: true, deletedAt: null, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);
    const context = await createPermissionService({ prisma: fixture.prisma }).getUserPermissionContext(fixture.user.id);
    expect(context).toMatchObject({ roleIds: ['role-custom-report-reader'], legacyRoleCodes: [],
      scopes: ['hr:salary:read', 'orders:read', 'sensitive:salary'], authorizationLoaded: true });
    const payload = await buildLoadedAuthTokenPayload(fixture.prisma, fixture.user);
    expect(payload.permissions).toEqual(context!.scopes);
    expect(payload.roles).toEqual([]);
    expect(payload.authorizationLoaded).toBe(true);
    expect(buildAuthTokenPayload(fixture.user).authorizationLoaded, 'pure compatibility projection cannot certify DB grant loading').toBeUndefined();
  });

  it.each(['pending', 'rejected', 'disabled', undefined])('non-active account (%s) cannot produce a loaded permission context', async status => {
    const fixture = database();
    fixture.user.status = status;
    expect(await createPermissionService({ prisma: fixture.prisma }).getUserPermissionContext(fixture.user.id)).toBeNull();
    expect(fixture.prisma.userPermissionOverrides.findMany).not.toHaveBeenCalled();
  });

  it('grant query failure cannot stamp authorizationLoaded or silently substitute role defaults', async () => {
    const fixture = database();
    fixture.prisma.userPermissionOverrides.findMany.mockRejectedValue(new Error('synthetic grant-read failure'));
    await expect(buildLoadedAuthTokenPayload(fixture.prisma, fixture.user)).rejects.toThrow('synthetic grant-read failure');
    await expect(createPermissionService({ prisma: fixture.prisma }).getUserPermissionContext(fixture.user.id)).rejects.toThrow('synthetic grant-read failure');
  });

  it.each(['admin', 'owner'])('custom Role.name=%s preserves explicit scopes without manufacturing a leader role', async name => {
    const fixture = database(`role-custom-named-${name}`, ['orders:read']);
    fixture.user.roles[0].role.name = name;
    const payload = await buildLoadedAuthTokenPayload(fixture.prisma, fixture.user);
    expect(payload.permissions).toEqual(['orders:read']);
    expect(payload.authorizationLoaded).toBe(true);
    expect(payload.roles).not.toContain('admin');
    expect(payload.roles).not.toContain('owner');
    expect(payload.roles).toEqual([]);
    const context = await createPermissionService({ prisma: fixture.prisma }).getUserPermissionContext(fixture.user.id);
    expect(context!.legacyRoleCodes).toEqual([]);
  });

  it('a genuine legacy Role.id remains compatible independently of its arbitrary name', async () => {
    const fixture = database('finance', ['finance:read']);
    fixture.user.roles[0].role.name = 'Renamed historical finance role';
    const payload = await buildLoadedAuthTokenPayload(fixture.prisma, fixture.user);
    expect(payload.roles).toEqual(['finance']);
    expect(payload.permissions).toEqual(['finance:read']);
  });
});

describe('current effective authorization: actual login/me/refresh HTTP with storage substitute', () => {
  it('login and /me expose the same effective custom-role and personal dual-scope authorization', async () => {
    const fixture = database('role-custom-report-reader', ['orders:read'], [
      { scope: 'hr:salary:read', isActive: true, deletedAt: null, expiresAt: null },
      { scope: 'sensitive:salary', isActive: true, deletedAt: null, expiresAt: null },
    ]);
    const app = host(fixture.prisma);
    const login = await request(app).post('/auth/login').send({ email: fixture.user.email, password });
    expect(login.status).toBe(200);
    const payload = createAuthService().verifyToken(login.body.token);
    expect(payload).toMatchObject({ permissions: ['hr:salary:read', 'orders:read', 'sensitive:salary'], authorizationLoaded: true });
    expect(login.body.user.permissions).toEqual(payload.permissions);
    expect(login.body.user.authorizationLoaded).toBe(true);
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.permissions).toEqual(payload.permissions);
    expect(me.body.user.authorizationLoaded).toBe(true);
  });

  it('refresh replaces revoked role/expired, inactive and deleted grants with an authoritative empty current snapshot', async () => {
    const fixture = database('role-sales', [], [
      { scope: 'hr:salary:read', isActive: true, deletedAt: null, expiresAt: new Date(Date.now() - 3_600_000) },
      { scope: 'sensitive:salary', isActive: false, deletedAt: null, expiresAt: null },
      { scope: 'orders:write', isActive: true, deletedAt: new Date(), expiresAt: null },
    ]);
    const response = await request(host(fixture.prisma)).post('/auth/refresh').set('Cookie', `bambook_token=${priorToken()}`);
    expect(response.status).toBe(200);
    const payload = renewedPayload(response);
    expect(payload).toMatchObject({ roles: ['sales'], roleIds: ['role-sales'], permissions: [],
      departmentIds: ['company'], authorizationLoaded: true });
    expect(response.body.user.permissions).toEqual([]);
    expect(hasScope(payload, 'orders:read'), 'last permission revocation must not be restored from the sales default matrix').toBe(false);
    expect(hasScope(payload, 'orders:write')).toBe(false);
  });

  it('refresh admits new effective personal grants and honors the same explicit Bearer principal as other auth routes', async () => {
    const fixture = database('role-sales', ['orders:read'], [
      { scope: 'hr:salary:read', isActive: true, deletedAt: null, expiresAt: null },
      { scope: 'sensitive:salary', isActive: true, deletedAt: null, expiresAt: null },
    ]);
    const response = await request(host(fixture.prisma)).post('/auth/refresh')
      .set('Authorization', `Bearer ${priorToken()}`).set('Cookie', 'bambook_token=invalid-passive-cookie');
    expect(response.status).toBe(200);
    expect(renewedPayload(response)).toMatchObject({ roles: ['sales'],
      permissions: ['hr:salary:read', 'orders:read', 'sensitive:salary'], authorizationLoaded: true });
  });

  it.each(['pending', 'disabled', 'deleted'] as const)('refresh cannot renew a %s account into a new authorized session', async state => {
    const fixture = database();
    if (state === 'deleted') fixture.user.deletedAt = BigInt(Date.now());
    else fixture.user.status = state;
    const response = await request(host(fixture.prisma)).post('/auth/refresh').set('Cookie', `bambook_token=${priorToken()}`);
    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(fixture.prisma.userPermissionOverrides.findMany).not.toHaveBeenCalled();
    const header: unknown = response.headers['set-cookie'];
    const cookies = Array.isArray(header) ? header.map(String) : typeof header === 'string' ? [header] : [];
    expect(cookies.some(cookie => cookie.startsWith('bambook_token=;'))).toBe(true);
  });

  it('login rejects an unreadable current grant set without returning or issuing a session token', async () => {
    const fixture = database();
    fixture.prisma.userPermissionOverrides.findMany.mockRejectedValue(new Error('synthetic grant-read failure'));
    const response = await request(host(fixture.prisma)).post('/auth/login').send({ email: fixture.user.email, password });
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('AUTHORIZATION_LOAD_FAILED');
    expect(response.body.token).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
