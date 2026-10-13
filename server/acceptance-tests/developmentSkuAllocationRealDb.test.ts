/** Actual isolated PG only. Native source producers create approval/recognition
 * facts; initial accounts/customer/factory and occupied SKU rows are synthetic.
 * A storage Proxy injects a real independent manual INSERT or failing SQL, never
 * an authorization result, approval flag, successful fake create or fake P2002.
 * Test-first: existing converters are callable before the allocator is added.
 * This does not prove physical goods or company approval/numbering policy. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createSampleRouter } from '../src/samples/sampleRoute';
import { createSampleBatch, advanceSampleBatchStage, createSealSample, sealSampleConfirm, convertToFabricAsset } from '../src/development/fabricDevelopmentService';
import { convertToGarmentAsset } from '../src/development/garmentDevelopmentService';
import { todayLocalKey } from '../src/shared/localDate';

const prefix = 'acceptance-development-sku-' + randomUUID(), ymd = () => todayLocalKey().replace(/-/g, '');
let prisma: PrismaClient | undefined, sequence = 0;
const connections: PrismaClient[] = [];
const db = (): PrismaClient => { if (!prisma) throw Error('Independent SKU PG identity not verified'); return prisma; };
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed private PG identity required');
  const url = new URL(DATABASE_URL); expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe('/' + name); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/); expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1'); prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`).toEqual([{ name, directory, port: Number(port) }]);
  await db().role.upsert({ where: { id: 'manager' }, update: {}, create: { id: 'manager', name: 'Synthetic existing leader', isSystem: true } });
});
afterAll(async () => { vi.restoreAllMocks(); await Promise.all(connections.map(connection => connection.$disconnect())); await prisma?.$disconnect(); });
async function actor(id: string, scopes: string[]) {
  await db().userAccount.create({ data: { id, displayName: id, status: 'active' } });
  await db().userRole.create({ data: { id: id + '-role', userId: id, roleId: 'manager' } });
  await db().userPermissionOverrides.createMany({ data: scopes.map(scope => ({ id: id + '-' + scope, userId: id, scope, isActive: true, grantedBy: id, reason: 'Exact synthetic capability, not company role policy' })) });
  const trusted = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), id)); expect(trusted.authorizationLoaded).toBe(true);
  return { id, trusted, token: createAuthService().signToken(trusted) };
}
function app() {
  const result = express(); result.use(express.json()); result.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  result.use(createAccountStatusGuard(db())); result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1/samples', createSampleRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() })); return result;
}
async function fixture(kind: 'fabric' | 'garment', label: string) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), sales = await actor(id + '-sales', ['products:read', 'products:write']);
  const customerId = id + '-customer', factoryId = id + '-factory', caseId = id + '-case';
  for (const [relationId, category] of [[customerId, 'Client'], [factoryId, 'Supplier']]) await db().relation.create({ data: { id: relationId, name: relationId, category, type: 'Company', isOrganization: true,
    ownerId: sales.id, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
  await db().developmentCase.create({ data: { id: caseId, code: caseId, name: id, type: kind, stage: 'developing', owner: sales.id,
    customerRelationId: customerId, customerName: customerId, supplierRelationId: factoryId, supplierName: factoryId,
    styleSpec: kind === 'garment' ? 'Synthetic actual native source' : null, sizeSpec: kind === 'garment' ? 'S/M/L' : null,
    tags: [], createdAt: now, updatedAt: now } });
  let sourceId: string, batchId: string;
  if (kind === 'fabric') {
    const created = await createSampleBatch({ prisma: db(), caseId, actorId: sales.id, input: { sampleType: 'yardage', supplierRelationId: factoryId } }); expect(created.ok, json(created)).toBe(true);
    batchId = (created as any).data.batch.id;
    for (const action of ['start', 'send', 'approve'] as const) {
      const current = await db().sampleBatch.findUniqueOrThrow({ where: { id: batchId } });
      const result = await advanceSampleBatchStage({ prisma: db(), batchId, actorId: sales.id, trustedActor: sales.trusted, action,
        input: { requestKey: randomUUID(), expectedRound: current.round, expectedRevision: (current.attachments as any)?.fabricHistory?.revision ?? 0,
          feedback: action === 'approve' ? 'Synthetic software-only customer observation, no real customer assertion' : undefined } }); expect(result.ok, json(result)).toBe(true);
    }
    const sealed = await createSealSample({ prisma: db(), caseId, actorId: sales.id, input: { batchIds: [batchId], name: 'Synthetic native sealed source' } }); expect(sealed.ok, json(sealed)).toBe(true);
    sourceId = (sealed as any).data.seal.id; const confirmed = await sealSampleConfirm({ prisma: db(), sealId: sourceId, actorId: sales.id, trustedActor: sales.trusted }); expect(confirmed.ok, json(confirmed)).toBe(true);
  } else {
    const qc = await actor(id + '-qc', ['products:read', 'qc:garment_chain:write']), application = app();
    const created = await request(application).post(`/api/v1/samples/garment/${caseId}/rounds`).set('Authorization', 'Bearer ' + sales.token)
      .send({ purpose: 'Synthetic SKU source', version: 'V1', materialConfig: 'Synthetic native configuration', supplierRelationId: factoryId, supplierName: factoryId }); expect(created.status, json(created.body)).toBe(201);
    batchId = created.body.round.id;
    const inspected = await request(application).post(`/api/v1/samples/garment/${batchId}/submit-qc`).set('Authorization', 'Bearer ' + qc.token)
      .send({ result: 'passed', qcNote: 'Synthetic software-only QC observation, no actual physical inspection claimed' }); expect(inspected.status, json(inspected.body)).toBe(200); expect(inspected.body.round.qcReviewedBy).toBe(qc.id);
    const sent = await request(application).post(`/api/v1/samples/garment/${batchId}/submit-customer`).set('Authorization', 'Bearer ' + sales.token)
      .send({ courier: 'Synthetic no external action', trackingNumber: id, recipientName: 'Synthetic receiver', sentDate: '2099-10-01' }); expect(sent.status, json(sent.body)).toBe(200);
    const confirmed = await request(application).post(`/api/v1/samples/garment/${batchId}/register-customer-confirmation`).set('Authorization', 'Bearer ' + sales.token)
      .send({ result: 'approved', confirmationDate: '2099-10-01', channel: 'Synthetic software-only observation', note: 'No real customer approval claimed' }); expect(confirmed.status, json(confirmed.body)).toBe(200);
    const sealed = await request(application).post(`/api/v1/samples/garment/${batchId}/seal`).set('Authorization', 'Bearer ' + sales.token).send({ retainLocation: 'Synthetic fixture shelf' }); expect(sealed.status, json(sealed.body)).toBe(200); sourceId = batchId;
  }
  return { id, kind, sales, caseId, sourceId, batchId, skuPrefix: kind === 'fabric' ? 'FB' : 'GR' };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function convert(f: Fixture, database: any = db(), batch = false, input?: any) {
  const args = { prisma: database, caseId: f.caseId, sourceType: 'seal' as const, sourceId: f.sourceId, actorId: f.sales.id, trustedActor: f.sales.trusted };
  return f.kind === 'fabric' ? convertToFabricAsset({ ...args, ...(batch ? { sourceType: 'batch' as const, sourceId: f.batchId, input } : {}) }) : convertToGarmentAsset(args);
}
async function initialAsset(sku: string, category = 'Fabric', deleted = false) {
  return db().productAsset.create({ data: { id: prefix + '-initial-' + randomUUID(), sku, name: 'INITIAL occupied SKU, no approval/profile assertion', mainCategory: category,
    subCategoryId: 'uncategorized', season: '', cost: null, status: 'Development', source: 'development', updatedAt: BigInt(Date.now()), deletedAt: deleted ? BigInt(Date.now()) : null } });
}
async function fixedOccupied(f: Fixture, deleted: boolean) {
  const occupied = new Set((await db().productAsset.findMany({ where: { sku: { startsWith: `${f.skuPrefix}-${ymd()}-` } }, select: { sku: true } })).map(row => row.sku));
  let slot = 0xe001; while (occupied.has(`${f.skuPrefix}-${ymd()}-${slot.toString(16).toUpperCase().padStart(4, '0')}`) || slot % 16 === 0) slot++;
  expect(slot).toBeLessThan(0xffff); const sku = `${f.skuPrefix}-${ymd()}-${slot.toString(16).toUpperCase().padStart(4, '0')}`;
  const initial = await initialAsset(sku, f.kind === 'fabric' ? 'Garment' : 'Fabric', deleted); return { initial, random: slot / 65536 };
}
async function snapshot(f: Fixture) {
  const source = f.kind === 'fabric' ? await db().sealSample.findUnique({ where: { id: f.sourceId } }) : await db().sampleBatch.findUnique({ where: { id: f.sourceId } });
  return json({ case: await db().developmentCase.findUnique({ where: { id: f.caseId } }), source,
    batches: await db().sampleBatch.findMany({ where: { developmentCaseId: f.caseId }, orderBy: { id: 'asc' } }),
    samples: await db().sample.findMany({ where: { sourceCaseId: f.caseId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.sales.id }, orderBy: { id: 'asc' } }),
    assets: await db().productAsset.findMany({ where: { sourceDetail: { contains: f.caseId } }, orderBy: { id: 'asc' } }) });
}
function wrapped(probe: { create?: (tx: any, input: any, perform: () => Promise<any>) => Promise<any>; auditFailure?: boolean; queryFailure?: boolean; pid?: (value: number) => void }) {
  return new Proxy(db(), { get(target, property) {
    if (property !== '$transaction') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
    return (work: any, options: any) => target.$transaction(async (tx: any) => {
      if (probe.pid) probe.pid((await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid);
      const proxy = new Proxy(tx, { get(inner, delegate) {
        const value = inner[delegate];
        if (delegate === 'productAsset') return new Proxy(value, { get(model, method) {
          if (method === 'findMany' && probe.queryFailure) return () => tx.$queryRawUnsafe('SELECT missing_development_sku_column FROM "ProductAsset"');
          if (method === 'create' && probe.create) return (args: any) => probe.create!(tx, args, () => model.create(args));
          const fn = model[method]; return typeof fn === 'function' ? fn.bind(model) : fn;
        } });
        if (delegate === 'auditLog' && probe.auditFailure) return new Proxy(value, { get(model, method) {
          if (method === 'create') return (args: any) => model.create({ ...args, data: { ...args.data, actorId: 'missing-sku-audit-' + prefix } });
          const fn = model[method]; return typeof fn === 'function' ? fn.bind(model) : fn;
        } });
        return typeof value === 'function' ? value.bind(inner) : value;
      } }); return work(proxy);
    }, options);
  } }) as any;
}
const safe = (result: any) => expect(json(result)).not.toMatch(/P2002|P2003|P2010|23503|42703|sku_key|missing_development_sku_column|Foreign key|constraint/i);
describe('native development SKU allocation, actual occupied rows and SQL conflicts', () => {
  it.each(['fabric', 'garment'] as const)('DSA01 %s live occupied SKU of another category cannot collide or be overwritten', async kind => {
    const f = await fixture(kind, 'live-' + kind), collision = await fixedOccupied(f, false), before = await db().productAsset.findUniqueOrThrow({ where: { id: collision.initial.id } });
    const random = vi.spyOn(Math, 'random').mockReturnValue(collision.random); let result: any; try { result = await convert(f); } finally { random.mockRestore(); }
    expect(result.ok, json(result)).toBe(true); expect(result.data.asset.sku).toMatch(new RegExp(`^${f.skuPrefix}-${ymd()}-[A-F0-9]{4}$`)); expect(result.data.asset.sku).not.toBe(before.sku);
    expect(await db().productAsset.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await db().auditLog.count({ where: { actorId: f.sales.id, action: kind === 'fabric' ? 'convert_fabric_to_asset' : 'convert_garment_to_asset', targetId: result.data.asset.id } })).toBe(1);
  });
  it.each(['fabric', 'garment'] as const)('DSA02 %s soft-deleted occupied SKU stays reserved without rewriting history', async kind => {
    const f = await fixture(kind, 'deleted-' + kind), collision = await fixedOccupied(f, true), before = await db().productAsset.findUniqueOrThrow({ where: { id: collision.initial.id } });
    const random = vi.spyOn(Math, 'random').mockReturnValue(collision.random); let result: any; try { result = await convert(f); } finally { random.mockRestore(); }
    expect(result.ok, json(result)).toBe(true); expect(result.data.asset.sku).not.toBe(before.sku); expect(await db().productAsset.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });
  it.each(['fabric', 'garment'] as const)('DSA03 %s manual independent INSERT after selection creates real P2002; savepoint recovery still commits one exact asset and audit', async kind => {
    const f = await fixture(kind, 'manual-race-' + kind); let manual: any, intercepted = false;
    const result: any = await convert(f, wrapped({ create: async (_tx, input, perform) => {
      if (!intercepted) { intercepted = true; manual = await initialAsset(input.data.sku, kind === 'fabric' ? 'Garment' : 'Fabric'); }
      return perform();
    } }));
    expect(intercepted).toBe(true); expect(result.ok, json(result)).toBe(true); expect(result.data.asset.sku).not.toBe(manual.sku);
    expect(await db().productAsset.findUniqueOrThrow({ where: { id: manual.id } })).toEqual(manual);
    expect(await db().auditLog.count({ where: { actorId: f.sales.id, action: kind === 'fabric' ? 'convert_fabric_to_asset' : 'convert_garment_to_asset', targetId: result.data.asset.id } })).toBe(1);
  });
  it('DSA04 concurrent native fabric sources actually wait on same namespace and receive distinct stable slots', async () => {
    const first = await fixture('fabric', 'concurrent-A'), second = await fixture('fabric', 'concurrent-B'); let release!: () => void, held!: () => void, secondPid = 0;
    const hold = new Promise<void>(resolve => { release = resolve; }), holding = new Promise<void>(resolve => { held = resolve; });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0xe00f / 65536);
    const a = convert(first, wrapped({ create: async (_tx, _input, perform) => { const result = await perform(); held(); await hold; return result; } }));
    let b: Promise<any> | undefined, waitSeen = false;
    try {
      await Promise.race([holding, a.then(result => { throw Error('First actual conversion did not reach held create: ' + json(result)); })]);
      b = convert(second, wrapped({ pid: value => { secondPid = value; } }));
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        if (secondPid) { const result: any = await db().$queryRaw`SELECT pg_blocking_pids(pid) AS blocked,wait_event FROM pg_stat_activity WHERE pid=${secondPid}::int`;
          if (result[0]?.blocked.length && result[0].wait_event === 'advisory') { waitSeen = true; break; } }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release(); random.mockRestore(); }
    const results: any[] = await Promise.all([a, b]); expect(waitSeen).toBe(true); results.forEach(result => expect(result.ok, json(result)).toBe(true));
    expect(new Set(results.map(result => result.data.asset.sku)).size).toBe(2); expect(results[0].data.asset.id).not.toBe(results[1].data.asset.id);
  });
  it('DSA05 actual required audit FK failure rolls back allocation, asset/profile and source projection', async () => {
    const f = await fixture('fabric', 'audit-failure'), before = await snapshot(f), result: any = await convert(f, wrapped({ auditFailure: true }));
    expect(result.ok).toBe(false); expect(result.error.status).toBe(500); safe(result); expect(await snapshot(f)).toBe(before);
  });
  it('DSA06 actual occupied-SKU SELECT fault is not an empty namespace or successful conversion', async () => {
    const f = await fixture('fabric', 'occupied-read-failure'), before = await snapshot(f), result: any = await convert(f, wrapped({ queryFailure: true }));
    expect(result.ok).toBe(false); expect(result.error.status).toBe(500); safe(result); expect(await snapshot(f)).toBe(before);
  });
  it('DSA07 a real ProductAsset id collision is not treated as a recoverable SKU conflict', async () => {
    const f = await fixture('fabric', 'id-collision'), initial = await initialAsset(`INITIAL-${prefix}-${randomUUID()}`), before = await snapshot(f);
    const result: any = await convert(f, wrapped({ create: async (tx, input) => tx.productAsset.create({ data: { ...input.data, id: initial.id } }) }));
    expect(result.ok).toBe(false); expect(result.error.status).toBe(500); safe(result); expect(await snapshot(f)).toBe(before); expect(await db().productAsset.findUnique({ where: { id: initial.id } })).toEqual(initial);
  });
  it('DSA08 original batch conversion ACK replay returns its asset before attempting any new SKU allocation', async () => {
    const f = await fixture('fabric', 'original-replay'), current = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.batchId } }), input = { requestKey: randomUUID(), expectedRound: current.round, expectedRevision: (current.attachments as any)?.fabricHistory?.revision ?? 0 };
    const original: any = await convert(f, db(), true, input); expect(original.ok, json(original)).toBe(true); const before = await snapshot(f);
    const replay: any = await convert(f, wrapped({ queryFailure: true }), true, input); expect(replay.ok, json(replay)).toBe(true); expect(replay.data.asset).toEqual(original.data.asset); expect(await snapshot(f)).toBe(before);
  });
});
