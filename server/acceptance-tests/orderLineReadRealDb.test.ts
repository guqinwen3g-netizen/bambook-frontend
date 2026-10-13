/**
 * Opt-in real PG read/L2 acceptance. Independent rules: actual Orders read
 * scope in docs/design/01-产品总览/6. 角色与权限矩阵.md; DR-042 §5.1/5.3
 * customer follow-up/share anchors, customerless legacy owner fallback.
 * The approved bounded read contract additionally requires current explicit
 * read permission even for a technical owner and preserves credential caps.
 *
 * Real JWT/employee-key binding loader/middleware/current grants/L2/PG rows.
 * SQL fault proxies only inject actual failed SELECTs, never fabricated rows
 * or authorization. No seed/index/scheduler/model/MCP/external action. No
 * shared DB; guard identity before ANY fixture mutation. Does not prove all
 * order readers, output sensitive-field contracts or company role grant UAT.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { getDefaultAgentApiKeyActors, setDefaultAgentApiKeyActors, loadAgentApiKeyActors } from '../src/auth/agentPrincipal';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';

const prefix = `acceptance-order-line-read-${randomUUID()}`, reviewerId = `${prefix}-reviewer`, apiKey = `${prefix}-credential`;
const auth = createAuthService();
let prisma: PrismaClient | undefined, counter = 0;
let previousBindings: ReturnType<typeof getDefaultAgentApiKeyActors>;
function db() { if (!prisma) throw Error('Independent OrderLine read client not initialized'); return prisma; }

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'independent PG identity before ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: reviewerId, displayName: 'Synthetic unrelated customer follower', status: 'active' } });
  for (const roleId of ['sales', 'owner', 'admin']) {
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
    expect(await db().rolePermission.count({ where: { roleId } }), 'fixture does not assume undisclosed default grants').toBe(0);
  }
});
beforeEach(() => { previousBindings = getDefaultAgentApiKeyActors(); setDefaultAgentApiKeyActors(new Map()); });
afterEach(() => { setDefaultAgentApiKeyActors(new Map(previousBindings)); });
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string, roleId = 'sales') {
  const id = `${prefix}-${++counter}-${label}`, userId = `${id}-user`, ownRelationId = `${id}-customer-own`,
    otherRelationId = `${id}-customer-other`, sharedRelationId = `${id}-customer-shared`, teamId = `${id}-team`, shareId = `${id}-share`;
  const ownOrderId = `${id}-order-own`, otherOrderId = `${id}-order-other`, sharedOrderId = `${id}-order-shared`,
    legacyOrderId = `${id}-order-legacy`, deletedOrderId = `${id}-order-deleted`;
  const orderIds = [ownOrderId, otherOrderId, sharedOrderId, legacyOrderId, deletedOrderId];
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic actual OrderLine read employee', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId } });
    await tx.userPermissionOverrides.create({ data: { id: `${id}-read-grant`, userId, scope: 'orders:read',
      grantedBy: reviewerId, reason: 'Synthetic current read grant, not company grant-policy proof' } });
    for (const [relationId, ownerId] of [[ownRelationId, userId], [otherRelationId, reviewerId], [sharedRelationId, reviewerId]]) {
      await tx.relation.create({ data: { id: relationId, name: relationId, category: 'Customer', type: 'Company', isOrganization: true,
        tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId, salesRepIds: [] } });
    }
    for (const [index, orderId] of orderIds.entries()) {
      await tx.order.create({ data: { id: orderId, poNumber: `${orderId}-po`, customer: `${orderId}-customer-name`,
        product: 'Synthetic fabric', type: 'fabric', quantity: 3, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 3,
        importedAt: BigInt(index === 0 ? 20 : index === 3 ? 10 : 30 + index),
        deletedAt: orderId === deletedOrderId ? BigInt(1) : null,
        customerRelationId: orderId === legacyOrderId ? null : orderId === otherOrderId ? otherRelationId : orderId === sharedOrderId ? sharedRelationId : ownRelationId,
        // Other customer's order was created by this employee; that is NOT L2.
        ownerId: orderId === ownOrderId || orderId === sharedOrderId ? reviewerId : userId } });
      await tx.orderLine.createMany({ data: [2, 1].map(lineNumber => ({ id: `${orderId}-line-${lineNumber}`, orderId, lineNumber,
        itemNo: `00${lineNumber}0`, quantity: lineNumber === 1 ? '1.2500' : '2.7500', unit: 'M' })) });
    }
    await tx.team.create({ data: { id: teamId, name: 'Synthetic actual employee team', status: 'active' } });
    await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
    await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: sharedRelationId,
      permission: 'read', grantedBy: reviewerId } });
  });
  const user = await loadUserWithRoles(db(), userId), actor = await buildLoadedAuthTokenPayload(db(), user);
  expect(actor.roles).toContain(roleId); expect(actor.permissions).toEqual(['orders:read']); expect(actor.authorizationLoaded).toBe(true);
  return { id, userId, actor, ownOrderId, otherOrderId, sharedOrderId, legacyOrderId, deletedOrderId, orderIds, teamId, shareId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application(client = db(), requireAuth = false) {
  const app = express(), changes: unknown[] = []; app.use(express.json());
  app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/order-lines', createOrderLinesRouter({ prisma: client, requireAuth, apiKeys: new Set([apiKey]), onDataChange: value => changes.push(value) }));
  return { app, changes };
}
function read(app: ReturnType<typeof application>, item: Fixture, orderId?: string, actor: TokenPayload = item.actor) {
  return request(app.app).get('/order-lines').query(orderId === undefined ? {} : { orderId }).set('Authorization', `Bearer ${auth.signToken(actor)}`);
}
async function snapshot(item: Fixture) {
  const lineIds = item.orderIds.flatMap(orderId => [1, 2].map(number => `${orderId}-line-${number}`));
  return { orders: await db().order.findMany({ where: { id: { in: item.orderIds } }, orderBy: { id: 'asc' } }),
    lines: await db().orderLine.findMany({ where: { orderId: { in: item.orderIds } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetId: { in: [...item.orderIds, ...lineIds] } }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { ownerId: { in: [...item.orderIds, ...lineIds] } }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { fromId: { in: [...item.orderIds, ...lineIds] } }, orderBy: { id: 'asc' } }) };
}
async function unchanged(item: Fixture, before: Awaited<ReturnType<typeof snapshot>>, app: ReturnType<typeof application>) {
  expect(await snapshot(item), 'GET cannot lazily initialize or change business data/success audits').toEqual(before); expect(app.changes).toEqual([]);
}
const code = (response: any) => response.body.error?.code ?? response.body.error;
async function bind(item: Fixture, ceiling?: string[]) {
  const previous = process.env.BAMBOOK_AGENT_API_KEY_MAP;
  try {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = `${apiKey}=${item.userId}`;
    const map = await loadAgentApiKeyActors(db(), new Set([apiKey]));
    expect(map.get(apiKey)).toMatchObject({ userId: item.userId, authorizationLoaded: true, permissions: ['orders:read'] });
    if (ceiling !== undefined) Object.assign(map.get(apiKey)!, { permissionCeiling: ceiling });
    setDefaultAgentApiKeyActors(map);
  } finally { if (previous === undefined) delete process.env.BAMBOOK_AGENT_API_KEY_MAP; else process.env.BAMBOOK_AGENT_API_KEY_MAP = previous; }
}
function sqlFault(modelName: 'userAccount' | 'userPermissionOverrides' | 'teamMember' | 'teamDataGrant' | 'relation' | 'orderLine') {
  let reached = false;
  const client = new Proxy(db(), { get(target, key) {
    if (key === modelName) return new Proxy(Reflect.get(target, key), { get(model, method) {
      if (method === (modelName === 'userAccount' ? 'findFirst' : 'findMany')) return async () => {
        reached = true; return target.$queryRaw`SELECT "missing_order_line_read_probe_column" FROM "UserAccount" LIMIT 1`;
      };
      const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client, reached: () => reached };
}

describe.each([false, true])('real PG OrderLine read configured auth=%s', configured => {
  it('JWT actual sales read + L2 excludes unrelated/deleted parents and preserves actual Decimal/DTO/order sorting', async () => {
    const item = await fixture('read-positive'), app = application(db(), configured), before = await snapshot(item);
    const response = await read(app, item, undefined, { ...item.actor, roles: [], permissions: [], authorizationLoaded: undefined });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.lines.map((line: any) => line.id)).toEqual([`${item.sharedOrderId}-line-1`, `${item.sharedOrderId}-line-2`,
      `${item.ownOrderId}-line-1`, `${item.ownOrderId}-line-2`, `${item.legacyOrderId}-line-1`, `${item.legacyOrderId}-line-2`]);
    expect(response.body.lines.find((line: any) => line.id === `${item.ownOrderId}-line-1`)).toMatchObject({ quantity: '1.25',
      poNumber: `${item.ownOrderId}-po`, customer: `${item.ownOrderId}-customer-name`, order: { id: item.ownOrderId } });
    const own = await read(app, item, ` ${item.ownOrderId} `); expect(own.status).toBe(200); expect(own.body.lines).toHaveLength(2);
    const other = await read(app, item, item.otherOrderId); expect(other.status).toBe(200); expect(other.body.lines).toEqual([]);
    await unchanged(item, before, app);
  });
  it('anonymous/body owner and unbound accepted key cannot list actual data', async () => {
    const item = await fixture('read-no-subject'), app = application(db(), configured), before = await snapshot(item);
    const anonymous = await request(app.app).get('/order-lines').send({ actor: item.actor }); expect(anonymous.status).toBe(401);
    const unbound = await request(app.app).get('/order-lines').set('X-Bambook-API-Key', apiKey); expect(unbound.status).toBe(401);
    await unchanged(item, before, app);
  });
  it('actual employee key binding retains the authenticated scoped read channel', async () => {
    const item = await fixture('read-key'), app = application(db(), configured), before = await snapshot(item); await bind(item);
    const response = await request(app.app).get('/order-lines').query({ orderId: item.ownOrderId }).set('X-Bambook-API-Key', apiKey);
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body.lines.map((line: any) => line.id)).toEqual([`${item.ownOrderId}-line-1`, `${item.ownOrderId}-line-2`]);
    const other = await request(app.app).get('/order-lines').query({ orderId: item.otherOrderId }).set('X-Bambook-API-Key', apiKey);
    expect(other.status).toBe(200); expect(other.body.lines).toEqual([]); await unchanged(item, before, app);
  });
});
describe('real PG OrderLine read revocation/cap/failure/purity', () => {
  it.each(['JWT', 'key'] as const)('%s stale read snapshot is rejected after actual DB grant revocation', async channel => {
    const item = await fixture(`read-revoke-${channel}`), app = application(), before = await snapshot(item); if (channel === 'key') await bind(item);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'orders:read' } }, data: { isActive: false } });
    const response = channel === 'JWT' ? await read(app, item) : await request(app.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); await unchanged(item, before, app);
  });
  it.each(['JWT', 'key'] as const)('%s read-only identity channel never ignores a write-only credential cap, even for owner', async channel => {
    const item = await fixture(`read-cap-${channel}`, 'owner'), app = application(), before = await snapshot(item); if (channel === 'key') await bind(item, ['orders:write']);
    const response = channel === 'JWT' ? await read(app, item, undefined, { ...item.actor, permissionCeiling: ['orders:write'] })
      : await request(app.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); await unchanged(item, before, app);
  });
  it('current owner role cannot restore an absent explicit read grant', async () => {
    const item = await fixture('read-owner-empty', 'owner'), app = application(), before = await snapshot(item);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'orders:read' } }, data: { isActive: false } });
    const response = await read(app, item); expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); await unchanged(item, before, app);
  });
  it('the actual current personal read grant expiry denies its previously successful JWT', async () => {
    const item = await fixture('read-expiry'), app = application(), before = await snapshot(item);
    const first = await read(app, item, item.ownOrderId); expect(first.status).toBe(200); expect(first.body.lines).toHaveLength(2);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'orders:read' } }, data: { expiresAt: new Date(0) } });
    const response = await read(app, item); expect(response.status).toBe(403); expect(code(response)).toBe('FORBIDDEN'); await unchanged(item, before, app);
  });
  it.each(['JWT', 'key'] as const)('%s actual account deactivation denies its previously legitimate read identity', async channel => {
    const item = await fixture(`read-inactive-${channel}`), app = application(), before = await snapshot(item); if (channel === 'key') await bind(item);
    await db().userAccount.update({ where: { id: item.userId }, data: { status: 'inactive' } });
    const response = channel === 'JWT' ? await read(app, item) : await request(app.app).get('/order-lines').set('X-Bambook-API-Key', apiKey);
    expect(response.status).toBe(401); expect(code(response)).toBe('ACCOUNT_DISABLED'); await unchanged(item, before, app);
  });
  it('shared-customer revoke is reflected on the next real read without the compatibility cache', async () => {
    const item = await fixture('read-share-revoke'), app = application(), before = await snapshot(item);
    const first = await read(app, item, item.sharedOrderId); expect(first.status).toBe(200); expect(first.body.lines).toHaveLength(2);
    await db().teamDataGrant.update({ where: { id: item.shareId }, data: { revokedAt: new Date(), revokedBy: reviewerId } });
    const second = await read(app, item, item.sharedOrderId); expect(second.status).toBe(200); expect(second.body.lines).toEqual([]); await unchanged(item, before, app);
  });
  it.each(['userAccount', 'userPermissionOverrides', 'teamMember', 'teamDataGrant', 'relation'] as const)('%s real SQL authorization/scope failure returns 503, no partial data/default authority', async model => {
    const item = await fixture(`read-sql-${model}`), before = await snapshot(item), probe = sqlFault(model), app = application(probe.client);
    const response = await read(app, item); expect(probe.reached()).toBe(true); expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(code(response)).toBe('AUTHORIZATION_UNAVAILABLE'); expect(JSON.stringify(response.body)).not.toContain('missing_order_line_read_probe_column'); await unchanged(item, before, app);
  });
  it('actual source list SQL failure remains a failed query instead of an empty successful list', async () => {
    const item = await fixture('read-source-sql'), before = await snapshot(item), probe = sqlFault('orderLine'), app = application(probe.client);
    const response = await read(app, item); expect(probe.reached()).toBe(true); expect(response.status).toBe(500); expect(code(response)).toBe('LIST_LINES_FAILED');
    expect(JSON.stringify(response.body)).not.toContain('missing_order_line_read_probe_column'); await unchanged(item, before, app);
  });
  it('actual all-scope admin read still requires read grant and excludes deleted parents', async () => {
    const item = await fixture('read-admin', 'admin'), before = await snapshot(item), app = application(), response = await read(app, item);
    expect(response.status).toBe(200);
    // Other independently prefixed probes may coexist in the same cluster.
    // An all-scope actor legitimately sees them; count only this fixture here.
    expect(response.body.lines.filter((line: any) => item.orderIds.includes(line.orderId))).toHaveLength(8);
    expect(response.body.lines.some((line: any) => line.orderId === item.deletedOrderId)).toBe(false);
    expect(response.body.lines.every((line: any) => line.order.deletedAt == null)).toBe(true);
    await unchanged(item, before, app);
  });
});
