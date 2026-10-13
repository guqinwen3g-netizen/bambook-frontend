/** Opt-in, isolated PG only. Independent rules: the role/scope matrix and
 * DR042 customer-anchored Orders L2; dictionary:write governs global metadata.
 * Actual router, signed identity, current grants/cap, PG locks and mandatory
 * audit FK/rollback are exercised. No seed, index, scheduler or shared DB.
 * This is not proof of the frontend button gating, production deployment,
 * global Orders write policy or PDML; the parent owns immutable execution. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createBusinessLineRouter } from '../src/businessLines/businessLineRoute';

const prefix = `acceptance-business-line-${randomUUID()}`, auth = createAuthService();
const grantor = `${prefix}-grantor`, key = `${prefix}-key`;
let prisma: PrismaClient | undefined, seq = 0;
function db() { if (!prisma) throw Error('Independent BusinessLine client not initialized'); return prisma; }

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated acceptance database is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'Actual PG identity before any fixture write').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: grantor, displayName: 'Synthetic grantor', status: 'active' } });
  await db().role.upsert({ where: { id: 'owner' }, update: {}, create: { id: 'owner', name: 'Synthetic canonical owner', isSystem: true } });
});
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string, options: { scopes?: string[]; owner?: boolean; hidden?: boolean } = {}) {
  const id = `${prefix}-${++seq}-${label}`, userId = `${id}-user`, roleId = options.owner ? 'owner' : `${id}-custom-role`,
    relationId = `${id}-customer`, orderId = `${id}-order`, businessLineId = `${id}-line`,
    code = `bl_${randomUUID().replace(/-/g, '_')}`;
  const scopes = options.scopes ?? ['orders:read', 'orders:write', 'dictionary:write'];
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic current business-line operator', status: 'active' } });
    if (!options.owner) await tx.role.create({ data: { id: roleId, name: 'Synthetic business-line operator', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId } });
    await tx.userPermissionOverrides.createMany({ data: scopes.map(scope => ({ id: `${id}-grant-${scope}`, userId,
      scope, isActive: true, grantedBy: grantor, reason: 'Explicit isolated fixture grant' })) });
    await tx.relation.create({ data: { id: relationId, name: `${id}-customer`, category: 'Customer', type: 'Company',
      isOrganization: true, contactInfo: '{}', tags: [], lastInteraction: BigInt(Date.now()),
      ownerId: options.hidden ? grantor : userId, salesRepIds: [] } });
    await tx.order.create({ data: { id: orderId, customer: `${id}-customer`, product: 'Synthetic fabric', type: 'fabric',
      quantity: 20, status: 'InProduction', dueDate: '2099-01-01', quoteAmount: 123.45,
      customerRelationId: relationId, ownerId: userId, updatedAt: BigInt(Date.now()) } });
    await tx.businessLine.create({ data: { id: businessLineId, code, name: 'Synthetic business-line source',
      moqValue: 30, moqUnit: 'M', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  });
  const user = await loadUserWithRoles(db(), userId); expect(user?.status).toBe('active');
  const actor = await buildLoadedAuthTokenPayload(db(), user);
  expect(actor.permissions).toEqual([...scopes].sort());
  if (!options.owner) { expect(actor.roles).toEqual([]); expect(actor.roleIds).toEqual([roleId]); }
  return { id, userId, roleId, relationId, orderId, businessLineId, code, actor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application(client: PrismaClient, actor?: TokenPayload) {
  const app = express(), changes: any[] = [], actors = new Map<string, TokenPayload>();
  if (actor) actors.set(key, actor);
  app.use(express.json());
  app.use(createAccountStatusGuard(client));
  app.use(createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set([key]), apiKeyActors: actors }));
  app.use('/business-lines', createBusinessLineRouter({ prisma: client, requireAuth: true, apiKeys: new Set([key]),
    apiKeyActors: actors, onDataChange: event => changes.push(event) }));
  return { app, changes };
}
function http(item: Fixture, app: ReturnType<typeof application>, method: 'get' | 'put' | 'post' | 'patch' | 'delete',
  endpoint: string, actor = item.actor) {
  return request(app.app)[method](endpoint).set('Authorization', `Bearer ${auth.signToken(actor)}`);
}
async function snapshot(item: Fixture) {
  return { order: await db().order.findUniqueOrThrow({ where: { id: item.orderId } }),
    lines: await db().businessLine.findMany({ where: { OR: [{ id: item.businessLineId }, { code: { startsWith: item.code } }] }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { OR: [{ targetId: item.orderId }, { targetId: item.businessLineId },
      { actorId: item.userId, targetType: 'BusinessLine' }] }, orderBy: { id: 'asc' } }) };
}
async function unchanged(item: Fixture, before: Awaited<ReturnType<typeof snapshot>>, app: ReturnType<typeof application>) {
  expect(await snapshot(item), 'Rejected operation must not change any business row or success audit').toEqual(before);
  expect(app.changes, 'No notification before business commit').toEqual([]);
}
const responseCode = (r: any) => r.body.error?.code ?? r.body.error;
type Probe = { beforeTransaction?: () => Promise<void>; afterBusinessLineLock?: () => Promise<void>; auditFault?: boolean; authFault?: boolean;
  reached?: boolean; actualCode?: string };
/** Both injected failures execute real SQL on the actual interactive tx. No
 * throw/stub substitutes for a P2003 FK fault or permission-read SQL fault. */
