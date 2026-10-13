/** Actual current accounts, seven stored canonical roles, native L2 and signed
 * HTTP login/refresh/read/write against an independently verified private PG.
 * Claims/body/role names are deliberately untrusted. Synthetic rows are inputs;
 * this does not prove company assignments, UI or the historical unmarked-JWT gate. */
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAuthRouter } from '../src/auth/route';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createPermissionService } from '../src/auth/permissionService';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createQcRouter } from '../src/qc/qcRoute';
import { buildOrderListScopeWhere } from '../src/orders/orderService';
import { DEFAULT_DATA_SCOPE_BY_ROLE, DEFAULT_ROLE_PERMISSION_MATRIX, SYSTEM_ROLE_IDS, resolveWriteKind } from '../src/_shared/rolePermissionMatrix';

const prefix = 'acceptance-qc-current-role-' + randomUUID();
let prisma: PrismaClient, serial = 0, passwordHash: string;
const queries: string[] = [], locations: string[] = [];
const db = () => { if (!prisma) throw Error('Private role PG is not initialized'); return prisma; };
const auth = createAuthService();
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, row) => typeof row === 'bigint' ? row.toString() : row);
async function grant(roleId: string, scope: string) {
  const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-permission-' + scope, scope } });
  await db().rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, update: {},
    create: { id: prefix + '-grant-' + roleId + '-' + scope, roleId, permissionId: permission.id } });
}
async function actor(userId: string): Promise<TokenPayload> {
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(userId);
  if (!current) throw Error('Synthetic account inactive');
  return { userId, roles: current.legacyRoleCodes, roleIds: current.roleIds, permissions: current.scopes,
    departmentIds: current.departmentIds, authorizationLoaded: true };
}
async function identity(roleId?: string, scopes = ['orders:read'], name = 'Synthetic custom limited role') {
  const id = prefix + '-' + ++serial + '-user';
  await db().userAccount.create({ data: { id, displayName: id, status: 'active', passwordHash } });
  const storedRole = roleId || id + '-custom-role';
  if (!roleId) {
    await db().role.create({ data: { id: storedRole, name, isSystem: false } });
    for (const scope of scopes) await grant(storedRole, scope);
  }
  await db().userRole.create({ data: { id: id + '-membership', userId: id, roleId: storedRole } });
  const current = await actor(id);
  return { id, roleId: storedRole, actor: current, token: auth.signToken(current) };
}
async function order(ownerId: string, customerRelationId?: string) {
  const id = prefix + '-' + ++serial + '-order';
  return db().order.create({ data: { id, ownerId, customer: 'Synthetic role handoff customer', product: 'Synthetic fabric',
    type: 'Fabric', quantity: 100, status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: '123.45', currency: 'USD',
    lines: { create: { id: id + '-line', lineNumber: 1, quantity: '100', unit: 'M' } },
    ...(customerRelationId ? { customerRelationId } : {}) } });
}
function app(database: PrismaClient = db(), configured?: TokenPayload) {
  const application = express(); application.use(express.json()); application.use(cookieParser());
  const keys = configured ? new Set([prefix + '-bound-key']) : new Set<string>();
  const bindings = configured ? new Map([[prefix + '-bound-key', configured]]) : new Map<string, TokenPayload>();
  application.use('/api', createAuthorizationSnapshotGuard({ prisma: database, apiKeys: keys, apiKeyActors: bindings }));
  application.use('/api/auth', createAuthRouter({ prisma: database, loginRateLimit: false }));
  application.use('/api/v1/orders', createOrdersRouter({ prisma: database, requireAuth: true, apiKeys: keys }));
  application.use('/api/v2/orders', createOrdersV2Router({ prisma: database, requireAuth: true, apiKeys: keys }));
  application.use('/api/v1/qc', createQcRouter({ prisma: database, requireAuth: true, apiKeys: keys }));
  return application;
}
const header = (token: string) => ({ Authorization: 'Bearer ' + token });
function code(response: any) { return typeof response.body.error === 'string' ? response.body.error : response.body.error?.code; }
async function qcFixture() {
  const user = await identity(SYSTEM_ROLE_IDS.QC), other = await identity(undefined, []);
  return { user, other, order: await order(other.id), app: app() };
}
async function login(f: Awaited<ReturnType<typeof qcFixture>>) {
  const response = await request(f.app).post('/api/auth/login').send({ identifier: f.user.id, password: 'synthetic-private-password' });
  expect(response.status, diagnostic(response.body)).toBe(200);
  const payload = auth.verifyToken(response.body.token);
  expect(payload.roleIds).toEqual([SYSTEM_ROLE_IDS.QC]); expect(payload.roles).toEqual(['viewer']);
  return response.body.token as string;
}
function credentialCeiling(payload: TokenPayload, permissionCeiling: string[]) {
  const { exp, iat, ...identity } = payload as TokenPayload & { exp?: number; iat?: number };
  return auth.signToken({ ...identity, permissionCeiling });
}
async function refresh(application: ReturnType<typeof app>, token: string, expected: string[] | undefined) {
  const response = await request(application).post('/api/auth/refresh').set(header(token)).send({ permissionCeiling: ['*'], roles: ['owner'] });
  expect(response.status, diagnostic(response.body)).toBe(200);
  const cookies = response.headers['set-cookie']; expect(Array.isArray(cookies)).toBe(true);
  const cookie = (cookies as unknown as string[]).find(value => value.startsWith('bambook_token=')); expect(cookie).toBeDefined();
  const next = decodeURIComponent(cookie!.split(';')[0].slice('bambook_token='.length));
  expect(auth.verifyToken(next).permissionCeiling).toEqual(expected);
  if (expected === undefined) expect(Object.prototype.hasOwnProperty.call(auth.verifyToken(next), 'permissionCeiling')).toBe(false);
  return next;
}
function dataReads() { return queries.filter(query => /\bSELECT\b/.test(query) && /"(?:Order|QCLocation|InspectionReport)"/.test(query)); }
async function state() { return { orders: await db().order.findMany({ where: { id: { startsWith: prefix } }, orderBy: { id: 'asc' } }),
  locations: await db().qCLocation.findMany({ where: { id: { in: locations } }, orderBy: { id: 'asc' } }) }; }
