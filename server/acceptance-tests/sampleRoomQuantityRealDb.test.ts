/**
 * Actual sample-room HTTP / current identity guards / isolated PostgreSQL.
 * DR-057 v2 keeps physical stock independent from logical colour cards; the
 * SampleCardItem Int inventory contract requires exact nonnegative integers.
 * Creation and its mandatory audit are a single action: audit SQL failure must
 * leave neither stock nor a success notification. Synthetic fixtures establish
 * these transport/storage invariants, not whole sample-room company-user UAT.
 * No seed, shared database, app bootstrap or scheduler is used.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createSampleRouter } from '../src/samples/sampleRoute';
import { SYSTEM_ROLE_IDS } from '../src/_shared/rolePermissionMatrix';

const prefix = `acceptance-sample-stock-${randomUUID()}`;
const path = '/api/v1/samples/room/items';
const directoryPath = '/api/v1/samples/room/custody-directory';
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
const db = () => { if (!prisma) throw new Error('isolated sample-stock fixture not initialized'); return prisma; };

async function actor(label: string, scopes: string[]) {
  const id = `${prefix}-${++sequence}-${label}`;
  // Standalone cards have no customer/case anchor, so creation requires the
  // canonical global-custody role. This synthetic identity exists only in the
  // isolated acceptance database and does not model a company employee.
  const roleId = scopes.includes('sample:room:write') ? SYSTEM_ROLE_IDS.SUPER_ADMIN : `${id}-configured-role`;
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: `Synthetic sample stock ${label}`, status: 'active' } });
    await tx.role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: `Synthetic sample stock ${label}`, isSystem: scopes.includes('sample:room:write') } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId: id, roleId } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await tx.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } },
        update: {}, create: { id: `${id}-${scope}`, roleId, permissionId: permission.id } });
    }
  });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current, 'fixture identity must have actually loaded current DB authorization').not.toBeNull();
  expect(current!.scopes).toEqual(scopes);
  return { id, token: auth.signToken({ userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true }) };
}
type Actor = Awaited<ReturnType<typeof actor>>;

function app(database: PrismaClient = db(), onDataChange = vi.fn()) {
  const result = express();
  result.use(express.json());
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  // The production sample route owns serializeValue, including BigInt output.
  result.use('/api/v1/samples', createSampleRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), onDataChange }));
  return result;
}
async function create(who: Actor, body: Record<string, unknown>, database: PrismaClient = db(), notify = vi.fn()) {
  return request(app(database, notify)).post(path).set('Authorization', `Bearer ${who.token}`).send(body);
}
async function directory(who: Actor, lane: string) {
  return request(app()).get(directoryPath).set('Authorization', `Bearer ${who.token}`).query({ lane, limit: 50, offset: 0, search: '', cardType: '' });
}
async function state() {
  return {
    items: await db().sampleCardItem.findMany({ where: { name: { startsWith: prefix } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { startsWith: prefix } }, orderBy: { id: 'asc' } }),
  };
}

describe.sequential('sample-room exact stock and mandatory creation audit in real PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    const name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    const port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
    expect(url.protocol).toBe('postgresql:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(port);
    expect(url.pathname).toBe(`/${name}`);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(directory)).toBe(true);
    expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify actual PG identity BEFORE any fixture write').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('SQ01 explicit zero is stored as zero stock and zero available stock with actual-actor audit', async () => {
    const who = await actor('zero', ['products:read', 'sample:room:write']);
    const notify = vi.fn();
    const response = await create(who, { name: `${prefix}-zero`, quantity: 0, minStock: 0, maxStock: 0, unit: 'PC', actorId: 'body-is-not-actor' }, db(), notify);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.item).toMatchObject({ quantity: 0, availableQty: 0, minStock: 0, maxStock: 0, unit: 'PC' });
    const stored = await db().sampleCardItem.findUniqueOrThrow({ where: { id: response.body.item.id } });
    expect(stored).toMatchObject({ quantity: 0, availableQty: 0, minStock: 0, maxStock: 0, unit: 'PC' });
    const audits = await db().auditLog.findMany({ where: { targetId: stored.id, action: 'sample_card_create' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: who.id, targetType: 'SampleCardItem', operationType: 'create' });
    expect((audits[0].detail as any).after).toMatchObject({ quantity: 0, name: stored.name });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ entity: 'samples', action: 'create_sample_card', ids: [stored.id] });
  });

  it('SQ02 positive quantity and zero minimum are preserved exactly in the real stock row', async () => {
    const who = await actor('positive', ['products:read', 'sample:room:write']);
    const response = await create(who, { name: `${prefix}-positive`, quantity: 8, minStock: 0, maxStock: 10, unit: 'SET' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await db().sampleCardItem.findUniqueOrThrow({ where: { id: response.body.item.id } }))
      .toMatchObject({ quantity: 8, availableQty: 8, minStock: 0, maxStock: 10, unit: 'SET' });
  });

  it('SQ03 only omitted quantity defaults to one; optional unknown bounds remain null', async () => {
    const who = await actor('omitted', ['products:read', 'sample:room:write']);
    const response = await create(who, { name: `${prefix}-omitted`, minStock: null, maxStock: null });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await db().sampleCardItem.findUniqueOrThrow({ where: { id: response.body.item.id } }))
      .toMatchObject({ quantity: 1, availableQty: 1, minStock: null, maxStock: null, unit: '张' });
  });

  it('SQ04 malformed, negative, fractional and Int-overflow quantities reject with no PG write or notification', async () => {
    const who = await actor('invalid-quantity', ['products:read', 'sample:room:write']);
    for (const quantity of [null, '', '1', -1, 0.5, 2147483648]) {
      const before = await state();
      const notify = vi.fn();
      const response = await create(who, { name: `${prefix}-invalid-quantity`, quantity }, db(), notify);
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error?.code).toBe('VALIDATION_FAILED');
      expect(await state()).toEqual(before);
      expect(notify).not.toHaveBeenCalled();
    }
    // JSON cannot encode NaN/Infinity; direct service unit cases cover them.
  });

  it('SD01 physical material lanes remain separate from the garment business owner through the HTTP route', async () => {
    const who = await actor('directory-lanes', ['products:read']);
    const relationId = `${prefix}-directory-customer`, orderId = `${prefix}-directory-order`, now = BigInt(Date.now());
    await db().$transaction(async tx => {
      await tx.relation.create({ data: { id: relationId, name: 'Synthetic directory owner', category: 'customer', type: 'company',
        isOrganization: true, ownerId: who.id, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
      await tx.order.create({ data: { id: orderId, customer: relationId, customerRelationId: relationId, product: 'Synthetic garment',
        type: 'garment', businessLine: 'garment', quantity: 1, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 1, ownerId: who.id, updatedAt: now } });
      for (const [label, cardType] of [['fabric-reference', 'fabric'], ['garment-piece', 'garment'], ['color-card', 'colorcard']]) {
        await tx.sampleCardItem.create({ data: { id: `${prefix}-${label}`, code: `${prefix}-${label}`, name: `${prefix}-${label}`,
          cardType, orderId, status: 'in_stock', quantity: 1, availableQty: 1, unit: 'PC', createdAt: now, updatedAt: now } });
      }
    });

    const [fabric, garment, other] = await Promise.all([directory(who, 'fabric'), directory(who, 'garment'), directory(who, 'other')]);
    expect(fabric.status, JSON.stringify(fabric.body)).toBe(200);
    expect(fabric.body).toMatchObject({ directoryVersion: 2, lane: 'fabric', total: 1, items: [{ card: { id: `${prefix}-fabric-reference`, cardType: 'fabric' }, businessContext: { status: 'resolved', businessLine: 'garment' } }] });
    expect(garment.status, JSON.stringify(garment.body)).toBe(200);
    expect(garment.body).toMatchObject({ lane: 'garment', total: 1, items: [{ card: { id: `${prefix}-garment-piece`, cardType: 'garment' }, businessContext: { status: 'resolved', businessLine: 'garment' } }] });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body).toMatchObject({ lane: 'other', total: 1, items: [{ card: { id: `${prefix}-color-card`, cardType: 'colorcard' }, businessContext: { status: 'resolved', businessLine: 'garment' } }] });
    const obsolete = await request(app()).get(directoryPath).set('Authorization', `Bearer ${who.token}`).query({ scope: 'garment' });
    expect(obsolete.status).toBe(400);
  });

  it('SQ05 invalid optional bounds or reversed bounds never write stock/audit', async () => {
    const who = await actor('invalid-bounds', ['products:read', 'sample:room:write']);
    for (const bounds of [{ minStock: -1 }, { maxStock: '' }, { minStock: 0.5 }, { maxStock: 2147483648 }, { minStock: 2, maxStock: 1 }]) {
      const before = await state();
      const response = await create(who, { name: `${prefix}-invalid-bound`, quantity: 1, ...bounds });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error?.code).toBe('VALIDATION_FAILED');
      expect(await state()).toEqual(before);
    }
  });

  it('SQ06 unsupported explicit units reject; existing measured/count unit labels are preserved', async () => {
    const who = await actor('units', ['products:read', 'sample:room:write']);
    for (const unit of ['', null, 'PC-unknown', 'long-unit-is-never-truncated']) {
      const before = await state();
      const response = await create(who, { name: `${prefix}-invalid-unit`, quantity: 1, unit });
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(await state()).toEqual(before);
    }
    for (const unit of ['YD', 'M', 'KG', '米']) {
      const response = await create(who, { name: `${prefix}-valid-unit-${unit}`, quantity: 1, unit });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect((await db().sampleCardItem.findUniqueOrThrow({ where: { id: response.body.item.id } })).unit).toBe(unit);
    }
    // This does not prove conversion of received decimal yardage into card stock.
  });

  it('SQ07 loaded empty permissions cannot write sample stock or audit', async () => {
    const who = await actor('no-grant', []);
    const before = await state();
    const notify = vi.fn();
    const response = await create(who, { name: `${prefix}-no-grant`, quantity: 1 }, db(), notify);
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await state()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('SQ08 actual mandatory-audit SQL FK failure rolls back the already inserted stock and sends no success event', async () => {
    const who = await actor('audit-fault', ['products:read', 'sample:room:write']);
    const before = await state();
    const notify = vi.fn();
    let insertedId: string | undefined;
    let itemSeenInsideTransaction = false;
    let sqlCode: string | undefined;
    let injections = 0;
    const faultClient = new Proxy(db(), { get(target, property) {
      if (property === '$transaction') return (callback: any, options: any) => target.$transaction(async tx => {
        const audit = new Proxy(tx.auditLog, { get(delegate, key) {
          if (key === 'create') return async (args: any) => {
            if (args.data.action !== 'sample_card_create') return delegate.create(args);
            injections++;
            insertedId = args.data.targetId;
            itemSeenInsideTransaction = !!(await tx.sampleCardItem.findUnique({ where: { id: insertedId } }));
            try { return await delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } }); }
            catch (error: any) { sqlCode = error?.code; throw error; }
          };
          const value = Reflect.get(delegate, key); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const guardedTx = new Proxy(tx, { get(client, key) { if (key === 'auditLog') return audit;
          const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value; } });
        return callback(guardedTx);
      }, options);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } }) as PrismaClient;
    const response = await create(who, { name: `${prefix}-real-audit-fault`, quantity: 8, unit: 'PC' }, faultClient, notify);
    expect(injections, 'reach the required audit after a real SQL stock insertion').toBe(1);
    expect(itemSeenInsideTransaction).toBe(true);
    expect(sqlCode, 'real SQL foreign-key failure, never a synthetic thrown error').toBe('P2003');
    expect(response.status, JSON.stringify(response.body)).toBe(500);
    expect(response.body.error?.code).toBe('INTERNAL_ERROR');
    expect(await state()).toEqual(before);
    expect(await db().sampleCardItem.findUnique({ where: { id: insertedId! } })).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    console.log(JSON.stringify({ probe: 'sample-room-create-audit-atomicity', sqlCode, injections,
      itemSeenInsideTransaction, http: response.status, pgFixtureStateUnchanged: true, successEvents: notify.mock.calls.length }));
  });
});