function intercepted(probe: Probe): PrismaClient {
  let prepared = false, lockObserved = false;
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return async (work: any, options?: any) => {
      if (typeof work !== 'function') return (client.$transaction as any)(work, options);
      if (!prepared) { prepared = true; await probe.beforeTransaction?.(); }
      return client.$transaction(async tx => work(new Proxy(tx, { get(transaction, delegate) {
        if (delegate === '$queryRaw' && probe.afterBusinessLineLock) return async (...args: any[]) => {
          const rows = await (transaction.$queryRaw as any)(...args);
          if (!lockObserved && args[0]?.strings?.join(' ').includes('"BusinessLine"') && rows.length) {
            lockObserved = true; await probe.afterBusinessLineLock?.();
          }
          return rows;
        };
        if ((delegate === 'auditLog' && probe.auditFault) || (delegate === 'userPermissionOverrides' && probe.authFault)) {
          const model: any = Reflect.get(transaction, delegate);
          return new Proxy(model, { get(real, method) {
            if (delegate === 'auditLog' && method === 'create') return async (args: any) => {
              probe.reached = true;
              try { return await real.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } }); }
              catch (error: any) { probe.actualCode = error.code; throw error; }
            };
            if (delegate === 'userPermissionOverrides' && method === 'findMany') return async () => {
              probe.reached = true;
              try { return await transaction.$queryRaw`SELECT "missing_business_line_authorization_column" FROM "UserAccount" LIMIT 1`; }
              catch (error: any) { probe.actualCode = error.code; throw error; }
            };
            const value = Reflect.get(real, method); return typeof value === 'function' ? value.bind(real) : value;
          } });
        }
        const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), { ...options, timeout: 20_000 });
    };
    const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value;
  } });
}

