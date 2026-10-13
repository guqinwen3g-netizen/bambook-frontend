/** Opt-in isolated PG. Current explicit scopes/cap (not role names/defaults),
 * bound job identity, source-group serialization, the entire fetched collection
 * or <=500 map page and mandatory actor audit are exercised through real HTTP.
 * Remote fetchRows is explicitly synthetic; no PDML bridge/network, scheduler,
 * seed or shared DB is started. PD01–12 are small 2-row collections. PD13 is a
 * separate 17k-row native PG performance smoke with synthetic remote pages;
 * it does not prove the real bridge or real source currency/unit correctness.
 * PDML is a global catalog/cache without an Order FK; no artificial L2 is used.
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
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createPdmlRouter } from '../src/pdml/route';
import { currentPdmlActor, loadPdmlSchedulerActor, PDML_SYNC_SCOPES } from '../src/pdml/pdmlAccess';
import type { PdmlFetchResult } from '../src/pdml/source';

const prefix = `acceptance-pdml-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`, key = `${prefix}-key`;
let prisma: PrismaClient | undefined, counter = 0;
function db() { if (!prisma) throw Error('Independent PDML client not initialized'); return prisma; }
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
  await db().userAccount.create({ data: { id: grantor, displayName: 'Synthetic PDML grantor', status: 'active' } });
  await db().role.upsert({ where: { id: 'owner' }, update: {}, create: { id: 'owner', name: 'Synthetic canonical owner', isSystem: true } });
});
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string, options: { scopes?: string[]; owner?: boolean } = {}) {
  const id = `${prefix}-${++counter}-${label}`, userId = `${id}-user`, roleId = options.owner ? 'owner' : `${id}-role`,
    gsid = `${id}-source`, line = `Textile-${randomUUID()}`;
  const scopes = options.scopes ?? ['data:import', 'products:read', 'products:write', 'sensitive:cost'];
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic current PDML actor', status: 'active' } });
    if (!options.owner) await tx.role.create({ data: { id: roleId, name: 'Synthetic configured operator', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-role-link`, userId, roleId } });
    await tx.userPermissionOverrides.createMany({ data: scopes.map(scope => ({ id: `${id}-grant-${scope}`, userId,
      scope, isActive: true, grantedBy: grantor, reason: 'Explicit synthetic import grant' })) });
  });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  expect(actor.permissions).toEqual([...scopes].sort());
  if (!options.owner) expect(actor.roles).toEqual([]);
  const rows = [1, 2].map(index => ({ ID: `${id}-row-${index}`, CPXL: line, GSPH: `${id}-article-${index}`,
    GCPH: `${id}-factory-${index}`, GYS: 'Synthetic supplier label', CF: 'C60/P40', GCCGDJ: '12.5', GCBZ: 'USD',
    RMB: '100.25', USD: '14.75', SYCGDJ: '3.125', QDL: '1000', GCQDL: '2000', SYQDL: '10.3',
    FK: '57/58', FKDW: 'inch', KZ: '180', KZDW: 'G/M2', ZT: '草稿', DJRQ: '2099-01-01' }));
  const source: PdmlFetchResult = { gsid, totalAvailable: 2, rows };
  const productIds = rows.map(row => `PDML-FAB-${row.ID}`), categoryId = `PDML-FAB-CAT-${line.toUpperCase()}`;
  return { id, userId, roleId, gsid, actor, rows, source, productIds, categoryId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application(client: PrismaClient, item: Fixture, options: {
  fetchRows?: (params: { gsid?: string; limit?: number; pageSize?: number }) => Promise<PdmlFetchResult>;
  keyActor?: TokenPayload;
} = {}) {
  const app = express(), changes: any[] = [], actors = new Map<string, TokenPayload>();
  if (options.keyActor) actors.set(key, options.keyActor);
  app.use(express.json()); app.use(createAccountStatusGuard(client));
  app.use(createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set([key]), apiKeyActors: actors }));
  app.use('/pdml', createPdmlRouter({ prisma: client, requireAuth: true, apiKeys: new Set([key]), apiKeyActors: actors,
    fetchRows: options.fetchRows || (async () => item.source), onDataChange: event => changes.push(event) }));
  return { app, changes };
}
function http(item: Fixture, app: ReturnType<typeof application>, method: 'get' | 'post', endpoint: string, actor = item.actor) {
  return request(app.app)[method](endpoint).set('Authorization', `Bearer ${auth.signToken(actor)}`);
}
function sync(item: Fixture, app: ReturnType<typeof application>, actor = item.actor) {
  return http(item, app, 'post', '/pdml/sync', actor).send({ gsid: item.gsid, blocking: true, actorId: grantor, roles: ['owner'] });
}
function map(item: Fixture, app: ReturnType<typeof application>, actor = item.actor) {
  return http(item, app, 'post', '/pdml/map-products', actor).send({ gsid: item.gsid, limit: 2, offset: 0 });
}
async function snapshot(item: Fixture) {
  const assets = await db().productAsset.findMany({ where: { sku: { in: item.rows.map(row => row.ID) } }, orderBy: { id: 'asc' } });
  const ids = [...new Set([...item.productIds, ...assets.map(row => row.id)])];
  return { raw: await db().pdmlRawFabric.findMany({ where: { gsid: item.gsid }, orderBy: { id: 'asc' } }), assets,
    profiles: await db().fabricProfile.findMany({ where: { productAssetId: { in: ids } }, orderBy: { id: 'asc' } }),
    prices: await db().fabricPriceHistory.findMany({ where: { productAssetId: { in: ids } }, orderBy: { id: 'asc' } }),
    compositions: await db().fabricCompositionLine.findMany({ where: { productAssetId: { in: ids } }, orderBy: { id: 'asc' } }),
    terms: await db().materialCompositionTerm.findMany({ where: { id: { in: ['MCT-PDML-C', 'MCT-PDML-P'] } }, orderBy: { id: 'asc' } }),
    categories: await db().productSubCategory.findMany({ where: { id: item.categoryId } }),
    audits: await db().auditLog.findMany({ where: { actorId: item.userId, targetType: { in: ['PdmlRawImport', 'PdmlProductImport'] } }, orderBy: { id: 'asc' } }) };
}
async function unchanged(item: Fixture, before: Awaited<ReturnType<typeof snapshot>>, app: ReturnType<typeof application>) {
  expect(await snapshot(item), 'The entire command, references/prices/metadata and audits must stay unchanged').toEqual(before);
  expect(app.changes, 'No notification before commit').toEqual([]);
}
const code = (r: any) => r.body.error?.code ?? r.body.error;
type Probe = { auditFault?: boolean; secondRawSqlFault?: boolean; revokeAfterProduct?: Fixture; authSqlFault?: boolean;
  deadline?: boolean; nativeTransactions?: number; reached?: boolean; actualCode?: string; actualPrefixRows?: number };
function intercepted(item: Fixture, probe: Probe): PrismaClient {
  let rawWrites = 0, productObserved = false;
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return async (work: any, options?: any) => {
      probe.nativeTransactions = (probe.nativeTransactions || 0) + 1;
      try { return await client.$transaction(async tx => work(new Proxy(tx, { get(transaction, delegate) {
        if (['auditLog', 'pdmlRawFabric', 'productAsset', 'userPermissionOverrides'].includes(String(delegate))) {
          const model: any = Reflect.get(transaction, delegate);
          return new Proxy(model, { get(real, method) {
            if (delegate === 'auditLog' && method === 'create' && probe.auditFault) return async (args: any) => {
              probe.reached = true; probe.actualPrefixRows = await transaction.productAsset.count({ where: { sku: { in: item.rows.map(row => row.ID) } } });
              try { return await real.create({ ...args, data: { ...args.data, actorId: `${prefix}-nonexistent-audit-actor` } }); }
              catch (error: any) { probe.actualCode = error.code; throw error; }
            };
            if (delegate === 'pdmlRawFabric' && method === 'upsert' && probe.secondRawSqlFault) return async (args: any) => {
              rawWrites += 1;
              if (rawWrites === 2) {
                probe.reached = true; probe.actualPrefixRows = await transaction.pdmlRawFabric.count({ where: { gsid: item.gsid } });
                try { return await transaction.$queryRaw`SELECT "missing_pdml_storage_probe_column" FROM "UserAccount" LIMIT 1`; }
                catch (error: any) { probe.actualCode = error.code; throw error; }
              }
              return real.upsert(args);
            };
            if (delegate === 'pdmlRawFabric' && method === 'upsert' && probe.deadline) return async (args: any) => {
              const row = await real.upsert(args);
              if (!probe.reached) {
                probe.reached = true; probe.actualPrefixRows = await transaction.pdmlRawFabric.count({ where: { gsid: item.gsid } });
                // Actual PG work outlives the actual interactive tx deadline.
                // No fake timer/rejected promise stands in for expiry/rollback.
                await transaction.$queryRaw`SELECT pg_sleep(1.5)::text AS waited`;
              }
              return row;
            };
            if (delegate === 'productAsset' && method === 'upsert' && probe.revokeAfterProduct) return async (args: any) => {
              const row = await real.upsert(args);
              if (!productObserved) {
                productObserved = true; probe.reached = true;
                probe.actualPrefixRows = await transaction.productAsset.count({ where: { sku: { in: item.rows.map(entry => entry.ID) } } });
                await db().userPermissionOverrides.update({ where: { userId_scope: { userId: probe.revokeAfterProduct!.userId, scope: 'products:write' } }, data: { isActive: false } });
              }
              return row;
            };
            if (delegate === 'userPermissionOverrides' && method === 'findMany' && probe.authSqlFault) return async () => {
              probe.reached = true;
              try { return await transaction.$queryRaw`SELECT "missing_pdml_permission_probe_column" FROM "UserAccount" LIMIT 1`; }
              catch (error: any) { probe.actualCode = error.code; throw error; }
            };
            const value = Reflect.get(real, method); return typeof value === 'function' ? value.bind(real) : value;
          } });
        }
        const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), { ...options, timeout: probe.deadline ? 1_000 : options?.timeout ?? 30_000 }); }
      catch (error: any) { if (probe.deadline) probe.actualCode = error.code; throw error; }
    };
    const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value;
  } });
}

describe('actual isolated PG PDML import authorization, cost and atomicity', () => {
  it('PD01 native sync→map stores all source fields/classified prices, unknown actual cost and actual actor audits', async () => {
    const item = await fixture('positive'), app = application(db(), item);
    const synced = await sync(item, app); expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect(synced.body).toMatchObject({ fetched: 2, created: 2, updated: 0, unchanged: 0, skipped: 0 });
    const raw = await http(item, app, 'get', `/pdml/raw?gsid=${encodeURIComponent(item.gsid)}`);
    expect(raw.status).toBe(200); expect(raw.body.total).toBe(2);
    expect(raw.body.fabrics.map((row: any) => row.rawData).sort((a: any, b: any) => a.ID.localeCompare(b.ID))).toEqual(item.rows);
    const mapped = await map(item, app); expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    expect(mapped.body).toMatchObject({ mapped: 2, created: 2, updated: 0, hasMore: false });
    const state = await snapshot(item); expect(state.assets).toHaveLength(2); expect(state.assets.every(row => row.cost === null)).toBe(true);
    expect(state.profiles).toHaveLength(2); expect(state.compositions).toHaveLength(4);
    const prices = state.prices.filter(row => row.productAssetId === item.productIds[0]);
    expect(prices.map(row => [row.priceType, row.amount.toString(), row.currency]).sort()).toEqual([
      ['customer', '100.25', 'RMB'], ['customer', '14.75', 'USD'], ['factory', '12.5', 'USD'], ['sample', '3.125', 'USD'],
    ]);
    expect(state.audits).toHaveLength(2); expect(state.audits.every(row => row.actorId === item.userId)).toBe(true);
    expect(state.audits.find(row => row.id === mapped.body.auditId)?.detail).toMatchObject({ source: 'pdml', after: { gsid: item.gsid, created: 2 } });
    expect(app.changes).toHaveLength(2);
  });
  it('PD02 raw purchase-containing rows require BOTH product read and current cost visibility', async () => {
    const item = await fixture('raw-deny'), seeded = application(db(), item); expect((await sync(item, seeded)).status).toBe(200);
    for (const scope of ['products:read', 'sensitive:cost']) {
      await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope } }, data: { isActive: false } });
      const app = application(db(), item), before = await snapshot(item);
      const response = await http(item, app, 'get', `/pdml/raw?gsid=${encodeURIComponent(item.gsid)}`);
      expect(response.status).toBe(403); expect(response.body.fabrics).toBeUndefined(); await unchanged(item, before, app);
      await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope } }, data: { isActive: true } });
    }
  });
  it('PD03 map requires all three current scopes, independently of signed/body default owner claims', async () => {
    for (const scope of ['data:import', 'products:write', 'sensitive:cost']) {
      const item = await fixture(`map-deny-${scope}`), seeded = application(db(), item); expect((await sync(item, seeded)).status).toBe(200);
      await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope } }, data: { isActive: false } });
      const app = application(db(), item), before = await snapshot(item);
      const old = { ...item.actor, roles: ['owner'] as TokenPayload['roles'], permissions: [], authorizationLoaded: undefined };
      const response = await map(item, app, old); expect(response.status).toBe(403); await unchanged(item, before, app);
    }
  });
  it('PD04 existing owner and mapped keys cannot exceed the credential ceiling or JWT-only writes', async () => {
    const item = await fixture('cap-key', { owner: true }), capped = { ...item.actor, permissionCeiling: ['products:read', 'sensitive:cost'] };
    let fetched = 0;
    const app = application(db(), item, { keyActor: capped, fetchRows: async () => { fetched += 1; return item.source; } }), before = await snapshot(item);
    expect((await sync(item, app, capped)).status).toBe(403); expect((await map(item, app, capped)).status).toBe(403); expect(fetched).toBe(0);
    expect((await request(app.app).get('/pdml/raw').set('X-Bambook-API-Key', key)).status).toBe(200);
    expect((await request(app.app).post('/pdml/sync').set('X-Bambook-API-Key', key).send({ gsid: item.gsid, blocking: true })).status).toBe(401);
    await unchanged(item, before, app);
  });
  it('PD05 actual import withdrawal during remote substitution prevents the whole collection being written', async () => {
    const item = await fixture('fetch-revoke'), before = await snapshot(item);
    const app = application(db(), item, { fetchRows: async () => {
      await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'data:import' } }, data: { isActive: false } });
      return item.source;
    } });
    const response = await sync(item, app); expect(response.status, JSON.stringify(response.body)).toBe(403); await unchanged(item, before, app);
  });
  it('PD06 actual P2003 mandatory audit failure rolls back the complete raw collection or map page and all children', async () => {
    for (const action of ['raw', 'map']) {
      const item = await fixture(`audit-${action}`);
      if (action === 'map') expect((await sync(item, application(db(), item))).status).toBe(200);
      const before = await snapshot(item), probe: Probe = { auditFault: true }, app = application(intercepted(item, probe), item);
      const response = action === 'map' ? await map(item, app) : await sync(item, app);
      expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003');
      if (action === 'map') expect(probe.actualPrefixRows).toBe(2);
      expect(response.status, JSON.stringify(response.body)).toBe(500); expect(code(response)).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('Foreign key'); await unchanged(item, before, app);
    }
  });
  it('PD07 real storage SQL failure on the second raw row leaves no successful prefix behind', async () => {
    const item = await fixture('storage-fault'), before = await snapshot(item), probe: Probe = { secondRawSqlFault: true };
    const app = application(intercepted(item, probe), item), response = await sync(item, app);
    expect(probe.reached).toBe(true); expect(probe.actualPrefixRows).toBe(1); expect(probe.actualCode).toBe('P2010');
    expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('missing_pdml_storage_probe_column');
    await unchanged(item, before, app);
  });
  it('PD08 actual withdrawal after the first product write rolls back the entire mapping page', async () => {
    const item = await fixture('page-revoke'); expect((await sync(item, application(db(), item))).status).toBe(200);
    const before = await snapshot(item), probe: Probe = { revokeAfterProduct: item }, app = application(intercepted(item, probe), item);
    const response = await map(item, app); expect(probe.reached).toBe(true); expect(probe.actualPrefixRows).toBe(1);
    expect(response.status, JSON.stringify(response.body)).toBe(403); await unchanged(item, before, app);
  });
  it('PD09 async jobs bind the true submitter and never expose the stored credential to another account', async () => {
    const item = await fixture('job'), other = await fixture('other-job-reader');
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const app = application(db(), item, { fetchRows: async () => { await wait; return item.source; } });
    const started = await http(item, app, 'post', '/pdml/sync').send({ gsid: item.gsid, actorId: other.userId });
    expect(started.status).toBe(202); expect(started.body.actor).toBeUndefined(); expect(started.body.permissions).toBeUndefined();
    try {
      const response = await http(other, app, 'get', `/pdml/sync/${started.body.jobId}`);
      expect(response.status).toBe(404); expect(response.body.result).toBeUndefined();
      const own = await http(item, app, 'get', `/pdml/sync/${started.body.jobId}`);
      expect(own.status).toBe(200); expect(own.body.actor).toBeUndefined();
    } finally { release(); }
    let completed: any;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      completed = await http(item, app, 'get', `/pdml/sync/${started.body.jobId}`);
      if (['completed', 'failed'].includes(completed.body.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(completed.body.status, JSON.stringify(completed.body)).toBe('completed');
    const audit = await db().auditLog.findUniqueOrThrow({ where: { id: completed.body.result.auditId } });
    expect(audit.actorId).toBe(item.userId); expect(audit.targetId).toBe(started.body.jobId);
  });
  it('PD10 scheduler identity configuration is only a real account pointer with a narrow current capability', async () => {
    expect(await loadPdmlSchedulerActor(db(), undefined)).toBeNull();
    const item = await fixture('scheduler', { scopes: ['data:import'] });
    const actor = await loadPdmlSchedulerActor(db(), item.userId); expect(actor?.userId).toBe(item.userId);
    expect(actor?.roles).toEqual([]); expect(actor?.permissionCeiling).toEqual(['data:import']);
    const before = await snapshot(item);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.userId, scope: 'data:import' } }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await expect(loadPdmlSchedulerActor(db(), item.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db().userAccount.update({ where: { id: item.userId }, data: { status: 'disabled' } });
    await expect(loadPdmlSchedulerActor(db(), item.userId)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(await snapshot(item)).toEqual(before);
  });
  it('PD11 stopped/soft-deleted sessions and actual permission SQL faults cannot write or restore defaults', async () => {
    for (const deleted of [false, true]) {
      const item = await fixture(`stopped-${deleted}`), before = await snapshot(item), app = application(db(), item);
      await db().userAccount.update({ where: { id: item.userId }, data: deleted ? { deletedAt: BigInt(Date.now()) } : { status: 'disabled' } });
      expect((await sync(item, app)).status).toBe(401); await unchanged(item, before, app);
    }
    const item = await fixture('permission-sql'), before = await snapshot(item), probe: Probe = { authSqlFault: true };
    const app = application(intercepted(item, probe), item), response = await sync(item, app);
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2010'); expect(response.status).toBe(503);
    expect(code(response)).toBe('AUTHORIZATION_UNAVAILABLE'); await unchanged(item, before, app);
  });
  it('PD12 same-source concurrent pages serialize; existing manual actual cost is preserved independently of every source price', async () => {
    const item = await fixture('existing-concurrent'); expect((await sync(item, application(db(), item))).status).toBe(200);
    const assetId = `${item.id}-manual-asset`;
    await db().productAsset.create({ data: { id: assetId, sku: item.rows[0].ID, name: 'Synthetic independent manually confirmed cost',
      mainCategory: 'Fabric', subCategoryId: 'synthetic', season: 'synthetic', status: 'Active', cost: '123.4567', updatedAt: BigInt(Date.now()) } });
    const app = application(db(), item), results = await Promise.all([map(item, app), map(item, app)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(results.map(r => [r.body.created, r.body.updated]).sort()).toEqual([[0, 2], [1, 1]]);
    const state = await snapshot(item); expect(state.assets).toHaveLength(2);
    expect(state.assets.find(row => row.id === assetId)?.cost?.toString()).toBe('123.4567');
    expect(state.assets.find(row => row.id !== assetId)?.cost).toBeNull();
    expect(state.prices).toHaveLength(8); expect(state.profiles).toHaveLength(2); expect(state.compositions).toHaveLength(4);
    expect(state.audits.filter(row => row.targetType === 'PdmlProductImport')).toHaveLength(2); expect(app.changes).toHaveLength(2);
  });
  it('PD13 independent 17000-row native PG performance smoke and actual deadline rollback, with explicit remote-page substitute', async () => {
    const base = await fixture('17000-performance');
    const rows = Array.from({ length: 17_000 }, (_, index) => ({ ...base.rows[0], ID: `${base.id}-bulk-${index}`,
      GSPH: `${base.id}-article-${index}` }));
    const item: Fixture = { ...base, rows, productIds: rows.map(row => `PDML-FAB-${row.ID}`), source: { ...base.source, totalAvailable: rows.length, rows } };
    let pages = 0;
    const probe: Probe = {}, app = application(intercepted(item, probe), item, { fetchRows: async params => {
      const pageSize = params.pageSize ?? 500, fetched: typeof rows = [];
      for (let offset = 0; offset < rows.length; offset += pageSize) {
        await currentPdmlActor(db(), item.actor, PDML_SYNC_SCOPES);
        pages += 1; fetched.push(...rows.slice(offset, offset + pageSize));
      }
      return { gsid: item.gsid, totalAvailable: rows.length, rows: fetched };
    } });
    const started = performance.now();
    const response = await http(item, app, 'post', '/pdml/sync').send({ gsid: item.gsid, blocking: true, pageSize: 500 });
    const wallTimeMs = Math.round(performance.now() - started);
    const rowCount = await db().pdmlRawFabric.count({ where: { gsid: item.gsid } });
    const audits = await db().auditLog.findMany({ where: { actorId: item.userId, targetType: 'PdmlRawImport' } });
    console.info(JSON.stringify({ case: 'PD13-native-private-PG-performance', remote: 'synthetic-page-substitute',
      expectedRows: 17_000, substitutedPages: pages, wallTimeMs, httpStatus: response.status,
      rowCount, auditCount: audits.length, nativeTransactions: probe.nativeTransactions, configuredTxDeadlineMs: 300_000 }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ fetched: 17_000, created: 17_000, skipped: 0 });
    expect(pages).toBe(34); expect(rowCount).toBe(17_000); expect(audits).toHaveLength(1);
    expect(audits[0].id).toBe(response.body.auditId); expect(audits[0].actorId).toBe(item.userId);
    expect(probe.nativeTransactions).toBe(1); expect(wallTimeMs).toBeLessThan(300_000);
    expect(app.changes).toHaveLength(1);

    const expired = await fixture('real-deadline'), before = await snapshot(expired), deadline: Probe = { deadline: true };
    const failedApp = application(intercepted(expired, deadline), expired), failureStarted = performance.now();
    const failed = await sync(expired, failedApp);
    console.info(JSON.stringify({ case: 'PD13-native-private-PG-deadline', deadlineMs: 1_000,
      actualPrefixRows: deadline.actualPrefixRows, actualCode: deadline.actualCode,
      wallTimeMs: Math.round(performance.now() - failureStarted), httpStatus: failed.status,
      committedRows: await db().pdmlRawFabric.count({ where: { gsid: expired.gsid } }) }));
    expect(deadline.reached).toBe(true); expect(deadline.actualPrefixRows).toBe(1); expect(deadline.actualCode).toBe('P2028');
    expect(failed.status).toBe(500); expect(code(failed)).toBe('INTERNAL_ERROR'); await unchanged(expired, before, failedApp);
  }, 360_000);
});