async function typedRejection(work: () => Promise<unknown>, expected: string, status: number) {
  queries.length = 0; await expect(work()).rejects.toMatchObject({ code: expected, statusCode: status });
  expect(dataReads(), 'authority failure cannot query business rows').toEqual([]);
}
async function cleanup() {
  await db().auditLog.deleteMany({ where: { actorId: { startsWith: prefix } } });
  await db().qCLocation.deleteMany({ where: { id: { in: locations } } });
  await db().order.deleteMany({ where: { id: { startsWith: prefix } } });
  await db().relation.deleteMany({ where: { id: { startsWith: prefix } } });
  await db().teamDataGrant.deleteMany({ where: { teamId: { startsWith: prefix } } });
  await db().team.deleteMany({ where: { id: { startsWith: prefix } } });
  await db().userPermissionOverrides.deleteMany({ where: { userId: { startsWith: prefix } } });
  await db().userRole.deleteMany({ where: { userId: { startsWith: prefix } } });
  await db().rolePermission.deleteMany({ where: { OR: [{ roleId: { startsWith: prefix } }, { id: { startsWith: prefix } }] } });
  await db().role.deleteMany({ where: { id: { startsWith: prefix } } });
  await db().userAccount.deleteMany({ where: { id: { startsWith: prefix } } });
  await db().permission.deleteMany({ where: { id: { startsWith: prefix }, roles: { none: {} } } });
}