describe('actual isolated PG BusinessLine authority and transaction boundaries', () => {
  it('BA01 explicit custom-role grants permit scoped assignment/MOQ and audited dictionary CRUD', async () => {
    const item = await fixture('positive'), app = application(db());
    const created = await http(item, app, 'post', '/business-lines').send({ code: `${item.code}_new`, name: 'Real route-created line' });
    expect(created.status, JSON.stringify(created.body)).toBe(201); expect(created.body.item.auditId).toBeTruthy();
    const set = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code, actorId: grantor });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(Object.keys(set.body.item).sort()).toEqual(['auditId', 'businessLine', 'id', 'updatedAt']);
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: set.body.item.auditId } });
    expect(audit.actorId).toBe(item.userId); expect(audit.action).toBe('set_order_business_line');
    expect(audit.detail).toMatchObject({ source: 'business-lines', before: { businessLine: null }, after: { businessLine: item.code } });
    const moq = await http(item, app, 'get', `/business-lines/order/${item.orderId}/moq-check`);
    expect(moq.status).toBe(200); expect(moq.body).toMatchObject({ checked: true, quantity: 20, compliant: false });
    expect((await http(item, app, 'patch', `/business-lines/${created.body.item.id}`).send({ name: 'Updated actual source' })).status).toBe(200);
    expect((await http(item, app, 'delete', `/business-lines/${created.body.item.id}`)).status).toBe(200);
    expect((await db().businessLine.findUniqueOrThrow({ where: { id: created.body.item.id } })).deletedAt).not.toBeNull();
    expect(app.changes).toHaveLength(4);
  });
  it('BA02 no configured scopes cannot be replaced by old signed owner/default roles or body authority', async () => {
    const item = await fixture('empty', { scopes: [] }), app = application(db()), before = await snapshot(item);
    const old = { ...item.actor, roles: ['owner'] as TokenPayload['roles'], permissions: [], authorizationLoaded: undefined };
    for (const [method, endpoint, body] of [['get', '/business-lines', undefined],
      ['get', `/business-lines/order/${item.orderId}/moq-check`, undefined],
      ['put', `/business-lines/order/${item.orderId}`, { businessLine: item.code, roles: ['owner'] }],
      ['post', '/business-lines', { code: `${item.code}_new`, name: 'Forbidden' }]] as const) {
      const response = await http(item, app, method, endpoint, old).send(body);
      expect(response.status).toBe(403); expect(responseCode(response)).toBe('FORBIDDEN');
    }
    await unchanged(item, before, app);
  });
  it('BA03 disabled and expired action grants never restore stale JWT permissions', async () => {
    for (const expired of [false, true]) {
      const item = await fixture(`revoked-${expired}`), app = application(db()), before = await snapshot(item);
      await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'orders:write' } },
        data: expired ? { expiresAt: new Date(Date.now() - 60_000) } : { isActive: false } });
      const response = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code });
      expect(response.status).toBe(403); await unchanged(item, before, app);
      expect((await http(item, app, 'get', `/business-lines/order/${item.orderId}/moq-check`)).status).toBe(200);
    }
  });
  it('BA04 real owner cannot exceed a signed read-only credential ceiling for order or dictionary writes', async () => {
    const item = await fixture('capped-owner', { owner: true }), app = application(db()), before = await snapshot(item);
    const capped = { ...item.actor, permissionCeiling: ['orders:read'] };
    expect((await http(item, app, 'get', `/business-lines/order/${item.orderId}/moq-check`, capped)).status).toBe(200);
    expect((await http(item, app, 'put', `/business-lines/order/${item.orderId}`, capped).send({ businessLine: item.code })).status).toBe(403);
    expect((await http(item, app, 'patch', `/business-lines/${item.businessLineId}`, capped).send({ name: 'Forbidden' })).status).toBe(403);
    await unchanged(item, before, app);
  });
  it('BA05 parent ownerId does not disclose or mutate an unrelated existing customer business subtree', async () => {
    const item = await fixture('hidden-parent', { hidden: true }), app = application(db()), before = await snapshot(item);
    expect((await http(item, app, 'get', `/business-lines/order/${item.orderId}/moq-check`)).status).toBe(404);
    expect((await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code })).status).toBe(404);
    await unchanged(item, before, app);
  });
  it('BA06 scope withdrawal after HTTP preflight is rechecked inside the locked parent transaction', async () => {
    const item = await fixture('transaction-revoke'), before = await snapshot(item);
    const probe: Probe = { beforeTransaction: async () => { await db().userPermissionOverrides.update({
      where: { userId_scope: { userId: item.userId, scope: 'orders:write' } }, data: { isActive: false } }); } };
    const app = application(intercepted(probe));
    const response = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code });
    expect(response.status, JSON.stringify(response.body)).toBe(403); await unchanged(item, before, app);
  });
  it('BA07 stopped or soft-deleted accounts cannot use a still-valid old session', async () => {
    for (const deleted of [false, true]) {
      const item = await fixture(`inactive-${deleted}`), app = application(db()), before = await snapshot(item);
      await db().userAccount.update({ where: { id: item.userId }, data: deleted ? { deletedAt: BigInt(Date.now()) } : { status: 'disabled' } });
      const response = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code });
      expect(response.status).toBe(401); await unchanged(item, before, app);
    }
  });
  it('BA08 mapped key read uses actual current scopes/cap; keys cannot perform JWT-only writes', async () => {
    const item = await fixture('api-key'), app = application(db(), { ...item.actor, permissionCeiling: ['orders:read'] });
    const before = await snapshot(item);
    expect((await request(app.app).get('/business-lines').set('X-Bambook-API-Key', key)).status).toBe(200);
    expect((await request(app.app).get(`/business-lines/order/${item.orderId}/moq-check`).set('X-Bambook-API-Key', key)).status).toBe(200);
    expect((await request(app.app).put(`/business-lines/order/${item.orderId}`).set('X-Bambook-API-Key', key).send({ businessLine: item.code })).status).toBe(401);
    expect((await request(application(db()).app).get('/business-lines').set('X-Bambook-API-Key', key)).status).toBe(403);
    await unchanged(item, before, app);
  });
  it('BA09 actual mandatory audit FK failure rolls back order, registry create/update/delete and notifications', async () => {
    for (const action of ['order', 'create', 'update', 'delete'] as const) {
      const item = await fixture(`audit-${action}`), before = await snapshot(item), probe: Probe = { auditFault: true };
      const app = application(intercepted(probe));
      const response = action === 'order' ? await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code })
        : action === 'create' ? await http(item, app, 'post', '/business-lines').send({ code: `${item.code}_new`, name: 'Rollback fixture' })
        : action === 'update' ? await http(item, app, 'patch', `/business-lines/${item.businessLineId}`).send({ name: 'Rollback fixture' })
        : await http(item, app, 'delete', `/business-lines/${item.businessLineId}`);
      expect(probe.reached, 'Actual PG audit insert must be reached').toBe(true); expect(probe.actualCode).toBe('P2003');
      expect(response.status, JSON.stringify(response.body)).toBe(500); expect(responseCode(response)).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('Foreign key'); await unchanged(item, before, app);
    }
  });
  it('BA10 actual transaction authorization SQL failure fails closed instead of restoring defaults', async () => {
    const item = await fixture('auth-sql'), before = await snapshot(item), probe: Probe = { authFault: true };
    const app = application(intercepted(probe));
    const response = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code });
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2010');
    expect(response.status, JSON.stringify(response.body)).toBe(503); expect(responseCode(response)).toBe('AUTHORIZATION_UNAVAILABLE');
    await unchanged(item, before, app);
  });
  it('BA11 shared business history permits reading, but only a current creator/follow-up may edit the Order', async () => {
    const item = await fixture('read-share', { hidden: true }), teamId = `${item.id}-team`, app = application(db());
    await db().$transaction(async tx => {
      await tx.order.update({ where: { id: item.orderId }, data: { ownerId: grantor } });
      await tx.team.create({ data: { id: teamId, name: 'Synthetic read-only customer sharing', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${item.id}-member`, teamId, userId: item.userId } });
      await tx.teamDataGrant.create({ data: { id: `${item.id}-share`, teamId, entityType: 'relation',
        entityId: item.relationId, permission: 'read', grantedBy: grantor } });
    });
    const before = await snapshot(item);
    expect((await http(item, app, 'get', `/business-lines/order/${item.orderId}/moq-check`)).status).toBe(200);
    expect((await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code })).status).toBe(403);
    await unchanged(item, before, app);
    await db().teamDataGrant.update({ where: { id: `${item.id}-share` }, data: { permission: 'read+followup' } });
    expect((await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code })).status).toBe(403);
    await unchanged(item, before, app);
    // The actual customer follow-up changes, not a guessed team permission.
    await db().relation.update({ where: { id: item.relationId }, data: { salesRepIds: [item.userId] } });
    const allowed = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect((await db().auditLog.findUniqueOrThrow({ where: { id: allowed.body.item.auditId } })).actorId).toBe(item.userId);
  });
  it('BA12 actual action withdrawal after acquiring the registry lock still prevents mutation', async () => {
    const item = await fixture('registry-lock-revoke'), before = await snapshot(item);
    const probe: Probe = { afterBusinessLineLock: async () => {
      probe.reached = true;
      await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'orders:write' } }, data: { isActive: false } });
    } };
    const app = application(intercepted(probe));
    const response = await http(item, app, 'put', `/business-lines/order/${item.orderId}`).send({ businessLine: item.code });
    expect(probe.reached).toBe(true); expect(response.status, JSON.stringify(response.body)).toBe(403);
    await unchanged(item, before, app);
  });
});
