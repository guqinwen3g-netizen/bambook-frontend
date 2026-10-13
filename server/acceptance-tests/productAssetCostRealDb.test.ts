/**
 * Actual Products HTTP router/current authorization/isolated PostgreSQL.
 * Development targets do not establish actual CNY unit cost; unknown stays null.
 * sensitive:cost is a viewing scope (role matrix §3.6), not a new write capability.
 * Synthetic actors/records prove these transport/storage boundaries, not company
 * user UAT, development-conversion completion, or historical cost revalidation.
 * No seed, app bootstrap, scheduler, shared DB or cleanup-by-delete is used.
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
import { createPriceDeviationRuleService, PRICE_RULE_CONDITION } from '../src/pricing/priceDeviationRuleService';

const prefix = `acceptance-product-cost-${randomUUID()}`;
const path = '/api/v1/products/assets';
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
const db = () => { if (!prisma) throw new Error('isolated product-cost fixture not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

async function actor(label: string, scopes: string[], options: { owner?: boolean; ceiling?: string[] } = {}) {
  const id = `${prefix}-${++sequence}-${label}`;
  const roleId = `${id}-configured-role`;
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id, displayName: `Synthetic product cost ${label}`, status: 'active' } });
    await tx.role.create({ data: { id: roleId, name: `Synthetic product cost ${label}`, isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-assignment`, userId: id, roleId } });
    for (const scope of scopes) {
      const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await tx.rolePermission.create({ data: { id: `${id}-grant-${scope}`, roleId, permissionId: permission.id } });
    }
    if (options.owner) {
      // Real canonical identity, never an arbitrary custom Role.name='owner'.
      await tx.role.upsert({ where: { id: 'role-super-admin' }, update: {}, create: { id: 'role-super-admin', name: 'Synthetic canonical owner', isSystem: true } });
      await tx.userRole.create({ data: { id: `${id}-canonical-owner`, userId: id, roleId: 'role-super-admin' } });
    }
  });
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(id);
  expect(current, 'load successful current DB authorization before issuing fixture JWT').not.toBeNull();
  if (!options.owner) expect(current!.scopes).toEqual([...scopes].sort());
  else {
    expect(current!.legacyRoleCodes).toContain('owner');
    for (const scope of scopes) expect(current!.scopes).toContain(scope);
  }
  return { id, roleId, token: auth.signToken({ userId: id, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
    permissions: current!.scopes, departmentIds: current!.departmentIds, authorizationLoaded: true,
    ...(options.ceiling ? { permissionCeiling: options.ceiling } : {}) }) };
}
type Actor = Awaited<ReturnType<typeof actor>>;
const writer = (label: string) => actor(label, ['products:read', 'products:write', 'sensitive:cost']);
function app(database: PrismaClient = db(), notify = vi.fn()) {
  const result = express();
  result.use(express.json());
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  // Products owns its actual serializeProductAssets/BigInt/Decimal response contract.
  result.use('/api/v1/products', createProductsRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), uploadDir: '/tmp', onDataChange: notify }));
  return result;
}
function body(label: string, values: Record<string, unknown> = {}) {
  const id = `${prefix}-asset-${++sequence}-${label}`;
  return { id, sku: id, name: id, mainCategory: 'Fabric', subCategoryId: 'uncategorized', season: '', ...values };
}
async function create(who: Actor, input: Record<string, unknown>, database: PrismaClient = db(), notify = vi.fn()) {
  return request(app(database, notify)).post(path).set('Authorization', `Bearer ${who.token}`).send(input);
}
async function patch(who: Actor, id: string, input: Record<string, unknown>, database: PrismaClient = db(), notify = vi.fn()) {
  return request(app(database, notify)).patch(`${path}/${id}`).set('Authorization', `Bearer ${who.token}`).send(input);
}
async function stored(id: string) { return db().productAsset.findUniqueOrThrow({ where: { id } }); }
async function audits(id: string, action?: string) {
  return db().auditLog.findMany({ where: { targetType: 'ProductAsset', targetId: id, ...(action ? { action } : {}) }, orderBy: { id: 'asc' } });
}
async function state() {
  const assets = await db().productAsset.findMany({ where: { id: { startsWith: prefix } }, orderBy: { id: 'asc' } });
  const ids = assets.map(row => row.id);
  return {
    assets,
    audits: await db().auditLog.findMany({ where: { actorId: { startsWith: prefix } }, orderBy: { id: 'asc' } }),
    fabricProfiles: await db().fabricProfile.findMany({ where: { productAssetId: { in: ids } }, orderBy: { id: 'asc' } }),
    garmentProfiles: await db().garmentProfile.findMany({ where: { productAssetId: { in: ids } }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { OR: [{ ownerId: { startsWith: prefix } }, { targetId: { startsWith: prefix } }] }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { OR: [{ fromId: { startsWith: prefix } }, { toId: { startsWith: prefix } }] }, orderBy: { id: 'asc' } }),
  };
}

describe.sequential('actual ProductAsset cost unknown/explicit/visibility/audit boundaries in PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    const name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    const port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(port); expect(url.pathname).toBe(`/${name}`);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(directory)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify actual DB identity BEFORE any fixture write').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('PC01 actual POST leaves omitted cost null and keeps an independent garment goal', async () => {
    const who = await writer('unknown');
    const input = body('unknown', { mainCategory: 'Garment', targetPrice: '999', garmentProfile: { targetCost: 'USD 25' } });
    const notify = vi.fn();
    const response = await create(who, input, db(), notify);
    expect(response.status, diagnostic(response.body)).toBe(201);
    expect(response.body.asset.cost).toBeNull();
    expect((await stored(input.id)).cost).toBeNull();
    expect((await db().garmentProfile.findUniqueOrThrow({ where: { productAssetId: input.id } })).targetCost).toBe('USD 25');
    const log = await audits(input.id, 'create_product_asset');
    expect(log).toHaveLength(1); expect(log[0].actorId).toBe(who.id);
    expect((log[0].detail as any).after.cost).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ entity: 'products', action: 'create', ids: [input.id] });
  });

  it('PC02 explicit zero is stored and rendered as zero, but cannot establish a positive cost floor', async () => {
    const who = await writer('zero'); const input = body('zero', { cost: 0 });
    const response = await create(who, input);
    expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body.asset.cost).toBe(0);
    expect((await stored(input.id)).cost?.toString()).toBe('0');
    const evaluation = await createPriceDeviationRuleService(db()).evaluateQuotationRules({ customerRelationId: null, currency: 'CNY', lines: [{ fabricCode: input.sku, unitPrice: 1, unit: 'M' }] });
    expect(evaluation.findings.belowCost.costMissing).toBe(true);
    expect(evaluation.findings.belowCost.lines).toEqual([]);
    expect(evaluation.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
  });

  it('PC03 positive manual CNY cost persists at full four-decimal precision independently of target values', async () => {
    const who = await writer('positive');
    const input = body('positive', { cost: '125.1234', targetPrice: '999', targetCost: 'USD 25' });
    const response = await create(who, input);
    expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body.asset.cost).toBe(125.1234);
    expect((await stored(input.id)).cost?.toString()).toBe('125.1234');
    const log = await audits(input.id, 'create_product_asset');
    expect(log).toHaveLength(1); expect(log[0].actorId).toBe(who.id);
    expect((log[0].detail as any).after.cost).toBe('125.1234');
  });

  it('PC04 actual PATCH omission preserves positive cost; explicit clear and later omission preserve null with mandatory actual-actor audit', async () => {
    const who = await writer('clear'); const input = body('clear', { cost: '125.1234' });
    const created = await create(who, input); expect(created.status, diagnostic(created.body)).toBe(201);
    const renamed = await patch(who, input.id, { name: `${input.name}-renamed`, targetCost: '999' });
    console.log(diagnostic({ probe: 'product-cost-omitted-update', http: renamed.status, response: renamed.body, stored: await stored(input.id) }));
    expect(renamed.status, diagnostic(renamed.body)).toBe(200);
    expect(renamed.body.asset.cost).toBe(125.1234); expect((await stored(input.id)).cost?.toString()).toBe('125.1234');
    const cleared = await patch(who, input.id, { cost: null });
    expect(cleared.status, diagnostic(cleared.body)).toBe(200);
    expect(cleared.body.asset.cost).toBeNull(); expect((await stored(input.id)).cost).toBeNull();
    const renameAgain = await patch(who, input.id, { name: `${input.name}-after-clear` });
    expect(renameAgain.status, diagnostic(renameAgain.body)).toBe(200);
    expect(renameAgain.body.asset.cost).toBeNull(); expect((await stored(input.id)).cost).toBeNull();
    const logs = await audits(input.id, 'update_product_asset');
    expect(logs).toHaveLength(3); expect(logs.every(log => log.actorId === who.id)).toBe(true);
    const clearLog = logs.find(log => (log.detail as any)?.before?.cost === '125.1234' && (log.detail as any)?.after?.cost === null);
    expect(clearLog, 'clear has actual before cost and explicit null in the persisted audit').toBeTruthy();
  });

  it('PC05 actual list/query/detail obey configured cost scope and current withdrawal without changing the stored amount', async () => {
    const who = await writer('visibility-source'); const input = body('visibility-source', { cost: '125.1234' });
    const created = await create(who, input); expect(created.status, diagnostic(created.body)).toBe(201);
    const visible = await actor('visible-reader', ['products:read', 'sensitive:cost']);
    const reader = await actor('masked-reader', ['products:read']);
    const before = await stored(input.id);
    async function responses(subject: Actor, expected: number | null) {
      const result = app(); const authHeader = `Bearer ${subject.token}`;
      const list = await request(result).get(path).query({ search: input.sku }).set('Authorization', authHeader);
      expect(list.status, diagnostic(list.body)).toBe(200);
      expect(list.body.assets.find((row: any) => row.id === input.id)?.cost).toBe(expected);
      const query = await request(result).post(`${path}/query`).set('Authorization', authHeader).send({ query: input.sku });
      expect(query.status, diagnostic(query.body)).toBe(200);
      expect(query.body.assets.find((row: any) => row.id === input.id)?.cost).toBe(expected);
      const detail = await request(result).get(`${path}/${input.id}`).set('Authorization', authHeader);
      expect(detail.status, diagnostic(detail.body)).toBe(200);
      expect(detail.body.asset).toMatchObject({ id: input.id, sku: input.sku, cost: expected });
    }
    await responses(visible, 125.1234); await responses(reader, null);
    // Withdraw only our own configured scope; the old nonempty JWT is still used.
    await db().rolePermission.delete({ where: { id: `${visible.id}-grant-sensitive:cost` } });
    await responses(visible, null);
    expect(await stored(input.id)).toEqual(before);
  });

  it('PC06 trusted limited-owner credential ceiling survives actual composition-root refresh and masks cost', async () => {
    const who = await writer('limited-source'); const input = body('limited-source', { cost: '125.1234' });
    const created = await create(who, input); expect(created.status, diagnostic(created.body)).toBe(201);
    const limited = await actor('limited-owner', ['products:read'], { owner: true, ceiling: ['products:read'] });
    const before = await stored(input.id); const response = await request(app()).get(`${path}/${input.id}`).set('Authorization', `Bearer ${limited.token}`);
    console.log(diagnostic({ probe: 'product-cost-limited-owner', http: response.status, returnedCost: response.body.asset?.cost, rawCost: before.cost?.toString() }));
    expect(response.status, diagnostic(response.body)).toBe(200);
    expect(response.body.asset).toMatchObject({ id: input.id, sku: input.sku, cost: null });
    expect(await stored(input.id)).toEqual(before);
  });

  it('PC07 real stored mixed costs keep known-cost blocking and expose unknown/zero and independent missing FX', async () => {
    const who = await writer('mixed');
    const known = body('mixed-known', { cost: '125.1234' }), unknown = body('mixed-unknown'), zero = body('mixed-zero', { cost: 0 });
    for (const input of [known, unknown, zero]) { const response = await create(who, input); expect(response.status, diagnostic(response.body)).toBe(201); }
    const before = await state(); const rules = createPriceDeviationRuleService(db());
    const lines = [{ fabricCode: known.sku, unitPrice: 100, unit: 'M' }, { fabricCode: unknown.sku, unitPrice: 500, unit: 'M' }, { fabricCode: zero.sku, unitPrice: 500, unit: 'M' }];
    const cny = await rules.evaluateQuotationRules({ customerRelationId: null, currency: 'CNY', lines });
    expect(cny.findings.belowCost.costMissing).toBe(true); expect(cny.findings.belowCost.compareUnavailable).toBe(false);
    expect(cny.findings.belowCost.lines).toEqual([{ fabricCode: known.sku, unitPriceCny: 100, costCny: 125.1234 }]);
    expect(cny.hitConditions).toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE); expect(cny.level).toBe('block');
    const unavailable = await rules.evaluateQuotationRules({ customerRelationId: null, currency: 'USD', lines });
    expect(unavailable.findings.belowCost.costMissing).toBe(true); expect(unavailable.findings.belowCost.compareUnavailable).toBe(true);
    expect(unavailable.findings.belowCost.lines).toEqual([]); expect(unavailable.hitConditions).not.toContain(PRICE_RULE_CONDITION.BELOW_COST_PRICE);
    const fx = await rules.evaluateQuotationRules({ customerRelationId: null, currency: 'USD', exchangeRate: 7,
      lines: [{ fabricCode: known.sku, unitPrice: 15, unit: 'M' }, { fabricCode: unknown.sku, unitPrice: 500, unit: 'M' }] });
    expect(fx.findings.belowCost.lines).toEqual([{ fabricCode: known.sku, unitPriceCny: 105, costCny: 125.1234 }]);
    expect(fx.findings.belowCost.costMissing).toBe(true); expect(fx.level).toBe('block');
    expect(await state()).toEqual(before);
  });

  it('PC08 actual audit SQL FK failure rolls back inserted/updated cost and publishes no success event', async () => {
    const who = await writer('audit-fault');
    const existing = body('audit-existing', { cost: '125.1234' });
    const created = await create(who, existing); expect(created.status, diagnostic(created.body)).toBe(201);
    for (const operation of ['create', 'update'] as const) {
      const before = await state(); const notify = vi.fn(); const input = body(`audit-${operation}`, { cost: '55.4321' });
      const targetId = operation === 'create' ? input.id : existing.id;
      let injections = 0; let sqlCode: string | undefined; let errorName: string | undefined; let insideCost: string | null | undefined;
      const faultClient = new Proxy(db(), { get(target, property) {
        if (property === '$transaction') return (callback: any, options: any) => target.$transaction(async tx => {
          const audit = new Proxy(tx.auditLog, { get(delegate, key) {
            if (key === 'create') return async (args: any) => {
              if (args.data.action !== `${operation}_product_asset`) return delegate.create(args);
              injections++;
              const inside = await tx.productAsset.findUnique({ where: { id: targetId } });
              insideCost = inside ? inside.cost?.toString() ?? null : undefined;
              // A real INSERT hits the FK. Never replace it with a thrown mock error.
              try { return await delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } }); }
              catch (error: any) { sqlCode = error?.code; errorName = error?.name; throw error; }
            };
            const value = Reflect.get(delegate, key); return typeof value === 'function' ? value.bind(delegate) : value;
          } });
          const guardedTx = new Proxy(tx, { get(client, key) { if (key === 'auditLog') return audit;
            const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value; } });
          return callback(guardedTx);
        }, options);
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } }) as PrismaClient;
      const response = operation === 'create' ? await create(who, input, faultClient, notify)
        : await patch(who, existing.id, { cost: '55.4321' }, faultClient, notify);
      const after = await state();
      console.log(diagnostic({ probe: 'product-cost-audit-atomicity', operation, sqlCode, errorName, injections, insideCost,
        http: response.status, beforeAssetCount: before.assets.length, afterAssetCount: after.assets.length, successEvents: notify.mock.calls.length }));
      expect(injections, 'reach mandatory audit after the real asset write').toBe(1);
      expect(insideCost, 'new amount was visible inside the actual transaction').toBe('55.4321');
      expect(sqlCode, 'must be actual SQL P2003, not a JSON/BigInt validation failure or a synthetic throw').toBe('P2003');
      expect(response.status, diagnostic(response.body)).toBe(500);
      expect(after).toEqual(before); expect(notify).not.toHaveBeenCalled();
      if (operation === 'create') expect(await db().productAsset.findUnique({ where: { id: targetId } })).toBeNull();
      else expect((await stored(existing.id)).cost?.toString()).toBe('125.1234');
    }
  });
});
