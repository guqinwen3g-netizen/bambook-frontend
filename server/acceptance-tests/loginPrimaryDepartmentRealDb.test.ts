/** Native login/profile display regression, only in an explicitly new private PG.
 * No production credentials, directory grants, role changes, or source mocks. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthRouter } from '../src/auth/route';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { hasScope } from '../src/auth/permissionService';

const prefix = 'native-login-department-' + randomUUID();
const password = 'Synthetic-D01-acceptance-only';
const auth = createAuthService();
let prisma: PrismaClient, passwordHash: string, sequence = 0;

beforeAll(async () => {
  const { DATABASE_URL: url, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!url || !sandbox || !name || !directory || !port) throw Error('Explicit private PostgreSQL identity required');
  const parsed = new URL(url);
  expect(parsed.protocol).toBe('postgresql:'); expect(parsed.hostname).toBe('127.0.0.1');
  expect(parsed.pathname).toBe('/' + name); expect(parsed.port).toBe(port);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  for (const key of ['RESEND_API_KEY', 'OPENAI_API_KEY', 'SMTP_PASSWORD', 'IMAP_PASSWORD', 'BAMBOOK_API_KEY', 'BAMBOOK_SDK_KEY']) expect(process.env[key]).toBeUndefined();
  prisma = new PrismaClient({ datasources: { db: { url } } });
  const identity = await prisma.$queryRaw<any[]>`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  expect(identity).toEqual([{ name, directory, port: Number(port) }]);
  passwordHash = await auth.hashPassword(password);
});
afterAll(async () => { await prisma?.$disconnect(); });

function app() {
  const application = express(); application.use(cookieParser()); application.use(express.json());
  application.use('/api', createAuthorizationSnapshotGuard({ prisma }));
  application.use('/api/auth', createAuthRouter({ prisma, loginRateLimit: false,
    email: { isReal: false, describe: () => 'No delivery synthetic native endpoint control', send: async () => undefined } }));
  return application;
}

async function fixture(primary: boolean, assignedRole = true) {
  const id = prefix + '-' + (++sequence), primaryId = id + '-primary', roleDepartmentId = id + '-role-dept', roleId = id + '-role';
  await prisma.department.create({ data: { id: primaryId, name: 'Synthetic own primary department', metadata: { confidential: 'DO_NOT_PROJECT_PRIMARY_METADATA' } } });
  await prisma.department.create({ data: { id: roleDepartmentId, name: 'Not the primary department', metadata: { confidential: 'DO_NOT_PROJECT_OTHER_DEPARTMENT' } } });
  const user = await prisma.userAccount.create({ data: { id, displayName: 'Synthetic own account ' + sequence,
    email: id + '@acceptance.invalid', passwordHash, status: 'active', primaryDeptId: primary ? primaryId : null,
    metadata: { confidential: 'DO_NOT_PROJECT_ACCOUNT_METADATA' } } });
  if (assignedRole) {
    const permission = await prisma.permission.upsert({ where: { scope: 'orders:read' }, update: {}, create: { id: id + '-permission', scope: 'orders:read' } });
    await prisma.role.create({ data: { id: roleId, name: 'Synthetic ordinary reader', isSystem: false,
      permissions: { create: { id: id + '-role-permission', permissionId: permission.id } } } });
    await prisma.userRole.create({ data: { id: id + '-assignment', userId: id, roleId, departmentId: roleDepartmentId } });
    await prisma.userPermissionOverrides.create({ data: { id: id + '-grant', userId: id, scope: 'finance:read', grantedBy: id,
      reason: 'Synthetic current grant, no business or HR facts' } });
  }
  return { user, primaryId, roleDepartmentId, roleId, assignedRole };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function authorization(item: Fixture) {
  return { roles: [], roleIds: item.assignedRole ? [item.roleId] : [],
    permissions: item.assignedRole ? ['finance:read', 'orders:read'] : [],
    departmentIds: item.assignedRole ? [item.roleDepartmentId] : [item.user.primaryDeptId || 'company'], authorizationLoaded: true };
}
function assertMinimalUser(user: any, capped = false) {
  const keys = ['id', 'displayName', 'email', 'avatarUrl', 'roles', 'roleIds', 'roleLabels', 'permissions', 'authorizationLoaded', 'departmentIds', 'department'];
  if (capped) keys.push('permissionCeiling');
  expect(Object.keys(user).sort()).toEqual(keys.sort());
  expect(JSON.stringify(user)).not.toMatch(/passwordHash|primaryDeptId|primaryDepartment|employeeProfile|metadata|salary|DO_NOT_PROJECT/);
}
function assertClaims(token: string, item: Fixture) {
  const payload = auth.verifyToken(token);
  expect(payload).toMatchObject({ userId: item.user.id, displayName: item.user.displayName, ...authorization(item) });
  const { iat: _iat, exp: _exp, ...claims } = payload as TokenPayload & { iat: number; exp: number };
  expect(Object.keys(claims).sort()).toEqual(['userId', 'displayName', 'roles', 'roleIds', 'permissions', 'departmentIds', 'authorizationLoaded'].sort());
  expect(JSON.stringify(claims)).not.toMatch(/primaryDepartment|roleLabels|Synthetic own primary department|DO_NOT_PROJECT/);
  return payload;
}

describe('D01 actual native login primary department display', () => {
  it('D01 linked primary department is named in the first normal login response while original JWT/grants/role departments remain exact', async () => {
    const item = await fixture(true), before = await prisma.userAccount.findUniqueOrThrow({ where: { id: item.user.id } });
    const response = await request(app()).post('/api/auth/login').send({ email: item.user.email, password,
      department: 'Forged department label', primaryDeptId: item.roleDepartmentId, roleIds: ['role-super-admin'], permissions: ['*'] });
    expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
    expect(response.body.user.department).toBe('Synthetic own primary department');
    expect(response.body.user).toMatchObject({ id: item.user.id, ...authorization(item), roleLabels: [{ id: item.roleId, name: 'Synthetic ordinary reader' }] });
    assertMinimalUser(response.body.user); assertClaims(response.body.token, item);
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('bambook_token=')]));
    const after = await prisma.userAccount.findUniqueOrThrow({ where: { id: item.user.id } });
    expect(after.primaryDeptId).toBe(before.primaryDeptId); expect(after.passwordHash).toBe(before.passwordHash); expect(after.metadata).toEqual(before.metadata);
    expect(after.lastLoginAt).not.toBeNull(); expect(await prisma.auditLog.count({ where: { actorId: item.user.id, action: 'login' } })).toBe(1);
  });

  it('D02 role department without a primary association remains null and never invents a primary from role names or request input', async () => {
    const item = await fixture(false);
    const response = await request(app()).post('/api/auth/login').send({ identifier: item.user.displayName, password, department: 'Not the primary department', primaryDeptId: item.roleDepartmentId });
    expect(response.status).toBe(200); expect(response.body.user.department).toBeNull();
    expect(response.body.user.departmentIds).toEqual([item.roleDepartmentId]); assertMinimalUser(response.body.user); assertClaims(response.body.token, item);
    expect((await prisma.userAccount.findUniqueOrThrow({ where: { id: item.user.id } })).primaryDeptId).toBeNull();
    const me = await request(app()).get('/api/auth/me').set('Authorization', 'Bearer ' + response.body.token);
    expect(me.status).toBe(200); expect(me.body.user.department).toBeNull(); expect(me.body.user.departmentIds).toEqual([item.roleDepartmentId]);
  });

  it('D03 no primary and no role preserve null display, company fallback and an authoritative empty grant set', async () => {
    const item = await fixture(false, false), response = await request(app()).post('/api/auth/login').send({ email: item.user.email, password });
    expect(response.status).toBe(200); expect(response.body.user.department).toBeNull();
    expect(response.body.user).toMatchObject(authorization(item)); expect(response.body.user.roleLabels).toEqual([]);
    assertMinimalUser(response.body.user); const payload = assertClaims(response.body.token, item);
    expect(hasScope(payload, 'orders:read')).toBe(false); expect(hasScope(payload, 'orders:write')).toBe(false);
  });

  it('D04 current me/profile reread the real primary name, ignore forged identity/department fields, preserve signed empty ceiling and never expose HR or credentials', async () => {
    const item = await fixture(true), application = app();
    const login = await request(application).post('/api/auth/login').send({ email: item.user.email, password });
    expect(login.status).toBe(200); expect(login.body.user.department).toBe('Synthetic own primary department');
    const stale: TokenPayload = { userId: item.user.id, displayName: 'Old token display', roles: ['owner'], roleIds: ['role-super-admin'], permissions: ['*'], departmentIds: ['forged-department'], permissionCeiling: [] };
    const token = auth.signToken(stale);
    await prisma.department.update({ where: { id: item.primaryId }, data: { name: 'Current own primary department' } });
    const me = await request(application).get('/api/auth/me').set('Authorization', 'Bearer ' + token);
    expect(me.status).toBe(200); expect(me.body.user.department).toBe('Current own primary department');
    expect(me.body.user).toMatchObject({ ...authorization(item), permissionCeiling: [] }); assertMinimalUser(me.body.user, true);
    const profile = await request(application).patch('/api/auth/me').set('Authorization', 'Bearer ' + token).send({ displayName: 'Changed synthetic own profile',
      userId: 'other-account', primaryDeptId: item.roleDepartmentId, department: 'Forged profile department', roles: ['owner'], permissions: ['*'] });
    expect(profile.status).toBe(200); expect(profile.body.user.department).toBe('Current own primary department');
    expect(profile.body.user.displayName).toBe('Changed synthetic own profile'); expect(profile.body.user).toMatchObject({ id: item.user.id, ...authorization(item), permissionCeiling: [] });
    assertMinimalUser(profile.body.user, true);
    const stored = await prisma.userAccount.findUniqueOrThrow({ where: { id: item.user.id } });
    expect(stored.primaryDeptId).toBe(item.primaryId); expect(stored.passwordHash).toBe(passwordHash); expect(stored.metadata).toEqual(item.user.metadata);
    const refreshed = await request(application).post('/api/auth/refresh').set('Authorization', 'Bearer ' + token);
    expect(refreshed.status).toBe(200); expect(refreshed.body.user).toMatchObject({ ...authorization(item), permissionCeiling: [] });
    expect(hasScope(refreshed.body.user, 'orders:read')).toBe(false); expect(hasScope(refreshed.body.user, 'orders:write')).toBe(false);
    expect(await prisma.employeeProfile.count()).toBe(0);
  });

  it('D05 normal wrong-password and disabled-account login remain denied with no token or guessed department', async () => {
    const item = await fixture(true), application = app();
    const wrong = await request(application).post('/api/auth/login').send({ email: item.user.email, password: 'Synthetic incorrect password' });
    expect(wrong.status).toBe(401); expect(wrong.body.error).toBe('INVALID_CREDENTIALS'); expect(wrong.body.token).toBeUndefined(); expect(wrong.body.user).toBeUndefined();
    await prisma.userAccount.update({ where: { id: item.user.id }, data: { status: 'disabled' } });
    const disabled = await request(application).post('/api/auth/login').send({ email: item.user.email, password });
    expect(disabled.status).toBe(403); expect(disabled.body.error).toBe('DISABLED'); expect(disabled.body.token).toBeUndefined(); expect(disabled.body.user).toBeUndefined();
    expect(await prisma.auditLog.count({ where: { actorId: item.user.id, action: 'login' } })).toBe(0);
  });
});