describe.sequential('native current role data scope and credential ceiling', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_PORT);
    expect(url.pathname).toBe('/' + process.env.BAMBOOK_ACCEPTANCE_DB_NAME);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(process.env.BAMBOOK_ACCEPTANCE_SANDBOX).toBeTruthy();
    expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (prisma as PrismaClient<Prisma.PrismaClientOptions, 'query'>).$on('query', event => queries.push(event.query));
    expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
      .toEqual([{ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) }]);
    passwordHash = await auth.hashPassword('synthetic-private-password');
    for (const roleId of Object.values(SYSTEM_ROLE_IDS)) {
      await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: 'Synthetic actual ' + roleId, isSystem: true } });
      for (const [scope, allowed] of Object.entries(DEFAULT_ROLE_PERMISSION_MATRIX[roleId])) if (allowed) await grant(roleId, scope);
    }
  });
  afterAll(async () => { try { if (prisma) await cleanup(); } finally { await prisma?.$disconnect(); } });

  for (const roleId of Object.values(SYSTEM_ROLE_IDS)) {
    it('QCR canonical current ' + roleId + ' keeps its actual orders default scope', async () => {
      const user = await identity(roleId), result = await createPermissionService({ prisma: db() }).getDataScopeResolver(user.actor, 'orders');
      expect(result.rule).toEqual(DEFAULT_DATA_SCOPE_BY_ROLE[roleId]['*']);
      if (roleId === SYSTEM_ROLE_IDS.SALES) {
        const library = await createPermissionService({ prisma: db() }).getDataScopeResolver(user.actor, 'relations');
        expect(library.rule).toEqual({ kind: 'all', write: 'self' }); expect(resolveWriteKind(library.rule)).toBe('self');
      }
    });
  }
  for (const endpoint of ['v1-list', 'v1-detail', 'v2-list', 'v2-detail', 'context', 'inspection-scopes'] as const) {
    it('QCR actual QC login reaches foreign active parent via ' + endpoint, async () => {
      const f = await qcFixture(), token = await login(f);
      const path = endpoint === 'v1-list' ? '/api/v1/orders' : endpoint === 'v1-detail' ? '/api/v1/orders/' + f.order.id
        : endpoint === 'v2-list' ? '/api/v2/orders' : endpoint === 'v2-detail' ? '/api/v2/orders/' + f.order.id
        : endpoint === 'context' ? '/api/v1/orders/' + f.order.id + '/context' : '/api/v1/qc/orders/' + f.order.id + '/inspection-scopes';
      const response = await request(f.app).get(path).set(header(token)); expect(response.status, diagnostic(response.body)).toBe(200);
      if (endpoint === 'v1-list') expect(response.body.orders.map((row: any) => row.id)).toContain(f.order.id);
      else if (endpoint === 'v2-list') expect(response.body.items.map((row: any) => row.id)).toContain(f.order.id);
      else if (endpoint === 'v1-detail') expect(response.body.order.id).toBe(f.order.id);
      else if (endpoint === 'v2-detail') expect(response.body.order.id).toBe(f.order.id);
      else if (endpoint === 'context') { expect(response.body.found).toBe(true); expect(response.body.order.id).toBe(f.order.id); }
      else { expect(response.body.scopes).toHaveLength(1); expect(response.body.scopes[0].scopeKey).toBe('whole_order'); }
    });
  }
  it('QCR company-wide QC read grants cannot create or edit an Order', async () => {
    const f = await qcFixture(), before = await state(); queries.length = 0;
    const response = await request(f.app).put('/api/v2/orders/' + f.order.id).set(header(f.user.token)).send({ product: 'Injected change', actor: { roles: ['owner'], roleIds: [SYSTEM_ROLE_IDS.SUPER_ADMIN] } });
    expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); expect(dataReads()).toEqual([]); expect(await state()).toEqual(before);
  });
  for (const roleId of [SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.SALES_MANAGER]) {
    it('QCR actual ' + roleId + ' sees explicit team customer order and excludes foreign customer', async () => {
      const user = await identity(roleId), colleague = await identity(), foreign = await identity();
      const teamId = prefix + '-' + ++serial + '-team'; await db().team.create({ data: { id: teamId, name: 'Synthetic actual team' } });
      for (const id of [user.id, colleague.id]) await db().teamMember.create({ data: { id: teamId + id, teamId, userId: id } });
      const relation = async (ownerId: string) => db().relation.create({ data: { id: prefix + '-' + ++serial + '-relation', name: 'Synthetic team customer', category: 'Customer', type: 'Organization', isOrganization: true, tags: [], contactInfo: '', lastInteraction: 0n, ownerId } });
      const ownCustomer = await relation(user.id), shared = await relation(foreign.id), hidden = await relation(foreign.id);
      await db().teamDataGrant.create({ data: { id: teamId + '-grant', teamId, entityType: 'relation', entityId: shared.id, permission: 'read', grantedBy: user.id } });
      const own = await order(colleague.id, ownCustomer.id), team = await order(foreign.id, shared.id), other = await order(foreign.id, hidden.id);
      const application = app(), response = await request(application).get('/api/v1/orders').set(header(user.token));
      expect(response.status).toBe(200); const ids = response.body.orders.map((row: any) => row.id);
      expect(ids).toContain(own.id); expect(ids).toContain(team.id); expect(ids).not.toContain(other.id);
      const detail = await request(application).get('/api/v2/orders/' + other.id).set(header(user.token)); expect(detail.status).toBe(404);
      const resolver = await createPermissionService({ prisma: db() }).getDataScopeResolver(user.actor, 'orders');
      expect(resolver.rule.kind).toBe('team'); expect(resolver.allowedUserIds).toContain(colleague.id); expect(resolver.allowedUserIds).not.toContain(foreign.id);
    });
  }
  it('QCR actual role removal defeats stale claimed QC/owner all, while an explicit remaining read grant keeps only self L2', async () => {
    const f = await qcFixture(), granter = await identity(SYSTEM_ROLE_IDS.SUPER_ADMIN); const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'orders:read' } });
    await db().userPermissionOverrides.create({ data: { id: f.user.id + '-personal', userId: f.user.id, scope: permission.scope, grantedBy: granter.id, reason: 'Synthetic explicit read grant survives removal of QC role', isActive: true } });
    await db().userRole.deleteMany({ where: { userId: f.user.id } });
    const forged = { ...f.user.actor, roles: ['owner'] as any, roleIds: [SYSTEM_ROLE_IDS.QC, SYSTEM_ROLE_IDS.SUPER_ADMIN], authorizationLoaded: true as const };
    expect((await createPermissionService({ prisma: db() }).getDataScopeResolver(forged, 'orders')).rule.kind).toBe('self');
    const response = await request(f.app).get('/api/v1/orders/' + f.order.id).set(header(auth.signToken(forged))); expect(response.status).toBe(404);
    const own = await order(f.user.id); const ownResponse = await request(f.app).get('/api/v1/orders/' + own.id).set(header(f.user.token));
    expect(ownResponse.status).toBe(200); expect(ownResponse.body.order.id).toBe(own.id);
  });
  it('QCR current read-grant withdrawal rejects the real loaded signed session before any business read', async () => {
    const f = await qcFixture(), permission = await db().permission.findUniqueOrThrow({ where: { scope: 'orders:read' } });
    await db().rolePermission.deleteMany({ where: { roleId: SYSTEM_ROLE_IDS.QC, permissionId: permission.id } });
    try { queries.length = 0; const response = await request(f.app).get('/api/v1/orders').set(header(f.user.token));
      expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); expect(dataReads()).toEqual([]);
    } finally { await grant(SYSTEM_ROLE_IDS.QC, 'orders:read'); }
  });
  for (const status of ['disabled', 'deleted', 'missing'] as const) {
    it('QCR ' + status + ' current account cannot regain old owner all even with an unmarked signed token', async () => {
      const f = await qcFixture(), stale = { userId: f.user.id, roles: ['owner'], permissions: [], departmentIds: [] } as TokenPayload;
      if (status === 'disabled') await db().userAccount.update({ where: { id: f.user.id }, data: { status: 'disabled' } });
      else if (status === 'deleted') await db().userAccount.update({ where: { id: f.user.id }, data: { deletedAt: BigInt(Date.now()) } });
      else await db().userAccount.delete({ where: { id: f.user.id } });
      await typedRejection(() => createPermissionService({ prisma: db() }).getDataScopeResolver(stale, 'orders'), 'ACCOUNT_DISABLED', 401);
      const response = await request(f.app).get('/api/v1/orders/' + f.order.id + '/context').set(header(auth.signToken(stale)));
      expect(response.status).toBe(401); expect(code(response)).toBe('ACCOUNT_DISABLED');
    });
  }
  it('QCR actual native authorization query fault is typed unknown and never returns default all', async () => {
    const f = await qcFixture();
    const fault = new Proxy(db(), { get(target, field) {
      if (field === 'userAccount') return new Proxy(target.userAccount, { get(delegate, method) {
        if (method === 'findUnique') return async (args: any) => { await delegate.findUnique(args); return db().$queryRawUnsafe('SELECT "missing_qcr_column" FROM "UserAccount" LIMIT 1'); };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } }); const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await typedRejection(() => createPermissionService({ prisma: fault }).getDataScopeResolver(f.user.actor, 'orders'), 'AUTHORIZATION_UNAVAILABLE', 503);
    expect(queries.some(query => query.includes('missing_qcr_column'))).toBe(true);
  });
  it('QCR custom role named Finance plus body/claimed canonical role IDs cannot create company-wide visibility', async () => {
    const user = await identity(undefined, ['orders:read'], 'Finance'), other = await identity(undefined, []), hidden = await order(other.id);
    const spoof = { ...user.actor, roles: ['owner'] as any, roleIds: [SYSTEM_ROLE_IDS.FINANCE], departmentIds: ['company'], authorizationLoaded: true as const };
    expect((await createPermissionService({ prisma: db() }).getDataScopeResolver(spoof, 'orders')).rule.kind).toBe('self');
    const response = await request(app()).post('/api/v1/orders/query').set(header(auth.signToken(spoof))).send({ filters: {}, actor: { ...spoof, permissionCeiling: ['*'] } });
    expect(response.status).toBe(200); expect(response.body.items.map((row: any) => row.id)).not.toContain(hidden.id);
  });
  it('QCR old unmarked token format works only through actual active current QC identity', async () => {
    const f = await qcFixture(), old = auth.signToken({ userId: f.user.id, roles: ['viewer'], permissions: ['orders:read'], departmentIds: [] });
    const response = await request(f.app).get('/api/v1/orders/' + f.order.id).set(header(old));
    expect(response.status).toBe(200); expect(response.body.order.id).toBe(f.order.id);
  });
  it('QCR signed empty ceiling rejects direct L2 without querying a business or actor row', async () => {
    const f = await qcFixture(); await typedRejection(() => createPermissionService({ prisma: db() }).getDataScopeResolver({ ...f.user.actor, permissionCeiling: [] }, 'orders'), 'FORBIDDEN', 403);
    expect(queries).toEqual([]);
  });
  it('QCR normal login and refresh retain an undefined ceiling and genuine QC read', async () => {
    const f = await qcFixture(), token = await refresh(f.app, await login(f), undefined);
    const response = await request(f.app).get('/api/v1/orders/' + f.order.id).set(header(token)); expect(response.status).toBe(200);
  });
  for (const cap of [[], ['qc:read'], ['qc:write']] as string[][]) {
    it('QCR login-derived signed ceiling ' + JSON.stringify(cap) + ' survives refresh and real read/write gates', async () => {
      const f = await qcFixture(), original = auth.verifyToken(await login(f));
      const next = await refresh(f.app, credentialCeiling(original, cap), cap);
      const before = await state(), read = await request(f.app).get('/api/v1/qc/locations').set(header(next));
      expect(read.status).toBe(cap.includes('qc:read') ? 200 : 403);
      const response = await request(f.app).post('/api/v1/qc/locations').set(header(next)).send({ code: 'QCR' + randomUUID().slice(0, 8), name: 'Synthetic native ceiling location', actor: { roles: ['owner'], permissionCeiling: ['*'] } });
      expect(response.status, diagnostic(response.body)).toBe(cap.includes('qc:write') ? 201 : 403);
      if (cap.includes('qc:write')) { locations.push(response.body.item.id); expect(await db().qCLocation.findUnique({ where: { id: response.body.item.id } })).toMatchObject({ name: 'Synthetic native ceiling location' }); }
      else expect(await state()).toEqual(before);
    });
  }
  it('QCR refresh re-reads current grants and never restores withdrawn QC reads within a signed nonempty ceiling', async () => {
    const f = await qcFixture(), token = credentialCeiling(auth.verifyToken(await login(f)), ['qc:read']);
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'qc:read' } });
    await db().rolePermission.deleteMany({ where: { roleId: SYSTEM_ROLE_IDS.QC, permissionId: permission.id } });
    try { const next = await refresh(f.app, token, ['qc:read']); expect(auth.verifyToken(next).permissions).not.toContain('qc:read');
      const response = await request(f.app).get('/api/v1/qc/locations').set(header(next)); expect(response.status).toBe(403);
    } finally { await grant(SYSTEM_ROLE_IDS.QC, 'qc:read'); }
  });
  it('QCR refresh refuses an actually disabled account and emits no replacement credential', async () => {
    const f = await qcFixture(), token = await login(f); await db().userAccount.update({ where: { id: f.user.id }, data: { status: 'disabled' } });
    const response = await request(f.app).post('/api/auth/refresh').set(header(token)).send({ roles: ['owner'] });
    expect(response.status).toBe(401); expect(code(response)).toBe('ACCOUNT_DISABLED'); expect(response.body.token).toBeUndefined();
  });
  it('QCR old unmarked signed owner claims cannot bypass actual QC read-grant withdrawal', async () => {
    const f = await qcFixture(), permission = await db().permission.findUniqueOrThrow({ where: { scope: 'orders:read' } });
    const old = auth.signToken({ userId: f.user.id, roles: ['owner'], permissions: [], departmentIds: [] });
    await db().rolePermission.deleteMany({ where: { roleId: SYSTEM_ROLE_IDS.QC, permissionId: permission.id } });
    try { const before = await state(); queries.length = 0;
      const response = await request(f.app).get('/api/v1/orders').set(header(old));
      expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN'); expect(dataReads()).toEqual([]); expect(await state()).toEqual(before);
    } finally { await grant(SYSTEM_ROLE_IDS.QC, 'orders:read'); }
  });
  for (const status of ['disabled', 'deleted', 'missing'] as const) {
    it('QCR snapshot old unmarked owner ' + status + ' cannot enter native Order reads', async () => {
      const f = await qcFixture(), old = auth.signToken({ userId: f.user.id, roles: ['owner'], permissions: [], departmentIds: [] });
      if (status === 'disabled') await db().userAccount.update({ where: { id: f.user.id }, data: { status: 'disabled' } });
      else if (status === 'deleted') await db().userAccount.update({ where: { id: f.user.id }, data: { deletedAt: BigInt(Date.now()) } });
      else await db().userAccount.delete({ where: { id: f.user.id } });
      queries.length = 0; const response = await request(f.app).get('/api/v1/orders').set(header(old));
      expect(response.status, diagnostic(response.body)).toBe(401); expect(code(response)).toBe('ACCOUNT_DISABLED'); expect(dataReads()).toEqual([]);
    });
  }
  it('QCR snapshot old unmarked JWT native read fault fails unknown before business access', async () => {
    const f = await qcFixture(), old = auth.signToken({ userId: f.user.id, roles: ['owner'], permissions: [], departmentIds: [] });
    const fault = new Proxy(db(), { get(target, field) {
      if (field === 'userAccount') return new Proxy(target.userAccount, { get(delegate, method) {
        if (method === 'findFirst') return async (args: any) => { await delegate.findFirst(args); return db().$queryRawUnsafe('SELECT "missing_qcr_column" FROM "UserAccount" LIMIT 1'); };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } }); const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value;
    } });
    queries.length = 0; const response = await request(app(fault)).get('/api/v1/orders').set(header(old));
    expect(response.status, diagnostic(response.body)).toBe(503); expect(code(response)).toBe('AUTHORIZATION_UNAVAILABLE'); expect(dataReads()).toEqual([]);
  });
  it('QCR bound API key uses actual current QC L2, keeps JWT-only writes and observes current role withdrawal', async () => {
    const f = await qcFixture(), application = app(db(), f.user.actor), key = prefix + '-bound-key';
    const read = await request(application).get('/api/v1/orders/' + f.order.id).set('X-Bambook-API-Key', key);
    expect(read.status, diagnostic(read.body)).toBe(200); expect(read.body.order.id).toBe(f.order.id);
    const before = await state(); const write = await request(application).post('/api/v1/qc/locations').set('X-Bambook-API-Key', key)
      .send({ code: 'QCR-KEY', name: 'Body cannot supply a user session', actor: { roles: ['owner'] } });
    expect(write.status).toBe(401); expect(await state()).toEqual(before);
    await db().userRole.deleteMany({ where: { userId: f.user.id } }); queries.length = 0;
    const withdrawn = await request(application).get('/api/v1/orders').set('X-Bambook-API-Key', key);
    expect(withdrawn.status).toBe(403); expect(code(withdrawn)).toBe('FORBIDDEN'); expect(dataReads()).toEqual([]);
  });
  it('QCR configured API-key ceiling and disabled/missing subject cannot be overridden by claimed owner fields', async () => {
    const f = await qcFixture(), key = prefix + '-bound-key', application = app(db(), { ...f.user.actor, permissionCeiling: [] });
    queries.length = 0; const limited = await request(application).get('/api/v1/orders').set('X-Bambook-API-Key', key).query({ roles: 'owner' });
    expect(limited.status).toBe(403); expect(code(limited)).toBe('FORBIDDEN'); expect(dataReads()).toEqual([]);
    await db().userAccount.update({ where: { id: f.user.id }, data: { status: 'disabled' } }); queries.length = 0;
    const disabled = await request(application).get('/api/v1/orders').set('X-Bambook-API-Key', key);
    expect(disabled.status).toBe(401); expect(code(disabled)).toBe('ACCOUNT_DISABLED'); expect(dataReads()).toEqual([]);
    queries.length = 0; const absent = await request(app(db(), { ...f.user.actor, userId: prefix + '-absent-key-subject' }))
      .get('/api/v1/orders').set('X-Bambook-API-Key', key);
    expect(absent.status).toBe(401); expect(code(absent)).toBe('ACCOUNT_DISABLED'); expect(dataReads()).toEqual([]);
  });
  it('QCR restored company-wide QC scope does not reveal cost/profit or change the actual pricing-only delegated AP contract', async () => {
    const f = await qcFixture(), service = createPermissionService({ prisma: db() });
    expect(service.stripSensitive({ cost: 123, profit: 45 }, { cost: 'cost', profit: 'profit' }, f.user.actor)).toEqual({ cost: null, profit: null });
    const pricing = await identity(undefined, ['pricing:write']); const own = await order(pricing.id), foreign = await order(f.other.id);
    expect(pricing.actor.permissions).toEqual(['pricing:write']); expect(pricing.actor.permissions).not.toContain('orders:read');
    const scope = await buildOrderListScopeWhere(db(), pricing.actor, { fresh: true });
    const visible = await db().order.findMany({ where: { id: { in: [own.id, foreign.id] }, AND: [scope] } }); expect(visible.map(row => row.id)).toEqual([own.id]);
  });
});
