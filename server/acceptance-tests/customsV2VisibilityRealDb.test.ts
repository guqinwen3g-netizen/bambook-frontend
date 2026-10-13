/** Actual independent PG + native V2 read routes. Synthetic scopes exercise the
 * existing Orders/ShipmentAllocation contract; they do not define company roles. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createCustomsV2Router } from '../src/customs/customsRouteV2';

let prisma: PrismaClient | undefined, counter = 0;
const prefix = `acceptance-customs-v2-${randomUUID()}`, reviewerId = `${prefix}-reviewer`;
function db() { if (!prisma) throw Error('Independent native read client not initialized'); return prisma; }
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres')); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  expect(identity, 'actual PG identity before ANY mutation').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: reviewerId, displayName: 'Synthetic independent reviewer', status: 'active' } });
  for (const roleId of ['sales', 'finance', 'owner']) {
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
    expect(await db().rolePermission.count({ where: { roleId } }), 'no hidden fixture grants').toBe(0);
  }
});
afterAll(async () => { await prisma?.$disconnect(); });
async function fixture() {
  const id = `${prefix}-${++counter}`, userId = `${id}-user`, orderIds = ['own', 'other', 'shared'].map(n => `${id}-order-${n}`);
  const customers = ['own', 'other', 'shared'].map(n => `${id}-customer-${n}`), shareId = `${id}-share`;
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic current sales', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'sales' } });
    await tx.userPermissionOverrides.create({ data: { id: `${id}-read`, userId, scope: 'customs:read', grantedBy: reviewerId,
      reason: 'Synthetic explicit grant, not company authorization policy' } });
    for (const [index, customer] of customers.entries()) {
      await tx.relation.create({ data: { id: customer, name: customer, category: 'Customer', type: 'Company', isOrganization: true,
        tags: [], contactInfo: '{}', lastInteraction: BigInt(1), ownerId: index === 0 ? userId : reviewerId, salesRepIds: [] } });
      await tx.order.create({ data: { id: orderIds[index], poNumber: `${orderIds[index]}-PO`, customer, product: 'Synthetic fabric',
        type: 'fabric', quantity: 3, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 3, importedAt: BigInt(1),
        customerRelationId: customer, ownerId: index === 1 ? userId : reviewerId } });
    }
    await tx.team.create({ data: { id: `${id}-team`, name: `${id}-team`, status: 'active' } });
    await tx.teamMember.create({ data: { id: `${id}-member`, teamId: `${id}-team`, userId } });
    await tx.teamDataGrant.create({ data: { id: shareId, teamId: `${id}-team`, entityType: 'relation', entityId: customers[2], permission: 'read', grantedBy: reviewerId } });
    for (const shipment of ['multi', 'hidden']) await tx.shipment.create({ data: { id: `${id}-shipment-${shipment}`, shipmentNumber: `${id}-SHP-${shipment}`,
      type: 'Export', status: 'Draft', shippingMethod: 'Sea', orderId: orderIds[1], createdAt: BigInt(1), updatedAt: BigInt(1) } });
    for (const [index, [shipment, orderId]] of [['multi', orderIds[0]], ['multi', orderIds[1]], ['hidden', orderIds[1]]].entries())
      await tx.shipmentOrderAllocation.create({ data: { id: `${id}-alloc-${index}`, shipmentId: `${id}-shipment-${shipment}`, orderId,
        status: 'Planned', plannedQty: '1', unit: 'M', createdAt: BigInt(1), updatedAt: BigInt(1) } });
    for (const [index, [name, orderId, shipmentId]] of [
      ['own', orderIds[0], null], ['shared', orderIds[2], null], ['other', orderIds[1], null],
      ['multi', null, `${id}-shipment-multi`], ['projection', orderIds[1], `${id}-shipment-multi`], ['hidden', null, `${id}-shipment-hidden`],
    ].entries()) await tx.customsDeclaration.create({ data: { id: `${id}-declaration-${name}`, declarationNumber: `${id}-CD-${name}`,
      orderId, shipmentId, type: 'Export', status: 'Draft', createdAt: BigInt(index), updatedAt: BigInt(index) } });
  });
  const token = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  return { id, userId, orderIds, customers, shareId, token };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function app(client: any = db()) {
  const result = express(); result.set('json replacer', (_: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  // Production index refreshes signed authority before mounting domain routes.
  // Omitting that real composition guard would only test a legacy standalone router.
  result.use('/customs', createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set(), apiKeyActors: new Map() }));
  result.use('/customs', createCustomsV2Router({ prisma: client, requireAuth: true, apiKeys: new Set() })); return result;
}
function get(f: Fixture, suffix = '', query: any = { search: f.id }, client: any = db(), token = f.token) {
  return request(app(client)).get(`/customs/declarations${suffix}`).query(query).set('Authorization', `Bearer ${createAuthService().signToken(token)}`);
}
async function snapshot(f: Fixture) {
  return { declarations: await db().customsDeclaration.findMany({ where: { declarationNumber: { contains: f.id } }, orderBy: { id: 'asc' } }),
    allocations: await db().shipmentOrderAllocation.findMany({ where: { orderId: { in: f.orderIds } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.userId } }) };
}
function fault(modelName: string, method = 'findMany') {
  let reached = false;
  const client = new Proxy(db(), { get(target, key) {
    if (key === modelName) return new Proxy(Reflect.get(target, key), { get(delegate, member) {
      if (member === method) return async () => { reached = true; return target.$queryRaw`SELECT "missing_customs_v2_read_column" FROM "UserAccount" LIMIT 1`; };
      const value = Reflect.get(delegate, member); return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client, reached: () => reached };
}
describe('actual native V2 declaration visibility', () => {
  it('list/count/page and multi-order projection use real customer/shared/allocation anchors without writes', async () => {
    const f = await fixture(), before = await snapshot(f), result = await get(f);
    expect(result.status).toBe(200); expect(result.body.total).toBe(4);
    expect(result.body.items.map((x: any) => x.id).sort()).toEqual(['own', 'shared', 'multi', 'projection'].map(n => `${f.id}-declaration-${n}`).sort());
    const page = await get(f, '', { search: f.id, limit: 1, offset: 1 }); expect(page.status).toBe(200); expect(page.body.total).toBe(4); expect(page.body.items).toHaveLength(1);
    for (const n of ['own', 'shared', 'multi', 'projection']) expect((await get(f, `/${f.id}-declaration-${n}`, {})).status).toBe(200);
    expect(await snapshot(f)).toEqual(before);
  });
  it('guessed foreign/missing IDs both deny with safe404 and preserve the public string error shape', async () => {
    const f = await fixture(), before = await snapshot(f);
    for (const n of ['other', 'hidden', 'missing']) {
      const result = await get(f, `/${f.id}-declaration-${n}`, {}); expect(result.status).toBe(404); expect(typeof result.body.error).toBe('string');
      expect(result.body).not.toHaveProperty('item'); expect(result.body.error).not.toContain('Prisma');
    }
    expect(await snapshot(f)).toEqual(before);
  });
  it('actual share and customer follower revocation affect already-signed native reads immediately', async () => {
    const f = await fixture(); expect((await get(f)).body.total).toBe(4);
    await db().teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date() } });
    expect((await get(f, `/${f.id}-declaration-shared`, {})).status).toBe(404);
    await db().relation.update({ where: { id: f.customers[0] }, data: { ownerId: reviewerId } });
    expect((await get(f)).body.total).toBe(0); expect((await get(f, `/${f.id}-declaration-projection`, {})).status).toBe(404);
  });
  it('current all-scope finance reads remain legal; a limited signed credential still denies', async () => {
    const f = await fixture(); await db().userRole.update({ where: { id: `${f.id}-role` }, data: { roleId: 'finance' } });
    expect((await get(f)).body.total).toBe(6);
    const limited = { ...f.token, permissionCeiling: ['orders:read'] };
    expect((await get(f, '', { search: f.id }, db(), limited)).status).toBe(403);
  });
  it('current grant withdrawal denies before the query even with the old signed token', async () => {
    const f = await fixture(), before = await snapshot(f);
    await db().userPermissionOverrides.update({ where: { id: `${f.id}-read` }, data: { isActive: false } });
    await db().userRole.deleteMany({ where: { userId: f.userId } });
    expect((await get(f)).status).toBe(403); expect(await snapshot(f)).toEqual(before);
  });
  it.each(['', '/detail'])('actual failed allocation SELECT on %s is safe503, never partial/empty success', async kind => {
    const f = await fixture(), before = await snapshot(f), injected = fault('shipmentOrderAllocation');
    const result = await get(f, kind ? `/${f.id}-declaration-own` : '', kind ? {} : { search: f.id }, injected.client);
    expect(result.status).toBe(503); expect(typeof result.body.error).toBe('string'); expect(result.body.error).not.toContain('missing_customs');
    expect(injected.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
  it.each(['findMany', 'findFirst'])('actual failed declaration %s SELECT is safe500 and zero write', async method => {
    const f = await fixture(), before = await snapshot(f), injected = fault('customsDeclaration', method);
    const result = await get(f, method === 'findFirst' ? `/${f.id}-declaration-own` : '', method === 'findFirst' ? {} : { search: f.id }, injected.client);
    expect(result.status).toBe(500); expect(result.body.error).toBe('服务器内部错误，请稍后重试。');
    expect(injected.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
});
