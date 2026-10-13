/**
 * PP release approval is a leader-only single signature. This exercises the
 * actual canonical role grants, current authorization loader, order L2,
 * action-context HTTP, sign HTTP, locked service check and PostgreSQL facts.
 * All rows are synthetic in the reviewed empty isolated cluster. It does not
 * claim company role assignment/UAT or change the global permission matrix.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';
import { createReleaseRouter } from '../src/production/releaseRoute';
import { signReleaseRequest } from '../src/production/releaseService';
import { addRealtimeClient } from '../src/realtime';

const prefix = `acceptance-pp-leader-single-${randomUUID()}`;
const sqlPrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
const notificationFaultFunction = `${sqlPrefix}_notification_fault`;
const notificationFaultTrigger = `${sqlPrefix}_notification_fault_trigger`;
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
const seededUserIds: string[] = [];
const seededOrderIds: string[] = [];
const seededScopeIds: string[] = [];
const seededRequestIds: string[] = [];

function db(): PrismaClient {
  if (!prisma) throw new Error('PP leader acceptance requires the verified isolated PostgreSQL client');
  return prisma;
}
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const errorCode = (response: any) => response.body.error?.code ?? response.body.error;

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated PostgreSQL runner is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);

  // Populate the canonical built-in role grants from the same production seed
  // helper. No per-user overrides or test-only role-to-scope mapping is used.
  const roleIds = Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[];
  for (const roleId of roleIds) {
    await db().role.upsert({ where: { id: roleId }, update: {},
      create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
  }
  const scopes = [...new Set(roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId)))];
  await db().permission.createMany({ data: scopes.map(scope => ({ id: `${prefix}-permission-${scope}`, scope })), skipDuplicates: true });
  const permissions = await db().permission.findMany({ where: { scope: { in: scopes } }, select: { id: true, scope: true } });
  const permissionIds = new Map(permissions.map(permission => [permission.scope, permission.id]));
  await db().rolePermission.createMany({ data: roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId).map(scope => ({
    id: `${prefix}-role-grant-${roleId}-${scope}`, roleId, permissionId: permissionIds.get(scope)!,
  }))), skipDuplicates: true });
});

afterAll(async () => {
  if (prisma) {
    try {
      await db().releaseEvent.deleteMany({ where: { scopeId: { in: seededScopeIds } } });
      await db().ppSampleRelease.deleteMany({ where: { requestId: { in: seededRequestIds } } });
      await db().releaseSignature.deleteMany({ where: { requestId: { in: seededRequestIds } } });
      await db().releaseRequest.deleteMany({ where: { id: { in: seededRequestIds } } });
      await db().releaseScope.deleteMany({ where: { id: { in: seededScopeIds } } });
      await db().auditLog.deleteMany({ where: { actorId: { in: seededUserIds }, targetType: 'ReleaseScope' } });
      // Successful sign requests notify the synthetic order owner. Remove only
      // notification rows addressed to users created by this isolated test.
      await db().notification.deleteMany({ where: { userId: { in: seededUserIds } } });
      await db().orderLine.deleteMany({ where: { orderId: { in: seededOrderIds } } });
      await db().order.deleteMany({ where: { id: { in: seededOrderIds } } });
      await db().userRole.deleteMany({ where: { userId: { in: seededUserIds } } });
      await db().userAccount.deleteMany({ where: { id: { in: seededUserIds } } });
      await dropNotificationFault();
    } finally { await prisma.$disconnect(); }
  }
});

async function dropNotificationFault() {
  if (!prisma) return;
  await db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${notificationFaultTrigger}" ON "Notification"`);
  await db().$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${notificationFaultFunction}"()`);
}

type ActorFixture = { id: string; roleId: SystemRoleId; actor: TokenPayload; token: string };
type PendingFixture = {
  id: string; actor: ActorFixture; orderId: string; lineId: string; scopeId: string; requestId: string;
  application: AppHarness;
};
type AppHarness = { app: express.Express; changes: unknown[] };

async function actor(roleId: SystemRoleId, label: string): Promise<ActorFixture> {
  const id = `${prefix}-${++sequence}-${label}`;
  await db().userAccount.create({ data: { id, displayName: `Synthetic ${roleId} ${id}`, status: 'active' } });
  seededUserIds.push(id);
  await db().userRole.create({ data: { id: `${id}-membership`, userId: id, roleId } });
  const loaded = await loadUserWithRoles(db(), id);
  if (!loaded) throw Error(`Synthetic canonical actor ${id} did not load`);
  const current = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(current.roleIds).toContain(roleId);
  expect(current.permissions).toEqual(expect.arrayContaining(getDatabaseSeedScopeListForRole(roleId)));
  expect(await db().userPermissionOverrides.count({ where: { userId: id } })).toBe(0);
  return { id, roleId, actor: current, token: auth.signToken(current) };
}

function application(client: PrismaClient = db()): AppHarness {
  const app = express(), changes: unknown[] = [];
  app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/releases', createReleaseRouter({ prisma: client, requireAuth: true, apiKeys: new Set(), onDataChange: change => changes.push(change) }));
  return { app, changes };
}

function bearer(user: ActorFixture | TokenPayload): string {
  return `Bearer ${auth.signToken('actor' in user ? user.actor : user)}`;
}

async function pending(label: string, roleId: SystemRoleId): Promise<PendingFixture> {
  const id = `${prefix}-${++sequence}-${label}`, orderId = `${id}-order`, lineId = `${id}-line`;
  const current = await actor(roleId, `${label}-actor`);
  const now = BigInt(Date.now());
  seededOrderIds.push(orderId);
  await db().order.create({ data: { id: orderId, poNumber: `${id}-po`, customer: `${id} synthetic customer`, product: 'Synthetic fabric',
    type: 'fabric', businessLine: 'fabric', quantity: '1000', unit: 'M', status: 'Confirmed', dueDate: '2099-01-01',
    quoteAmount: '1000', ownerId: current.id, customerRelationId: null, millRelationId: null, sourceCaseId: null,
    moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
      snapshotAt: new Date().toISOString(), configId: null, source: 'fallback_constant' },
    updatedAt: now } });
  await db().orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: '1000', unit: 'M',
    description: 'Synthetic current production item', confirmedSourceType: null, confirmedSourceId: null } });

  const app = application();
  const scopeResponse = await request(app.app).post(`/api/v1/releases/orders/${orderId}/lines/${lineId}/release-scopes`)
    .set('Authorization', bearer(current)).send({ quantity: '1000', unit: 'M' });
  expect(scopeResponse.status, diagnostic(scopeResponse.body)).toBe(201);
  const scopeId = scopeResponse.body.scope.id as string;
  seededScopeIds.push(scopeId);
  const requestResponse = await request(app.app).post(`/api/v1/releases/release-scopes/${scopeId}/requests`)
    .set('Authorization', bearer(current)).send({});
  expect(requestResponse.status, diagnostic(requestResponse.body)).toBe(201);
  const requestId = requestResponse.body.request.id as string;
  seededRequestIds.push(requestId);
  return { id, actor: current, orderId, lineId, scopeId, requestId, application: app };
}

async function actionContext(f: PendingFixture, identity: ActorFixture = f.actor) {
  return request(f.application.app).get(`/api/v1/releases/release-requests/${f.requestId}/action-context`)
    .set('Authorization', bearer(identity));
}

function signBody(item: any, role: 'business' | 'production') {
  return { role, confirmedReviewedContent: true, expectedRequestRevision: item.request.requestRevision,
    expectedScopeRevision: item.request.scopeRevision, reviewContentFingerprint: item.reviewContentFingerprint };
}

async function businessFacts(f: PendingFixture) {
  return {
    scope: await db().releaseScope.findUnique({ where: { id: f.scopeId } }),
    request: await db().releaseRequest.findUnique({ where: { id: f.requestId } }),
    signatures: await db().releaseSignature.findMany({ where: { requestId: f.requestId }, orderBy: { role: 'asc' } }),
    releases: await db().ppSampleRelease.findMany({ where: { scopeId: f.scopeId }, orderBy: { id: 'asc' } }),
    events: await db().releaseEvent.findMany({ where: { scopeId: f.scopeId }, orderBy: { sequence: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'ReleaseScope', targetId: f.scopeId }, orderBy: { id: 'asc' } }),
    notifications: await db().notification.findMany({ where: { userId: f.actor.id, type: 'pp_release_granted' }, orderBy: { id: 'asc' } }),
  };
}

describe.sequential('isolated PG PP leader-only single-sign authority', () => {
  it.each([SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.QC])('%s has the canonical sign scope and in-scope order but cannot single-sign', async roleId => {
    // QC can sign its own inspection domain but intentionally has no
    // orders:write. A current manager establishes the pending release; QC then
    // reads/sign-attempts it under QC's real all-orders read L2.
    const creatorRole = roleId === SYSTEM_ROLE_IDS.QC ? SYSTEM_ROLE_IDS.SALES_MANAGER : roleId;
    const f = await pending(`nonleader-${roleId}`, creatorRole);
    const signer = roleId === SYSTEM_ROLE_IDS.QC ? await actor(roleId, `nonleader-${roleId}-signer`) : f.actor;
    const before = await businessFacts(f);
    const context = await actionContext(f, signer);
    expect(context.status, diagnostic(context.body)).toBe(200);
    expect(context.body).toMatchObject({ ok: true, item: { canSign: false, allowedRoles: [] } });
    expect(context.body.item.blockedReasons).toContain('PP 样放行单签仅限当前业务领导、销售主管或老板');
    const role = roleId === SYSTEM_ROLE_IDS.QC ? 'production' : 'business';
    const rejected = await request(f.application.app).post(`/api/v1/releases/release-requests/${f.requestId}/signatures`)
      .set('Authorization', bearer(signer)).send(signBody(context.body.item, role));
    expect(rejected.status, diagnostic(rejected.body)).toBe(403);
    expect(errorCode(rejected)).toBe('FORBIDDEN');
    expect(await businessFacts(f)).toEqual(before);
    expect(f.application.changes.filter((change: any) => change.action === 'sign_release')).toEqual([]);
  });

  it.each([SYSTEM_ROLE_IDS.SALES_MANAGER, SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SUPER_ADMIN])('%s current canonical role can single-sign its own L2 order', async roleId => {
    // Sales managers have orders:write and may create the native fixture.
    // Admin and owner are leaders/signers but default to orders:read only;
    // have the manager create it, then prove those canonical sign-only roles
    // can read/sign it through their actual production-sign scope and L2.
    const f = await pending(`leader-${roleId}`, SYSTEM_ROLE_IDS.SALES_MANAGER);
    const signer = roleId === SYSTEM_ROLE_IDS.SALES_MANAGER ? f.actor : await actor(roleId, `leader-${roleId}-signer`);
    expect(signer.actor.permissions).toContain('production:pp_release:business_sign');
    if (roleId === SYSTEM_ROLE_IDS.ADMIN) expect(signer.actor.permissions).not.toContain('orders:write');
    const context = await actionContext(f, signer);
    expect(context.status, diagnostic(context.body)).toBe(200);
    expect(context.body.item.canSign).toBe(true);
    expect(context.body.item.allowedRoles).toContain('business');
    const response = await request(f.application.app).post(`/api/v1/releases/release-requests/${f.requestId}/signatures`)
      .set('Authorization', bearer(signer)).send(signBody(context.body.item, 'business'));
    expect(response.status, diagnostic(response.body)).toBe(200);
    expect(response.body.release.approvedBy).toBe(signer.id);
    expect(await db().releaseRequest.findUniqueOrThrow({ where: { id: f.requestId } })).toMatchObject({ state: 'granted' });
    expect(await db().releaseSignature.findMany({ where: { requestId: f.requestId } })).toMatchObject([
      expect.objectContaining({ role: 'business', actorId: signer.id }),
    ]);
    expect(await db().ppSampleRelease.findUniqueOrThrow({ where: { requestId: f.requestId } })).toMatchObject({
      approvedBy: signer.id, signedByBusiness: signer.id, signedByProduction: null,
    });
    expect((await db().releaseEvent.findMany({ where: { scopeId: f.scopeId } })).map(row => row.kind)).toEqual(['granted']);
  });

  it('commits one owner notification with the native production link and nudges only that canonical recipient', async () => {
    const f = await pending('durable-notification', SYSTEM_ROLE_IDS.SALES_MANAGER);
    const signer = await actor(SYSTEM_ROLE_IDS.ADMIN, 'durable-notification-signer');
    const context = await actionContext(f, signer);
    expect(context.status, diagnostic(context.body)).toBe(200);
    expect(context.body.item.canSign).toBe(true);
    const writes: string[] = [];
    const removeClient = addRealtimeClient({ write: (chunk: string) => { writes.push(chunk); return true; } } as any, f.actor.id);
    try {
      const signed = await request(f.application.app).post(`/api/v1/releases/release-requests/${f.requestId}/signatures`)
        .set('Authorization', bearer(signer)).send(signBody(context.body.item, 'business'));
      expect(signed.status, diagnostic(signed.body)).toBe(200);
      expect(signed.body.notificationStatus).toBe('persisted');
      const rows = await db().notification.findMany({ where: { userId: f.actor.id, type: 'pp_release_granted' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: `ntf_pp_release_granted_${f.requestId}`, userId: f.actor.id, type: 'pp_release_granted',
        title: `订单 ${f.id}-po 放行已批准`, link: `/orders?id=${f.orderId}&tab=production`,
        metadata: { orderId: f.orderId, requestId: f.requestId, releaseId: signed.body.release.id },
      });
      const notificationFrames = writes.filter(frame => frame.startsWith('event: notification'));
      expect(notificationFrames).toHaveLength(1);
      const payload = JSON.parse(notificationFrames[0].split('data: ')[1]);
      expect(payload).toMatchObject({ eventId: rows[0].id, eventType: 'pp_release_granted',
        recipientIds: [f.actor.id], link: `/orders?id=${f.orderId}&tab=production`,
        metadata: { orderId: f.orderId, requestId: f.requestId, releaseId: signed.body.release.id } });

      const retry = await request(f.application.app).post(`/api/v1/releases/release-requests/${f.requestId}/signatures`)
        .set('Authorization', bearer(signer)).send(signBody(context.body.item, 'business'));
      expect(retry.status, diagnostic(retry.body)).toBe(409);
      expect(await db().notification.count({ where: { userId: f.actor.id, type: 'pp_release_granted' } })).toBe(1);
      expect(writes.filter(frame => frame.startsWith('event: notification'))).toHaveLength(1);
    } finally { removeClient(); }
  });

  it('notification write failure rolls the approval facts back and leaves no employee handoff', async () => {
    const f = await pending('notification-rollback', SYSTEM_ROLE_IDS.SALES_MANAGER);
    const signer = await actor(SYSTEM_ROLE_IDS.ADMIN, 'notification-rollback-signer');
    const context = await actionContext(f, signer);
    expect(context.status, diagnostic(context.body)).toBe(200);
    const before = await businessFacts(f);
    await db().$executeRawUnsafe(`CREATE FUNCTION "${notificationFaultFunction}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'pp_release_granted' THEN RAISE EXCEPTION 'isolated acceptance notification fault'; END IF; RETURN NEW; END $$`);
    await db().$executeRawUnsafe(`CREATE TRIGGER "${notificationFaultTrigger}" BEFORE INSERT ON "Notification"
      FOR EACH ROW EXECUTE FUNCTION "${notificationFaultFunction}"()`);
    try {
      const rejected = await request(f.application.app).post(`/api/v1/releases/release-requests/${f.requestId}/signatures`)
        .set('Authorization', bearer(signer)).send(signBody(context.body.item, 'business'));
      expect(rejected.status, diagnostic(rejected.body)).toBe(500);
      expect(errorCode(rejected)).toBe('SIGN_FAILED');
      expect(JSON.stringify(rejected.body)).not.toContain('isolated acceptance notification fault');
      expect(await businessFacts(f)).toEqual(before);
      expect(await db().notification.count({ where: { userId: f.actor.id, type: 'pp_release_granted' } })).toBe(0);
    } finally { await dropNotificationFault(); }
  });

  it('a second manager with identical role grants but outside this order L2 cannot inspect or sign it', async () => {
    const owner = await pending('l2-owner', SYSTEM_ROLE_IDS.SALES_MANAGER);
    const outside = await actor(SYSTEM_ROLE_IDS.SALES_MANAGER, 'l2-outside');
    expect(outside.actor.permissions).toEqual(owner.actor.actor.permissions);
    const before = await businessFacts(owner);
    const context = await actionContext(owner, outside);
    expect(context.status).toBe(404);
    const bodyContext = await actionContext(owner);
    expect(bodyContext.status).toBe(200);
    const rejected = await request(owner.application.app).post(`/api/v1/releases/release-requests/${owner.requestId}/signatures`)
      .set('Authorization', bearer(outside)).send(signBody(bodyContext.body.item, 'business'));
    expect(rejected.status, diagnostic(rejected.body)).toBe(404);
    expect(errorCode(rejected)).toBe('ORDER_NOT_FOUND');
    expect(await businessFacts(owner)).toEqual(before);
    expect(owner.application.changes.filter((change: any) => change.action === 'sign_release')).toEqual([]);
  });

  it('removing the current leader role defeats the old JWT at HTTP and locked service checks without writes', async () => {
    const f = await pending('stale-role', SYSTEM_ROLE_IDS.SALES_MANAGER);
    const context = await actionContext(f);
    expect(context.status).toBe(200); expect(context.body.item.canSign).toBe(true);
    const before = await businessFacts(f);
    await db().userRole.deleteMany({ where: { userId: f.actor.id, roleId: SYSTEM_ROLE_IDS.SALES_MANAGER } });

    const oldJwtHttp = await request(f.application.app).post(`/api/v1/releases/release-requests/${f.requestId}/signatures`)
      .set('Authorization', bearer(f.actor)).send(signBody(context.body.item, 'business'));
    expect(oldJwtHttp.status).toBe(403); expect(errorCode(oldJwtHttp)).toBe('FORBIDDEN');

    const oldJwtService = await signReleaseRequest({ prisma: db(), requestId: f.requestId, role: 'business', actorId: f.actor.id,
      trustedActor: f.actor.actor, confirmedReviewedContent: true, expectedRequestRevision: context.body.item.request.requestRevision,
      expectedScopeRevision: context.body.item.request.scopeRevision, reviewContentFingerprint: context.body.item.reviewContentFingerprint });
    expect(oldJwtService).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', status: 403 } });
    expect(await businessFacts(f)).toEqual(before);
  });
});
