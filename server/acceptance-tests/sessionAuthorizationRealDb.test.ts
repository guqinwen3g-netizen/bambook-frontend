/**
 * Opt-in AUTH-A / AR01-AR03 acceptance probes. The ordinary vitest config excludes
 * acceptance-tests; run only through the reviewed isolated-PG acceptance runner.
 *
 * Business basis (independent of the default role matrix):
 * - docs/运营落地决策基线与首批方案-2026-09-30.md:26: effective operation authority.
 * - docs/design/04-模块设计/06-资源与支撑/HR-人事管理/薪酬与工资条.md:447-463:
 *   hr:salary:read AND sensitive:salary; valid designated-person overrides.
 * - docs/design/04-模块设计/02-客户与开拓/业务员离职一键交接.md:4-5:
 *   disabled employees lose access while history remains.
 *
 * Evidence layer: actual PG fixtures, public login/me/refresh HTTP routes, real
 * cookie parsing, JWT signing/verification and authorization middleware. The
 * two /acceptance/* endpoints below are PURE GUARD PROBES with no payroll/order
 * business service or data mutation. They are NOT actual HR/order API evidence,
 * UI grant-management evidence, Agent evidence or complete business acceptance.
 *
 * Host order preserves index.ts:365-368: cookieParser -> accountStatusGuard ->
 * auth routes. The disabled-account case makes its FIRST authenticated request
 * after disabling the fixture, so it tests a fresh status lookup, NOT warm-cache
 * invalidation, multi-process revocation timing or the auth router in isolation.
 * Role/override changes are judged at the explicit refresh/re-authentication
 * boundary; no elapsed-time/cache-TTL expectation is introduced here.
 *
 * No seed, production app bootstrap, scheduler or external provider is invoked.
 * Isolation is verified BEFORE fixture writes; only minimal synthetic records
 * are created. Rows remain available for the runner's evidence capture and are
 * discarded with its temporary cluster, rather than deleting other test data.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthRouter } from '../src/auth/route';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createModuleAuthGuard } from '../src/auth/moduleGuard';
import { requirePermission } from '../src/auth/permissionGuard';

const SALARY_SCOPES = ['hr:salary:read', 'sensitive:salary'] as const;
type SalaryScope = typeof SALARY_SCOPES[number];
type GrantState = 'active' | 'expired' | 'inactive' | 'deleted';
type Grant = { scope: SalaryScope; state?: GrantState };
type Fixture = { id: string; email: string };
type Session = { cookie: string; token: string; payload: TokenPayload };

const prefix = `acceptance-session-${randomUUID()}`;
const password = 'AcceptanceSessionSyntheticPassword123!';
// Per-suite role IDs prevent unrelated real-PG fixtures from changing this
// independently specified role baseline; no shared role grants are removed.
const salesRoleId = `${prefix}-sales-role`;
const grantorRoleId = `${prefix}-grantor-role`;
const grantorId = `${prefix}-grantor`;
const permissionIds = new Map<string, string>();
let prisma: PrismaClient | undefined;
let app: Express;
let passwordHash: string;
let fixtureNumber = 0;
let salaryGuardHits = 0;
let orderWriteGuardHits = 0;

function db(): PrismaClient {
  if (!prisma) throw new Error('AUTH-A fixture precondition: isolated client not initialized');
  return prisma;
}

function auth() {
  // Uses the same secret source as the real router/middleware; no custom verifier
  // that could accidentally approve tokens rejected by the actual HTTP path.
  return createAuthService();
}

function sessionFromCookieResponse(response: { headers: Record<string, unknown> }, phase: string): Session {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header.map(String) : typeof header === 'string' ? [header] : [];
  const issued = cookies.map(value => value.split(';')[0])
    .filter(value => value.startsWith('bambook_token=') && value !== 'bambook_token=');
  // Assert counts/claims rather than logging raw bearer tokens or cookie values.
  expect(issued.length, `${phase}: must issue exactly one nonempty session cookie`).toBe(1);
  const cookie = issued[0];
  const token = decodeURIComponent(cookie.slice('bambook_token='.length));
  return { cookie, token, payload: auth().verifyToken(token) };
}

function expectSalaryPermissions(permissions: unknown, expected: readonly SalaryScope[], phase: string): void {
  expect(Array.isArray(permissions), `${phase}: permissions must be a public scope array`).toBe(true);
  for (const scope of SALARY_SCOPES) {
    expect((permissions as string[]).includes(scope), `${phase}: effective ${scope}`).toBe(expected.includes(scope));
  }
}

async function fixture(label: string, grants: Grant[] = []): Promise<Fixture> {
  const id = `${prefix}-${++fixtureNumber}-${label}`;
  const email = `${id}@example.invalid`;
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: `Synthetic AUTH-A ${label}`, email, passwordHash, status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-sales-role`, userId: id, roleId: salesRoleId } });
    for (const grant of grants) await createGrant(tx, id, grant);
  });
  return { id, email };
}

async function createGrant(client: Pick<PrismaClient, 'userPermissionOverrides'>, userId: string, grant: Grant): Promise<void> {
  const state = grant.state ?? 'active';
  await client.userPermissionOverrides.create({ data: {
    id: `${userId}-grant-${grant.scope}`,
    userId,
    scope: grant.scope,
    grantedBy: grantorId,
    reason: 'Synthetic designated HR authorization; granting UI and approver policy are not exercised',
    isActive: state !== 'inactive',
    expiresAt: new Date(Date.now() + (state === 'expired' ? -3_600_000 : 3_600_000)),
    deletedAt: state === 'deleted' ? new Date() : null,
  } });
}

async function login(f: Fixture): Promise<Session> {
  const response = await request(app).post('/api/auth/login').send({ email: f.email, password });
  expect(response.status, `${f.id}: actual credential login must succeed before authorization assertions`).toBe(200);
  expect(response.body.ok, 'login: public ok flag').toBe(true);
  const session = sessionFromCookieResponse(response, 'login');
  expect(typeof response.body.token, 'login: public token field').toBe('string');
  expect(auth().verifyToken(response.body.token).userId, 'login body JWT principal').toBe(f.id);
  expect(session.payload.userId, 'login cookie JWT principal').toBe(f.id);
  expect(response.body.user?.permissions, 'login body and cookie must present the same effective scopes').toEqual(session.payload.permissions);
  return session;
}

async function refresh(session: Session): Promise<Session> {
  const response = await request(app).post('/api/auth/refresh').set('Cookie', session.cookie);
  expect(response.status, 'active fixture: actual refresh route must succeed').toBe(200);
  expect(response.body.ok, 'refresh: public ok flag').toBe(true);
  const renewed = sessionFromCookieResponse(response, 'refresh');
  expect(response.body.user?.permissions, 'refresh body and renewed cookie must present the same scopes').toEqual(renewed.payload.permissions);
  expect(renewed.payload.userId, 'refresh must preserve the authenticated principal').toBe(session.payload.userId);
  return renewed;
}

async function me(session: Session) {
  const response = await request(app).get('/api/auth/me').set('Cookie', session.cookie);
  expect(response.status, 'active fixture: actual /me route must succeed').toBe(200);
  expect(response.body.user?.id, '/me must identify the same authenticated fixture').toBe(session.payload.userId);
  return response.body.user;
}

async function salaryGuard(session: Session, allowed: boolean): Promise<void> {
  const before = salaryGuardHits;
  const response = await request(app).get('/acceptance/salary-dual-scope-only').set('Cookie', session.cookie);
  expect(response.status, 'PURE salary guard: both scopes are required; no payroll service is invoked').toBe(allowed ? 204 : 403);
  expect(salaryGuardHits - before, 'PURE salary guard: denied calls must not reach the handler').toBe(allowed ? 1 : 0);
}

describe.sequential('AUTH-A: isolated PG session authorization at public authentication boundaries', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    const expectedName = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const expectedPort = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    const expectedDirectory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX), 'precondition: use the reviewed isolated acceptance runner').toBe(true);
    expect(url.protocol, 'precondition: actual PostgreSQL transport').toBe('postgresql:');
    expect(url.hostname, 'precondition: never connect to the shared/business database').toBe('127.0.0.1');
    expect(url.port, 'precondition: runner-owned PG port').toBe(expectedPort);
    expect(url.pathname, 'precondition: runner-owned database name').toBe(`/${expectedName}`);
    expect(url.pathname, 'precondition: generated acceptance database namespace').toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(expectedDirectory), 'precondition: independent PG directory identity is required').toBe(true);
    expect(process.env.BAMBOOK_NO_SCHEDULER, 'precondition: schedulers must remain disabled').toBe('1');

    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'precondition: independently verify PG identity before any fixture writes').toEqual([
      { name: expectedName, directory: expectedDirectory, port: Number(expectedPort) },
    ]);

    // These are synthetic fixture responsibilities, never a business/demo seed.
    // Do not touch role-finance (owned by pricingAuthorizationRealDb) or assert a
    // global Permission count. The fixture's sales role must have no prior grants.
    expect(await db().rolePermission.count({ where: { roleId: salesRoleId } }),
      'precondition: synthetic sales fixture requires no inherited RolePermission rows').toBe(0);
    passwordHash = await auth().hashPassword(password);
    await db().$transaction(async tx => {
      for (const roleId of [salesRoleId, grantorRoleId]) {
        await tx.role.upsert({ where: { id: roleId }, update: {}, create: {
          id: roleId, name: roleId === salesRoleId ? 'sales' : 'owner', isSystem: true,
          description: 'Synthetic session-authorization fixture; no default scope seed',
        } });
      }
      for (const scope of ['orders:read', 'orders:write', ...SALARY_SCOPES]) {
        const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
        permissionIds.set(scope, permission.id);
      }
      await tx.rolePermission.create({ data: { id: `${prefix}-sales-read`, roleId: salesRoleId, permissionId: permissionIds.get('orders:read')! } });
      await tx.userAccount.create({ data: { id: grantorId, displayName: 'Synthetic authorized grantor', status: 'active' } });
      await tx.userRole.create({ data: { id: `${prefix}-grantor-role`, userId: grantorId, roleId: grantorRoleId } });
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(createAccountStatusGuard(db()));
    app.use('/api/auth', createAuthRouter({ prisma: db(), loginRateLimit: false }));
    const authenticate = createModuleAuthGuard({ requireAuth: true, apiKeys: new Set<string>() });
    app.get('/acceptance/salary-dual-scope-only', authenticate,
      requirePermission('hr:salary:read'), requirePermission('sensitive:salary'), (_req, res) => {
        salaryGuardHits++;
        res.status(204).end();
      });
    app.post('/acceptance/order-write-scope-only', authenticate,
      requirePermission('orders:write'), (_req, res) => {
        orderWriteGuardHits++;
        res.status(204).end();
      });
  });

  beforeEach(() => { salaryGuardHits = 0; orderWriteGuardHits = 0; });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('positive transport control: an unchanged active role scope survives login, /me and refresh', async () => {
    const f = await fixture('unchanged-active-role');
    const original = await login(f);
    expect(original.payload.permissions.includes('orders:read'), 'login uses the explicit PG role grant').toBe(true);
    expect((await me(original)).permissions.includes('orders:read'), '/me unchanged role control').toBe(true);
    const renewed = await refresh(original);
    expect(renewed.payload.permissions.includes('orders:read'), 'refresh unchanged role control').toBe(true);
    expectSalaryPermissions(renewed.payload.permissions, [], 'unrelated role scope must not grant salary');
    await salaryGuard(renewed, false);
  });

  const combinations: Array<{ label: string; scopes: SalaryScope[]; allowed: boolean }> = [
    { label: 'neither-scope', scopes: [], allowed: false },
    { label: 'salary-read-only', scopes: ['hr:salary:read'], allowed: false },
    { label: 'sensitive-salary-only', scopes: ['sensitive:salary'], allowed: false },
    { label: 'both-personal-scopes', scopes: [...SALARY_SCOPES], allowed: true },
  ];
  it.each(combinations)('login personal grant combination $label: PURE dual-scope guard allowed=$allowed', async ({ label, scopes, allowed }) => {
    const f = await fixture(label, scopes.map(scope => ({ scope })));
    const session = await login(f);
    expectSalaryPermissions(session.payload.permissions, scopes, 'login JWT personal authorization');
    await salaryGuard(session, allowed);
  });

  it('/me returns effective personal dual scopes independently of the original login JWT scopes', async () => {
    const f = await fixture('me-current-personal-grants', SALARY_SCOPES.map(scope => ({ scope })));
    const session = await login(f);
    // Do not assert the login's salary scopes here: otherwise AF03 would hide the
    // independent /me result. Credential success and cookie authenticity suffice.
    expectSalaryPermissions((await me(session)).permissions, SALARY_SCOPES, '/me current personal authorization');
  });

  it('refresh loads valid personal dual scopes granted after the original real login', async () => {
    const f = await fixture('new-grants-at-refresh');
    const original = await login(f);
    expectSalaryPermissions(original.payload.permissions, [], 'positive precondition: no original salary grants');
    for (const scope of SALARY_SCOPES) await createGrant(db(), f.id, { scope });
    const renewed = await refresh(original);
    expectSalaryPermissions(renewed.payload.permissions, SALARY_SCOPES, 'refresh must load current valid personal authorization');
    expectSalaryPermissions((await me(renewed)).permissions, SALARY_SCOPES, '/me after personal-authorization refresh');
    await salaryGuard(renewed, true);
  });

  it.each(['expired', 'inactive', 'deleted'] as const)('%s personal dual grants are absent at login, /me, refresh and the PURE guard', async state => {
    const f = await fixture(`invalid-grants-${state}`, SALARY_SCOPES.map(scope => ({ scope, state })));
    const original = await login(f);
    expectSalaryPermissions(original.payload.permissions, [], `${state} grants at login`);
    expectSalaryPermissions((await me(original)).permissions, [], `${state} grants at /me`);
    await salaryGuard(original, false);
    const renewed = await refresh(original);
    expectSalaryPermissions(renewed.payload.permissions, [], `${state} grants at refresh`);
    await salaryGuard(renewed, false);
  });

  it('refresh does not renew a revoked DB role scope from an old valid cookie', async () => {
    const rolePermissionId = `${prefix}-temporary-sales-write`;
    await db().rolePermission.create({ data: { id: rolePermissionId, roleId: salesRoleId, permissionId: permissionIds.get('orders:write')! } });
    try {
      const f = await fixture('role-scope-revoked');
      const original = await login(f);
      expect(original.payload.permissions.includes('orders:write'), 'positive precondition: DB-granted original write scope').toBe(true);
      const positive = await request(app).post('/acceptance/order-write-scope-only').set('Cookie', original.cookie);
      expect(positive.status, 'PURE write guard positive control before DB revocation').toBe(204);
      expect(orderWriteGuardHits, 'positive control must actually reach the pure handler').toBe(1);
      await db().rolePermission.delete({ where: { id: rolePermissionId } });
      expect(auth().verifyToken(original.token).permissions.includes('orders:write'),
        'precondition: old signed cookie still carries the revoked scope; no TTL assumption').toBe(true);

      const renewed = await refresh(original);
      expect(renewed.payload.permissions.includes('orders:read'), 'unrevoked role control remains available').toBe(true);
      expect.soft(renewed.payload.permissions.includes('orders:write'), 'refresh must not re-sign the revoked role grant').toBe(false);
      expect.soft((await me(renewed)).permissions.includes('orders:write'), '/me must agree with current role authorization').toBe(false);
      const before = orderWriteGuardHits;
      const denied = await request(app).post('/acceptance/order-write-scope-only').set('Cookie', renewed.cookie);
      expect.soft(denied.status, 'PURE write guard must reject the renewed session after explicit revocation').toBe(403);
      expect.soft(orderWriteGuardHits - before, 'revoked write scope must not reach the pure handler').toBe(0);
    } finally {
      // Only this fixture's exact temporary row; never delete another worker's
      // role/permissions or reset the whole role matrix.
      await db().rolePermission.deleteMany({ where: { id: rolePermissionId } });
    }
  });

  it('a disabled account cannot refresh its old cookie at the first authenticated status lookup', async () => {
    const f = await fixture('disabled-before-first-status-lookup');
    const original = await login(f); // No request cookie: status cache is not warmed.
    await db().userAccount.update({ where: { id: f.id }, data: { status: 'disabled' } });
    expect(auth().verifyToken(original.token).userId, 'old token is cryptographically valid, so this is not expiry rejection').toBe(f.id);
    const denied = await request(app).post('/api/auth/refresh').set('Cookie', original.cookie);
    expect([401, 403].includes(denied.status), 'fresh runtime auth boundary must not renew a disabled principal').toBe(true);
    const header = denied.headers['set-cookie'];
    const cookies = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
    expect(cookies.some(value => /^bambook_token=[^;]/.test(value)), 'rejection may clear cookies but must not issue a new authorized session').toBe(false);
    const profile = await request(app).get('/api/auth/me').set('Cookie', original.cookie);
    expect([401, 403].includes(profile.status), 'disabled principal must not receive a fresh public /me profile').toBe(true);
    expect(await db().userAccount.count({ where: { id: f.id, status: 'disabled' } }), 'disabled account history remains stored').toBe(1);
  });
});
