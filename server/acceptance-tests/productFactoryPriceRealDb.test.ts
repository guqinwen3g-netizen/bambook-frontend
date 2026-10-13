/** Real Products HTTP/current DB authorization and real Agent dispatch/isolated PG.
 * Synthetic actors demonstrate purchase-price boundaries, not company-user UAT.
 * Purchase/factory price is sensitive:cost; commercial/sample/cutting prices and
 * garment targetCost/trimming general price are deliberately separate facts.
 * No seed, scheduler, app bootstrap, shared DB or cleanup-by-delete.
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
import { createProductsRouter } from '../src/products/route';
import { createIdentityService } from '../src/agent/identity';
import { executeAgentTool } from '../src/agent/toolRuntime';

const prefix = `acceptance-product-purchase-${randomUUID()}`;
const path = '/api/v1/products/assets';
let prisma: PrismaClient | undefined;
let sequence = 0;
const auth = createAuthService();
const db = () => { if (!prisma) throw Error('isolated purchase fixture not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_k, item) => typeof item === 'bigint' ? item.toString() : item);
async function actor(label: string, scopes: string[], owner = false, ceiling?: string[]) {
  const id = `${prefix}-${++sequence}-${label}`, roleId = `${id}-role`;
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: `Synthetic purchase ${label}`, status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: `Synthetic purchase ${label}`, isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-assignment`, userId: id, roleId } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await tx.rolePermission.create({ data: { id: `${id}-grant-${scope}`, roleId, permissionId: permission.id } });
    }
    if (owner) {
      await tx.role.upsert({ where: { id: 'role-super-admin' }, update: {}, create: { id: 'role-super-admin', name: 'Synthetic canonical owner', isSystem: true } });
      await tx.userRole.create({ data: { id: `${id}-owner`, userId: id, roleId: 'role-super-admin' } });
    }
  });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current, 'actual active DB identity before JWT').not.toBeNull();
  if (!owner) expect(current!.scopes).toEqual([...scopes].sort());
  return { id, roleId, ceiling, token: auth.signToken({ userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true, ...(ceiling ? { permissionCeiling: ceiling } : {}) }) };
}
type Actor = Awaited<ReturnType<typeof actor>>;
const writer = (label: string) => actor(label, ['products:read', 'products:write', 'sensitive:cost']);
function app(database: PrismaClient = db(), notify = vi.fn()) {
  const result = express(); result.use(express.json()); result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1/products', createProductsRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), uploadDir: '/tmp', onDataChange: notify }));
  return result;
}
function body(label: string) {
  const id = `${prefix}-asset-${++sequence}-${label}`;
  return { id, sku: id, name: id, mainCategory: 'Fabric', cost: '25.1234', fabricPrices: [
    { id: `${id}-factory-now`, priceType: 'factory', amount: '8.5', currency: 'USD', unit: 'M' },
    { id: `${id}-factory-old`, priceType: 'factory', amount: '8.1', currency: 'USD', unit: 'M' },
    ...['customer', 'sample', 'cutting'].map((priceType, i) => ({ id: `${id}-${priceType}`, priceType, amount: String(20 + i), currency: 'USD', unit: 'M' })),
  ] };
}
async function post(who: Actor, input: object, database = db(), notify = vi.fn()) {
  return request(app(database, notify)).post(path).set('Authorization', `Bearer ${who.token}`).send(input);
}
async function patch(who: Actor, id: string, input: object, database = db(), notify = vi.fn()) {
  return request(app(database, notify)).patch(`${path}/${id}`).set('Authorization', `Bearer ${who.token}`).send(input);
}
async function create(who: Actor, label: string) {
  const input = body(label), response = await post(who, input);
  expect(response.status, diagnostic(response.body)).toBe(201); return input;
}
async function prices(id: string) { return db().fabricPriceHistory.findMany({ where: { productAssetId: id }, orderBy: { id: 'asc' } }); }
const factoryAmounts = (rows: any[]) => rows.filter(p => p.priceType === 'factory').map(p => p.amount);
async function state() {
  const assets = await db().productAsset.findMany({ where: { id: { startsWith: prefix } }, orderBy: { id: 'asc' } });
  return { assets, prices: await db().fabricPriceHistory.findMany({ where: { productAssetId: { in: assets.map(p => p.id) } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { startsWith: prefix } }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { OR: [{ ownerId: { startsWith: prefix } }, { targetId: { startsWith: prefix } }] }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { OR: [{ fromId: { startsWith: prefix } }, { toId: { startsWith: prefix } }] }, orderBy: { id: 'asc' } }) };
}
async function read(who: Actor, id: string, route: 'list'|'query'|'detail') {
  const api = request(app());
  const response = route === 'detail' ? await api.get(`${path}/${id}`).set('Authorization', `Bearer ${who.token}`)
    : route === 'query' ? await api.post(`${path}/query`).set('Authorization', `Bearer ${who.token}`).send({ query: id, limit: 10 })
    : await api.get(path).query({ search: id, limit: 10 }).set('Authorization', `Bearer ${who.token}`);
  expect(response.status, diagnostic(response.body)).toBe(200);
  const row = route === 'detail' ? response.body.asset : response.body.assets.find((p: any) => p.id === id);
  expect(row, `actual ${route} source identity`).toBeTruthy(); return row;
}
async function currentAgent(who: Actor) {
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(who.id); expect(current).not.toBeNull();
  return createIdentityService().resolveActorContext({ userId: who.id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true, ...(who.ceiling ? { permissionCeiling: who.ceiling } : {}) });
}

describe.sequential('actual product factory price disclosure/write/storage boundaries in isolated PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(url.protocol).toBe('postgresql:');
    expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe(port); expect(url.pathname).toBe(`/${name}`);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(Boolean(directory)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify actual PG identity BEFORE fixture writes').toEqual([{ name, directory, port: Number(port) }]);
    vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', ''); vi.stubGlobal('fetch', vi.fn(() => { throw Error('External transport forbidden in isolated purchase probes'); }));
  });
  afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await prisma?.$disconnect(); });

  it('PF01 authorized actual POST stores independent purchase history and explicit zero without borrowing targets or sale price', async () => {
    const who = await writer('create'), input = await create(who, 'create'); const rows = await prices(input.id);
    expect(factoryAmounts(rows).map(p => p.toString()).sort()).toEqual(['8.1', '8.5']);
    expect(rows.filter(p => p.priceType !== 'factory').map(p => p.amount.toString()).sort()).toEqual(['20', '21', '22']);
    expect((await db().productAsset.findUniqueOrThrow({ where: { id: input.id } })).cost?.toString()).toBe('25.1234');
    const zero = body('explicit-zero'); const response = await post(who, { ...zero, fabricPrices: [{ ...zero.fabricPrices[0], amount: 0 }] });
    expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body.asset.fabricPrices[0].amount).toBe(0);
    expect((await prices(zero.id))[0].amount.toString()).toBe('0');
  });
  it('PF02 actual list/query/detail mask ALL factory history and actual cost, preserve customer/sample/cutting and raw SQL source', async () => {
    const owner = await writer('read-source'), input = await create(owner, 'read-source'), reader = await actor('reader', ['products:read']), before = await prices(input.id);
    for (const route of ['list', 'query', 'detail'] as const) {
      const hidden = await read(reader, input.id, route), visible = await read(owner, input.id, route);
      expect(hidden.cost).toBeNull(); expect(factoryAmounts(hidden.fabricPrices)).toEqual([null, null]);
      expect(hidden.fabricPrices.filter((p: any) => p.priceType !== 'factory').map((p: any) => p.amount).sort()).toEqual([20, 21, 22]);
      expect(factoryAmounts(visible.fabricPrices).sort()).toEqual([8.1, 8.5]); expect(visible.cost).toBe(25.1234);
    }
    expect(await prices(input.id)).toEqual(before);
  });
  it('PF03 canonical owner with credential ceiling cannot expose/write purchases through the global snapshot guard', async () => {
    const who = await writer('cap-source'), input = await create(who, 'cap-source');
    const limited = await actor('limited-owner', ['products:read', 'products:write', 'sensitive:cost'], true, ['products:read', 'products:write']);
    expect(factoryAmounts((await read(limited, input.id, 'detail')).fabricPrices)).toEqual([null, null]);
    const before = await state(), notify = vi.fn(); const response = await patch(limited, input.id, { fabricPrices: [{ priceType: 'factory', amount: 999 }] }, db(), notify);
    expect(response.status, diagnostic(response.body)).toBe(403); expect(await state()).toEqual(before); expect(notify).not.toHaveBeenCalled();
  });
  it('PF04 actual DB sensitive grant revocation changes old-session reads and rejects factory write with zero PG side effects', async () => {
    const who = await writer('withdraw'), input = await create(who, 'withdraw'); const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'sensitive:cost' } });
    await db().rolePermission.deleteMany({ where: { roleId: who.roleId, permissionId: permission.id } });
    const hidden = await read(who, input.id, 'detail'); expect(hidden.cost).toBeNull(); expect(factoryAmounts(hidden.fabricPrices)).toEqual([null, null]);
    const before = await state(), notify = vi.fn(); const response = await patch(who, input.id, { fabricPrices: [{ priceType: 'factory', amount: 999 }] }, db(), notify);
    expect(response.status, diagnostic(response.body)).toBe(403); expect(await state()).toEqual(before); expect(notify).not.toHaveBeenCalled();
  });
  it('PF05 actual customer-only and empty replacements retain hidden exact factory rows/ids/timestamps rather than erasing their history', async () => {
    const who = await writer('preserve-source'), input = await create(who, 'preserve-source'), editor = await actor('commercial-editor', ['products:read', 'products:write']);
    const before = (await prices(input.id)).filter(p => p.priceType === 'factory');
    for (const replacements of [[{ id: `${input.id}-new-customer`, priceType: 'customer', amount: 30, currency: 'USD', unit: 'M' }], []]) {
      const response = await patch(editor, input.id, { fabricPrices: replacements }); expect(response.status, diagnostic(response.body)).toBe(200);
      expect((await prices(input.id)).filter(p => p.priceType === 'factory')).toEqual(before);
      expect((await prices(input.id)).filter(p => p.priceType !== 'factory')).toHaveLength(replacements.length);
      expect(factoryAmounts(response.body.asset.fabricPrices)).toEqual([null, null]);
    }
    expect(await db().auditLog.count({ where: { targetType: 'ProductAsset', targetId: input.id, action: 'update_product_asset' } })).toBe(2);
  });
  it('PF06 default/retyped factory writes are forbidden and unknown authorized factory input is rejected before any SQL write, never synthesized zero', async () => {
    const who = await writer('invalid-source'), input = await create(who, 'invalid-source'), editor = await actor('invalid-editor', ['products:write']);
    const before = await state(), notify = vi.fn();
    const retype = await patch(editor, input.id, { fabricPrices: [{ id: input.fabricPrices[0].id, priceType: 'customer', amount: 30 }] }, db(), notify);
    expect(retype.status, diagnostic(retype.body)).toBe(403);
    const defaultType = await post(editor, { ...body('default-type'), fabricPrices: [{ amount: 30 }] }, db(), notify); expect(defaultType.status).toBe(403);
    for (const amount of [null, undefined]) {
      const response = await patch(who, input.id, { fabricPrices: [{ priceType: 'factory', amount }] }, db(), notify);
      expect(response.status, diagnostic(response.body)).toBe(400); expect(response.body.error).toBe('INVALID_AMOUNT');
    }
    expect(await state()).toEqual(before); expect(notify).not.toHaveBeenCalled();
  });
  it('PF07 actual Agent products.get follows fresh DB identity/capped authority; include-pricing denial occurs before product query', async () => {
    const who = await writer('agent-source'), input = await create(who, 'agent-source'), reader = await actor('agent-reader', ['products:read']);
    const hidden: any = await executeAgentTool({ prisma: db(), actor: await currentAgent(reader), toolId: 'products.get', toolInput: { id: input.id, roles: ['owner'], permissions: ['sensitive:cost'] } });
    expect(hidden).toMatchObject({ ok: true, found: true, item: { id: input.id, cost: null } }); expect(factoryAmounts(hidden.item.fabricPrices)).toEqual([null, null]);
    expect(hidden.item.fabricPrices.filter((p: any) => p.priceType !== 'factory').map((p: any) => p.amount.toString()).sort()).toEqual(['20', '21', '22']);
    const visible: any = await executeAgentTool({ prisma: db(), actor: await currentAgent(who), toolId: 'products.get', toolInput: { id: input.id } });
    expect(factoryAmounts(visible.item.fabricPrices).map(p => p.toString()).sort()).toEqual(['8.1', '8.5']);
    await expect(executeAgentTool({ prisma: db(), actor: await currentAgent(reader), toolId: 'products.expand', toolInput: { id: input.id, include: ['pricing'] } }))
      .rejects.toThrow('TOOL_NOT_ALLOWED: INSUFFICIENT_SCOPE: pricing:read');
    const pricingReader = await actor('agent-pricing-reader', ['products:read', 'pricing:read']);
    const expanded: any = await executeAgentTool({ prisma: db(), actor: await currentAgent(pricingReader), toolId: 'products.expand', toolInput: { id: input.id, include: ['pricing'] } });
    expect(factoryAmounts(expanded.pricing)).toEqual([null, null]);
    expect(expanded.pricing.filter((p: any) => p.priceType !== 'factory').map((p: any) => p.amount.toString()).sort()).toEqual(['20', '21', '22']);
    expect(factoryAmounts(await prices(input.id)).map(p => p.toString()).sort()).toEqual(['8.1', '8.5']); expect(fetch).not.toHaveBeenCalled();
  });
  it('PF08 real mandatory audit SQL FK failure AFTER nested replacement rolls back price history/asset/audit/reference writes; valid retry commits once', async () => {
    const who = await writer('audit-source'), input = await create(who, 'audit-source'), before = await state(), notify = vi.fn();
    let attempts = 0, observedFactory: string[] = [], sqlError: unknown;
    const database = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return async (callback: any, options: any) => target.$transaction(async tx => {
        const view = new Proxy(tx, { get(transaction, member) {
          if (member === 'auditLog') return new Proxy(transaction.auditLog, { get(delegate, method) {
            if (method === 'create') return async (args: any) => {
              attempts++; observedFactory = factoryAmounts(await transaction.fabricPriceHistory.findMany({ where: { productAssetId: input.id } })).map(p => p.toString());
              try { return await delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-actor-FK` } }); }
              catch (error) { sqlError = error; throw error; }
            };
            const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
          } });
          const value = Reflect.get(transaction, member); return typeof value === 'function' ? value.bind(transaction) : value;
        } }); return callback(view);
      }, options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const changed = { name: 'Nested price retry', fabricPrices: [{ id: `${input.id}-replacement`, priceType: 'factory', amount: '99.25', currency: 'USD', unit: 'M' }] };
    const failed = await patch(who, input.id, changed, database, notify);
    expect(failed.status, diagnostic(failed.body)).toBe(500); expect(attempts).toBe(1); expect((sqlError as any)?.code).toBe('P2003');
    expect(observedFactory, 'replacement reached real tx SQL BEFORE mandatory audit failure').toEqual(['99.25']);
    expect(await state()).toEqual(before); expect(notify).not.toHaveBeenCalled();
    const retry = await patch(who, input.id, changed, db(), notify); expect(retry.status, diagnostic(retry.body)).toBe(200);
    expect(factoryAmounts(await prices(input.id)).map(p => p.toString())).toEqual(['99.25']);
    expect(await db().auditLog.count({ where: { targetType: 'ProductAsset', targetId: input.id, action: 'update_product_asset' } })).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
