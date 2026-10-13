/**
 * Neutral ProductionBatch contract, private PG only. Implementation and
 * migration 9 are deliberately not supplied by this file; never skip an absent
 * producer/delegate or substitute a mock authorization decision to make it pass.
 *
 * Independent source: V1实际批次与验货交接契约-2026-10-02.md §§2–5 and the
 * existing Orders current grants/credential ceiling/customer L2 contract.
 * Native Seal -> Asset -> OrderLine version producers establish the source.
 * Exact private grants demonstrate technical capability, not company UAT or a
 * new role policy. A batch quantity is a controlled range, not manufactured,
 * received, stock, QC-approved or PP-approved goods. No such fact is seeded.
 *
 * Router contract: createProductionBatchRouter({prisma, requireAuth, apiKeys,
 * onDataChange}); GET lineFingerprint/batches, POST batch/replayed, split
 * parent/children/replayed. Audit actions: create_production_batch and
 * split_production_batch. These are producer/ACK contracts, not permission codes.
 * expectedLineFingerprint is a current range-basis token, NOT a fictitious
 * OrderLine.updatedAt or a monotonic time version. Only native GET supplies it.
 *
 * JWT middleware/current DB loaders/storage/row locks are real. Proxies only
 * observe transaction backend PID or cause a physical failing SQL/FK query.
 * No index/seed/scheduler/AI/MCP/external action starts; no shared DB is accepted.
 * This file alone does not prove batch QC, SOA, inventory or delivery closure.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { resolveCurrentProductionBatchFacts } from '../src/production/productionBatchService';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-production-batch-${randomUUID()}`;
const auth = createAuthService();
const successActions = ['create_production_batch', 'split_production_batch'];
let prisma: PrismaClient | undefined, sequence = 0;
const connections: PrismaClient[] = [];
function db(): PrismaClient { if (!prisma) throw Error('Independent ProductionBatch identity not verified'); return prisma; }
const batches = (client: any = db()) => client.productionBatch;
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const code = (r: any) => r.body.error?.code ?? r.body.error;
const safeBody = (r: any) => expect(diagnostic(r.body)).not.toMatch(/P2003|P2010|23503|42703|Foreign key|constraint|missing_batch_probe|nonexistent-audit-actor/i);

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated PG is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  // The canonical role identity is supported by the real loader. No role grant
  // or matrix is edited; all fixture capabilities are explicit personal grants.
  await db().role.upsert({ where: { id: 'manager' }, update: {}, create: { id: 'manager', name: 'Synthetic current leader', isSystem: true } });
});
afterAll(async () => { await Promise.all(connections.map(c => c.$disconnect())); await prisma?.$disconnect(); });

async function fixture(label: string, shared = false) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), userId = `${id}-user`,
    customerId = `${id}-customer`, supplierId = `${id}-factory`, caseId = `${id}-case`,
    orderId = `${id}-order`, lineId = `${id}-line`, otherUserId = `${id}-other-user`, teamId = `${id}-team`, shareId = `${id}-share`;
  await db().$transaction(async tx => {
    for (const uid of [userId, otherUserId]) await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic current account', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'manager' } });
    await tx.userPermissionOverrides.createMany({ data: [
      'orders:read', 'orders:write', 'products:read', 'products:write', 'production:read',
    ].map(scope => ({ id: `${id}-${scope}`, userId, scope, isActive: true, grantedBy: userId, reason: 'Exact private technical grant, not company approval policy' })) });
    await tx.relation.create({ data: { id: customerId, name: customerId, category: 'Customer', type: 'Company', isOrganization: true,
      ownerId: shared ? otherUserId : userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.relation.create({ data: { id: supplierId, name: supplierId, category: 'Supplier', type: 'Company', isOrganization: true,
      ownerId: userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.developmentCase.create({ data: { id: caseId, code: caseId, name: 'Synthetic genuine source', type: 'fabric', stage: 'developing',
      owner: userId, customerRelationId: customerId, customerName: customerId, tags: [], createdAt: now, updatedAt: now } });
    await tx.order.create({ data: { id: orderId, poNumber: orderId, customer: customerId, customerRelationId: customerId,
      product: 'Synthetic fabric', type: 'fabric', quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10,
      ownerId: userId, millRelationId: supplierId, sourceCaseId: caseId, importedAt: now, updatedAt: now } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: '10', unit: 'm',
      description: 'Synthetic controlled physical range', tolerancePercent: '25', toleranceSource: 'line_override' } });
    if (shared) {
      await tx.team.create({ data: { id: teamId, name: 'Synthetic current L2 team', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
      await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
        permission: 'read+followup', grantedBy: otherUserId } });
    }
  });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  expect(actor.authorizationLoaded).toBe(true); expect(actor.roles).toContain('manager'); expect(actor.permissions).toContain('orders:write');
  const f = { id, userId, otherUserId, customerId, supplierId, caseId, orderId, lineId, actor, teamId, shareId, sealId: '', assetId: '' };
  // Native independent source, not a newly invented "approved" boolean.
  const made = await createSampleBatch({ prisma: db(), caseId, actorId: userId, input: { sampleType: 'yardage', supplierRelationId: supplierId } });
  expect(made.ok, diagnostic(made)).toBe(true); const sampleBatchId = (made as any).data.batch.id;
  for (const action of ['start', 'send', 'approve'] as const) {
    const current = await db().sampleBatch.findUniqueOrThrow({ where: { id: sampleBatchId } });
    const advanced = await advanceSampleBatchStage({ prisma: db(), batchId: sampleBatchId, actorId: userId, trustedActor: actor, action,
      input: { requestKey: randomUUID(), expectedRound: current.round, expectedRevision: (current.attachments as any)?.fabricHistory?.revision ?? 0,
        feedback: action === 'approve' ? 'Synthetic explicitly recorded customer recognition' : undefined } });
    expect(advanced.ok, diagnostic(advanced)).toBe(true);
  }
  const seal = await createSealSample({ prisma: db(), caseId, actorId: userId, input: { batchIds: [sampleBatchId], name: 'Synthetic native standard' } });
  expect(seal.ok, diagnostic(seal)).toBe(true); f.sealId = (seal as any).data.seal.id;
  const sealed = await sealSampleConfirm({ prisma: db(), sealId: f.sealId, actorId: userId, trustedActor: actor }); expect(sealed.ok, diagnostic(sealed)).toBe(true);
  const asset = await convertToFabricAsset({ prisma: db(), caseId, sourceType: 'seal', sourceId: f.sealId, actorId: userId, trustedActor: actor });
  expect(asset.ok, diagnostic(asset)).toBe(true); f.assetId = (asset as any).data.asset.id;
  const sourceApp = express(); sourceApp.use(express.json());
  sourceApp.set('json replacer', (_key: string, item: any) => typeof item === 'bigint' ? item.toString() : item);
  sourceApp.use('/order-lines', createOrderLinesRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  const selected = await request(sourceApp).patch(`/order-lines/${lineId}/version`).set('Authorization', `Bearer ${auth.signToken(actor)}`)
    .send({ confirmedSourceType: 'SealSample', confirmedSourceId: f.sealId, millRelationId: supplierId });
  expect(selected.status, diagnostic(selected.body)).toBe(200);
  const current = await db().orderLine.findUniqueOrThrow({ where: { id: lineId } });
  expect(current.confirmedSourceId).toBe(f.sealId); expect(current.specSnapshot).not.toBeNull();
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Change = { entity: string; action: string; ids?: string[] };
function application(client: PrismaClient = db(), requireAuth = true) {
  const app = express(), changes: Change[] = [];
  app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/production-batches', createProductionBatchRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  return { app, changes };
}
const base = (f: Fixture) => `/api/v1/production-batches/orders/${f.orderId}/lines/${f.lineId}`;
async function listing(f: Fixture, app = application(), actor: TokenPayload = f.actor) {
  const r = await request(app.app).get(base(f)).set('Authorization', `Bearer ${auth.signToken(actor)}`);
  expect(r.status, diagnostic(r.body)).toBe(200); expect(r.body.ok).toBe(true);
  expect(r.body.lineFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(Array.isArray(r.body.batches)).toBe(true); return r;
}
async function command(f: Fixture, quantity = '3.25', label = 'A') {
  return { batchCode: `${f.id}-${label}`, quantity, unit: 'm', expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID() };
}
type CreateCommand = Awaited<ReturnType<typeof command>>;
const create = (f: Fixture, body: any, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(base(f)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
const split = (f: Fixture, parentId: string, body: any, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(`/api/v1/production-batches/${parentId}/split`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function splitCommand(f: Fixture, parent: any, quantities = ['1.25', '2']) {
  return { expectedRevision: parent.revision, expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID(),
    children: quantities.map((quantity, i) => ({ batchCode: `${f.id}-child-${i}`, quantity })) };
}
async function created(f: Fixture, body: CreateCommand, app = application()) {
  const r = await create(f, body, app); expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.ok).toBe(true);
  expect(r.body.replayed).toBe(false); const actual = await batches().findUniqueOrThrow({ where: { id: r.body.batch.id } });
  expect(actual.createdBy).toBe(f.userId); expect(actual.requestKey).toBe(body.requestKey);
  expect(actual.parameterHash).toMatch(/^[a-f0-9]{64}$/); expect(actual.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(actual.commandSnapshot).toMatchObject({ ...body, quantity: new Prisma.Decimal(body.quantity).toString() }); return { response: r, batch: actual };
}
async function snapshot(f: Fixture) {
  const scopes = await db().releaseScope.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
  const scopeIds = scopes.map(s => s.id);
  const requests = await db().releaseRequest.findMany({ where: { scopeId: { in: scopeIds } }, orderBy: { id: 'asc' } });
  return {
    order: await db().order.findUniqueOrThrow({ where: { id: f.orderId } }),
    line: await db().orderLine.findUniqueOrThrow({ where: { id: f.lineId } }),
    batches: await batches().findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    successAudits: await db().auditLog.findMany({ where: { actorId: f.userId, action: { in: successActions } }, orderBy: { id: 'asc' } }),
    scopes,
    requests,
    signatures: await db().releaseSignature.findMany({ where: { requestId: { in: requests.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    releases: await db().ppSampleRelease.findMany({ where: { scopeId: { in: scopeIds } }, orderBy: { id: 'asc' } }),
    releaseEvents: await db().releaseEvent.findMany({ where: { scopeId: { in: scopeIds } }, orderBy: { id: 'asc' } }),
    qc: await db().inspectionReport.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    inventory: await db().stockMovement.findMany({ where: { referenceType: 'Order', referenceId: f.orderId }, orderBy: { id: 'asc' } }),
  };
}
async function unchanged(f: Fixture, before: Awaited<ReturnType<typeof snapshot>>, app: ReturnType<typeof application>) {
  expect(await snapshot(f), 'Denied operation cannot change range/source/PP/QC/stock/success audit; denial audits may exist').toEqual(before);
  expect(app.changes).toEqual([]);
}
function noPhysicalOrApprovalFact(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  for (const key of ['order', 'line', 'scopes', 'requests', 'signatures', 'releases', 'releaseEvents', 'qc', 'inventory'] as const) expect(after[key]).toEqual(before[key]);
}
function activePartition(rows: any[], expectedTotal: string) {
  const active = rows.filter(b => b.state === 'active').sort((a, b) => new Prisma.Decimal(a.rangeStart).comparedTo(new Prisma.Decimal(b.rangeStart)));
  let end = new Prisma.Decimal(0), total = new Prisma.Decimal(0);
  for (const b of active) {
    const start = new Prisma.Decimal(b.rangeStart), qty = new Prisma.Decimal(b.quantity);
    expect(start.greaterThanOrEqualTo(end), 'No physical coordinate overlap').toBe(true); expect(qty.greaterThan(0)).toBe(true);
    end = start.plus(qty); total = total.plus(qty);
  }
  expect(total.toString()).toBe(expectedTotal); expect(end.lessThanOrEqualTo(10)).toBe(true); return active;
}
async function connection() {
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } }); connections.push(client);
  expect(await client.$queryRaw`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`)
    .toEqual([{ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) }]);
  return client;
}
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Probe = { auditFault?: boolean; sourceFault?: boolean; grantFault?: boolean; scopeFault?: boolean; reached?: boolean; pids?: number[] };
function intercepted(client: PrismaClient, probe: Probe): PrismaClient {
  return new Proxy(client, { get(target, key) {
    if (key === '$transaction') return (work: any, options?: any) => target.$transaction(async tx => {
      if (probe.pids) { const [actual] = await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid'); probe.pids.push(actual.pid); }
      return work(new Proxy(tx, { get(transaction, delegate) {
        if (delegate === 'auditLog' && probe.auditFault) return new Proxy(transaction.auditLog, { get(model, method) {
          if (method === 'create') return (arg: any) => {
            if (!successActions.includes(arg.data.action)) return model.create(arg);
            probe.reached = true;
            return model.create({ ...arg, data: { ...arg.data, actorId: `${prefix}-nonexistent-audit-actor` } });
          };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const fault = (probe.sourceFault && ['sealSample', 'productAsset'].includes(String(delegate)))
          || (probe.grantFault && delegate === 'userPermissionOverrides') || (probe.scopeFault && delegate === 'teamMember');
        if (fault) return new Proxy(Reflect.get(transaction, delegate), { get(model, method) {
          if (['findFirst', 'findUnique', 'findMany', 'findUniqueOrThrow'].includes(String(method))) return async () => {
            probe.reached = true; return transaction.$queryRaw`SELECT "missing_batch_probe_column" FROM "UserAccount" LIMIT 1`;
          };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
      } }));
    }, { ...options, timeout: 20_000, maxWait: 10_000 });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
/** Independent blocker actually owns the Order lock. No artificial lock return,
 * fictional DB rows, timing-only barrier or relaxed concurrency assertion. */
async function afterActualWait(f: Fixture, execute: (app: ReturnType<typeof application>) => Promise<any>, mutate: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const holder = await connection(), writer = await connection(), held = signal(), release = signal(), probe: Probe = { pids: [] };
  let holderPid = 0, finished = false;
  const holding = holder.$transaction(async tx => {
    const [identity] = await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid'); holderPid = identity.pid;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${f.orderId} FOR UPDATE`; held.resolve();
    await release.promise; await mutate(tx);
  }, { timeout: 20_000, maxWait: 10_000 });
  await held.promise; const app = application(intercepted(writer, probe));
  const writing = execute(app).then(r => { finished = true; return r; });
  try {
    let witnessed = false;
    for (let n = 0; n < 200; n++) {
      if (finished) throw Error('Command completed before the actual Order lock wait');
      if (probe.pids?.length) {
        const [actual] = await db().$queryRawUnsafe<any[]>('SELECT pg_blocking_pids($1::integer) AS blockers', probe.pids[0]);
        if (actual.blockers.includes(holderPid)) { witnessed = true; break; }
      }
      await new Promise(done => setTimeout(done, 20));
    }
    expect(witnessed, 'pg_blocking_pids must show actual holder').toBe(true);
    release.resolve(); await holding; return { response: await writing, app };
  } finally { release.resolve(); await Promise.allSettled([holding, writing]); }
}
async function competing(f: Fixture, commands: Array<(app: ReturnType<typeof application>) => Promise<any>>) {
  const holder = await connection(), held = signal(), release = signal(); let holderPid = 0;
  const holding = holder.$transaction(async tx => {
    const [actual] = await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid'); holderPid = actual.pid;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${f.orderId} FOR UPDATE`; held.resolve(); await release.promise;
  }, { timeout: 20_000, maxWait: 10_000 });
  await held.promise;
  const probes: Probe[] = [{ pids: [] }, { pids: [] }], clients = await Promise.all([connection(), connection()]);
  const apps = clients.map((client, i) => application(intercepted(client, probes[i])));
  const writing = Promise.all(commands.map((run, i) => run(apps[i])));
  try {
    let actualWait = false;
    for (let n = 0; n < 200; n++) {
      const ids = probes.flatMap(p => p.pids ?? []);
      if (ids.length === 2) {
        const rows = await db().$queryRawUnsafe<any[]>('SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=ANY($1::integer[])', ids);
        if (rows.length === 2 && rows.every(r => r.blockers.length > 0) && rows.some(r => r.blockers.includes(holderPid))) { actualWait = true; break; }
      }
      await new Promise(done => setTimeout(done, 20));
    }
    expect(actualWait, 'Both independent commands must be in the real lock wait graph').toBe(true);
    release.resolve(); await holding; return { responses: await writing, apps };
  } finally { release.resolve(); await Promise.allSettled([holding, writing]); }
}

describe.sequential('ProductionBatch native neutral-range PG contract', () => {
  it('PB01 genuine source/factory/spec freezes two nonoverlapping ranges, without PP/QC/stock/Order mutation', async () => {
    const f = await fixture('two-ranges'), before = await snapshot(f), app = application();
    const a = await created(f, await command(f, '3.2500', 'A'), app), b = await created(f, await command(f, '6.75', 'B'), app);
    expect(a.batch.id).not.toBe(b.batch.id); expect(a.batch.id).not.toBe(a.batch.batchCode);
    const after = await snapshot(f), active = activePartition(after.batches, '10');
    expect(active.map(row => [row.rangeStart.toString(), row.quantity.toString()])).toEqual([['0', '3.25'], ['3.25', '6.75']]);
    for (const row of active) expect(row).toMatchObject({ orderId: f.orderId, orderLineId: f.lineId, factoryRelationId: f.supplierId,
      unit: 'm', revision: 1, state: 'active', parentBatchId: null, confirmedSourceType: 'SealSample', confirmedSourceId: f.sealId, specSnapshot: before.line.specSnapshot });
    noPhysicalOrApprovalFact(before, after); expect(after.successAudits).toHaveLength(2);
    expect(after.successAudits.every(audit => audit.actorId === f.userId)).toBe(true);
    expect((await listing(f)).body.batches.map((row: any) => row.id).sort()).toEqual(active.map(row => row.id).sort());
  });
  it('PB02 customer shipment tolerance cannot permit manufacturing range beyond the actual line', async () => {
    const f = await fixture('over-line'); await created(f, await command(f, '6', 'A'));
    const input = await command(f, '4.0001', 'B'), before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
  });
  it.each(['0', '-1', '1.00001', '1e1', 'NaN', '', null] as const)('PB03 invalid/noncanonical/five-decimal quantity %s is rejected without rounding or a batch', async value => {
    const f = await fixture('quantity'), input = { ...await command(f), quantity: value }, before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(400); expect(code(r)).toBe('INVALID_INPUT'); await unchanged(f, before, app);
  });
  it('PB04 exact four-decimal partition does not lose the final 0.0001 through floating arithmetic', async () => {
    const f = await fixture('decimal-edge'); await created(f, await command(f, '9.9999', 'A')); await created(f, await command(f, '0.0001', 'B'));
    const active = activePartition((await snapshot(f)).batches, '10'); expect(active[1].rangeStart.toString()).toBe('9.9999');
  });
  it.each(['pcs', '', 'unknown-unit'])('PB05 incompatible/unknown unit %s cannot replace the real line unit', async unit => {
    const f = await fixture('unit'), input = { ...await command(f), unit }, before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(400); await unchanged(f, before, app);
  });
  it.each(['confirmedSourceType', 'confirmedSourceId', 'specSnapshot', 'factoryRelationId', 'rangeStart', 'id', 'actor'])('PB06 body field %s cannot override server-frozen ownership/source/range', async field => {
    const f = await fixture('body-override'), input = { ...await command(f), [field]: field === 'actor' ? { userId: f.otherUserId, roles: ['owner'], permissions: ['*'] } : 'synthetic-forged-value' }, before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(400); expect(code(r)).toBe('INVALID_INPUT'); await unchanged(f, before, app);
  });
  it.each(['absent', 'wrong'] as const)('PB07 %s current line fingerprint fails closed', async mode => {
    const f = await fixture('fingerprint'), input: any = await command(f); if (mode === 'absent') delete input.expectedLineFingerprint; else input.expectedLineFingerprint = '0'.repeat(64);
    const before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(mode === 'absent' ? 400 : 409); await unchanged(f, before, app);
  });
  it('PB08 original create key returns the original immutable batch identity without duplicate audit', async () => {
    const f = await fixture('create-replay'), input = await command(f), original = await created(f, input), before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(200); expect(r.body.replayed).toBe(true); expect(r.body.batch).toEqual(original.response.body.batch);
    expect(await snapshot(f)).toEqual(before);
  });
  it('PB09 original key with changed quantity is 409, not another range or overwritten command', async () => {
    const f = await fixture('key-conflict'), input = await command(f); await created(f, input);
    const before = await snapshot(f), app = application(), r = await create(f, { ...input, quantity: '2' }, app);
    expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
  });
  it('PB10 two different requests cannot reuse the same per-line business batchCode', async () => {
    const f = await fixture('duplicate-label'), input = await command(f); await created(f, input);
    const before = await snapshot(f), app = application(), r = await create(f, { ...input, requestKey: randomUUID() }, app);
    expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
  });
  it('PB11 split exactly covers parent, parent leaves active partition, original creation/PP history remain', async () => {
    const f = await fixture('split'), made = await created(f, await command(f)), before = await snapshot(f), input = await splitCommand(f, made.batch), app = application();
    const r = await split(f, made.batch.id, input, app); expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.replayed).toBe(false);
    const after = await snapshot(f), parent = after.batches.find((b: any) => b.id === made.batch.id), active = activePartition(after.batches, '3.25');
    expect(parent).toMatchObject({ state: 'split', revision: 2, quantity: made.batch.quantity, rangeStart: made.batch.rangeStart,
      parameterHash: made.batch.parameterHash, requestKey: made.batch.requestKey, commandSnapshot: made.batch.commandSnapshot });
    expect(active.map(b => [b.rangeStart.toString(), b.quantity.toString()])).toEqual([['0', '1.25'], ['1.25', '2']]);
    expect(active.every(b => b.parentBatchId === parent.id && b.revision === 1 && b.confirmedSourceId === parent.confirmedSourceId && b.sourceFingerprint === parent.sourceFingerprint)).toBe(true);
    expect(r.body.children.map((b: any) => b.id).sort()).toEqual(active.map(b => b.id).sort());
    noPhysicalOrApprovalFact(before, after); expect(after.successAudits).toHaveLength(2);
    expect(after.successAudits[0]).toEqual(before.successAudits[0]);
  });
  it.each([['1', '2'], ['1.25', '2.0001'], ['0', '3.25'], ['1.00001', '2.24999']])('PB12 child partition %s/%s is rejected unless positive four-place quantities exactly cover parent', async (a, b) => {
    const f = await fixture('bad-split'), made = await created(f, await command(f)), input = await splitCommand(f, made.batch, [a, b]), before = await snapshot(f), app = application(), r = await split(f, made.batch.id, input, app);
    expect([400, 409], diagnostic(r.body)).toContain(r.status); await unchanged(f, before, app);
  });
  it('PB13 split stale revision rejects without rewriting parent/children/source or approval history', async () => {
    const f = await fixture('split-revision'), made = await created(f, await command(f)), input = await splitCommand(f, made.batch), before = await snapshot(f), app = application();
    const r = await split(f, made.batch.id, { ...input, expectedRevision: 0 }, app); expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
  });
  it('PB14 identical split key replays original children even after parent current revision became split', async () => {
    const f = await fixture('split-replay'), made = await created(f, await command(f)), input = await splitCommand(f, made.batch), app = application();
    const original = await split(f, made.batch.id, input, app); expect(original.status, diagnostic(original.body)).toBe(201);
    const before = await snapshot(f), replay = await split(f, made.batch.id, input);
    expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.parent).toEqual(original.body.parent); expect(replay.body.children).toEqual(original.body.children); expect(await snapshot(f)).toEqual(before);
  });
  it('PB15 changed children under original split key cannot replace immutable split mapping', async () => {
    const f = await fixture('split-key'), made = await created(f, await command(f)), input = await splitCommand(f, made.batch), first = await split(f, made.batch.id, input);
    expect(first.status, diagnostic(first.body)).toBe(201); const before = await snapshot(f), app = application();
    const r = await split(f, made.batch.id, { ...input, children: [{ batchCode: `${f.id}-other-child`, quantity: '3.25' }] }, app);
    expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
  });
  it('PB16 real concurrent capacity requests cannot both consume six of an actual ten-unit line', async () => {
    const f = await fixture('concurrent-capacity'), a = await command(f, '6', 'A'), b = await command(f, '6', 'B');
    const { responses } = await competing(f, [app => create(f, a, app).then(r => r), app => create(f, b, app).then(r => r)]);
    expect(responses.map(r => r.status).sort(), diagnostic(responses.map(r => r.body))).toEqual([201, 409]);
    const after = await snapshot(f); activePartition(after.batches, '6'); expect(after.successAudits).toHaveLength(1);
  });
  it('PB17 real competing split commands create one immutable child partition, never both', async () => {
    const f = await fixture('concurrent-split'), made = await created(f, await command(f)), a = await splitCommand(f, made.batch), b = { ...a, requestKey: randomUUID(), children: [{ batchCode: `${f.id}-alt1`, quantity: '1' }, { batchCode: `${f.id}-alt2`, quantity: '2.25' }] };
    const { responses } = await competing(f, [app => split(f, made.batch.id, a, app).then(r => r), app => split(f, made.batch.id, b, app).then(r => r)]);
    expect(responses.map(r => r.status).sort(), diagnostic(responses.map(r => r.body))).toEqual([201, 409]);
    const after = await snapshot(f); expect(after.batches).toHaveLength(3); activePartition(after.batches, '3.25'); expect(after.successAudits).toHaveLength(2);
  });
  it.each(['spec', 'quantity', 'unit', 'factory', 'customer'] as const)('PB18 actual %s drift committed while command waits for Order lock rejects old fingerprint', async kind => {
    const f = await fixture('wait-drift-' + kind), input = await command(f), before = await snapshot(f);
    const result = await afterActualWait(f, app => create(f, input, app).then(r => r), async tx => {
      if (kind === 'spec') return tx.orderLine.update({ where: { id: f.lineId }, data: { specSnapshot: { actualCommittedWidth: '160' } } });
      if (kind === 'quantity') return tx.orderLine.update({ where: { id: f.lineId }, data: { quantity: '9' } });
      if (kind === 'unit') return tx.orderLine.update({ where: { id: f.lineId }, data: { unit: 'YD' } });
      return tx.order.update({ where: { id: f.orderId }, data: kind === 'factory' ? { millRelationId: null } : { customerRelationId: null } });
    });
    expect(result.response.status, diagnostic(result.response.body)).toBe(409);
    const after = await snapshot(f); expect(after.batches).toEqual(before.batches); expect(after.successAudits).toEqual(before.successAudits); expect(result.app.changes).toEqual([]);
  });
  it('PB19 current grant withdrawn during actual lock wait cannot be restored by stale JWT', async () => {
    const f = await fixture('wait-revoke'), input = await command(f), before = await snapshot(f);
    const { response, app } = await afterActualWait(f, app => create(f, input, app).then(r => r), tx => tx.userPermissionOverrides.update({ where: { userId_scope: { userId: f.userId, scope: 'orders:write' } }, data: { isActive: false } }));
    expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN'); await unchanged(f, before, app);
  });
  it('PB20 actual customer share withdrawn while waiting denies scope rather than owner-based fallback', async () => {
    const f = await fixture('wait-share', true), input = await command(f), before = await snapshot(f);
    const { response, app } = await afterActualWait(f, app => create(f, input, app).then(r => r), tx => tx.teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date(), revokedBy: f.otherUserId } }));
    expect(response.status, diagnostic(response.body)).toBe(404); await unchanged(f, before, app);
  });
  it('PB21 current active grants do not exceed the signed read-only credential ceiling', async () => {
    const f = await fixture('ceiling'), input = await command(f), before = await snapshot(f), app = application();
    const r = await create(f, input, app, { ...f.actor, roles: ['owner'], permissionCeiling: ['orders:read', 'production:read'] });
    expect(r.status, diagnostic(r.body)).toBe(403); await unchanged(f, before, app);
  });
  it('PB22 removed actual role-derived write grant cannot be revived from signed manager/defaults', async () => {
    const f = await fixture('role-grant'), roleId = `${f.id}-configured-role`, membershipId = `${f.id}-configured-membership`;
    await db().role.create({ data: { id: roleId, name: 'Synthetic declared scope carrier', isSystem: false } });
    const permission = await db().permission.upsert({ where: { scope: 'orders:write' }, update: {}, create: { id: `${prefix}-orders-write-permission`, scope: 'orders:write' } });
    await db().rolePermission.create({ data: { id: `${f.id}-role-grant`, roleId, permissionId: permission.id } });
    await db().userRole.create({ data: { id: membershipId, userId: f.userId, roleId } });
    await db().userPermissionOverrides.delete({ where: { userId_scope: { userId: f.userId, scope: 'orders:write' } } });
    const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.userId)); expect(actor.permissions).toContain('orders:write');
    const input = await command(f), before = await snapshot(f); await db().userRole.delete({ where: { id: membershipId } });
    const app = application(), r = await create(f, input, app, actor); expect(r.status, diagnostic(r.body)).toBe(403); await unchanged(f, before, app);
  });
  it.each(['create', 'split'] as const)('PB23 %s physical mandatory audit FK failure leaves no batch/partition/approval mutation', async action => {
    const f = await fixture('audit-' + action), parent = action === 'split' ? (await created(f, await command(f))).batch : null;
    const input = parent ? await splitCommand(f, parent) : await command(f), before = await snapshot(f), probe: Probe = { auditFault: true }, app = application(intercepted(db(), probe));
    const r = parent ? await split(f, parent.id, input, app) : await create(f, input, app);
    expect(probe.reached).toBe(true); expect(r.status, diagnostic(r.body)).toBe(500); safeBody(r); await unchanged(f, before, app);
  });
  it.each(['source', 'grant', 'scope'] as const)('PB24 physical %s query failure is safe failure, not empty/missing/default authority', async kind => {
    const f = await fixture('sql-' + kind, kind === 'scope'), input = await command(f), before = await snapshot(f);
    const probe: Probe = kind === 'source' ? { sourceFault: true } : kind === 'grant' ? { grantFault: true } : { scopeFault: true };
    const app = application(intercepted(db(), probe)), r = await create(f, input, app);
    expect(probe.reached).toBe(true); expect(r.status, diagnostic(r.body)).toBe(kind === 'source' ? 500 : 503);
    expect(code(r)).toBe(kind === 'source' ? 'INTERNAL_ERROR' : 'AUTHORIZATION_UNAVAILABLE'); safeBody(r); await unchanged(f, before, app);
  });
  it('PB25 soft-deleted actual source parent is not interpreted as a standalone eligible Asset', async () => {
    const f = await fixture('deleted-source'), input = await command(f), before = await snapshot(f);
    await db().developmentCase.update({ where: { id: f.caseId }, data: { deletedAt: BigInt(Date.now()) } });
    const app = application(), r = await create(f, input, app); expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
  });
  it('PB26 unrelated existing customer cannot be replaced by order owner and forged body actor', async () => {
    const f = await fixture('unrelated'), input = await command(f), before = await snapshot(f);
    await db().relation.update({ where: { id: f.customerId }, data: { ownerId: f.otherUserId } });
    const app = application(), r = await create(f, input, app); expect(r.status, diagnostic(r.body)).toBe(404); await unchanged(f, before, app);
    const read = await request(app.app).get(base(f)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`); expect(read.status).toBe(404);
  });
  it('PB27 configuration-disabled authentication never enables anonymous writes', async () => {
    const f = await fixture('anonymous'), input = await command(f), before = await snapshot(f), app = application(db(), false);
    const r = await request(app.app).post(base(f)).send(input); expect(r.status, diagnostic(r.body)).toBe(401); await unchanged(f, before, app);
  });
  it('PB28 current leadership withdrawn during actual parent lock wait rejects despite retained grants', async () => {
    const f = await fixture('wait-role'), input = await command(f), before = await snapshot(f);
    const { response, app } = await afterActualWait(f, app => create(f, input, app).then(r => r), tx => tx.userRole.delete({ where: { id: `${f.id}-role` } }));
    expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN'); await unchanged(f, before, app);
  });
  it.each(['reserved', 'shipped'] as const)('PB29 actual %s range allocation prevents split and retains original allocation facts', async state => {
    const f = await fixture('allocated-' + state), made = await created(f, await command(f)), input = await splitCommand(f, made.batch);
    // Explicit independent storage-boundary fixture. These soft identifiers do
    // not assert any real shipping/approval/stock producer has executed.
    const allocation = await db().shipmentProductionAllocation.create({ data: {
      id: `${f.id}-physical-allocation`, allocationId: `${f.id}-soa`, shipmentId: `${f.id}-shipment`, orderId: f.orderId, orderLineId: f.lineId,
      productionBatchId: made.batch.id, productionBatchRevision: made.batch.revision, plannedQty: '1', actualQty: state === 'shipped' ? '1' : null,
      unit: 'm', scopeSnapshot: { fixtureBoundary: 'Initial synthetic range reservation; no shipping producer proof' }, state,
      createdBy: f.userId, updatedBy: f.userId, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } });
    const before = await snapshot(f), app = application(), r = await split(f, made.batch.id, input, app);
    expect(r.status, diagnostic(r.body)).toBe(409); await unchanged(f, before, app);
    expect(await db().shipmentProductionAllocation.findUnique({ where: { id: allocation.id } })).toEqual(allocation);
  });
  it('PB30 original applied key still requires current DB write grant for replay', async () => {
    const f = await fixture('replay-revoke'), input = await command(f); await created(f, input);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: f.userId, scope: 'orders:write' } }, data: { isActive: false } });
    const before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(403); await unchanged(f, before, app);
  });

  it('PB31 server chooses the first interior gap, preserves explicit initial neutral-range history', async () => {
    const f = await fixture('first-gap'), native = await created(f, await command(f, '1', 'A'));
    // Initial independent historical range only; never reposition a native
    // batch or fabricate an approval, receipt, cancellation or shipping fact.
    const initial = await db().productionBatch.create({ data: { ...native.batch, id: `${f.id}-initial-history`, batchCode: `${f.id}-history`,
      rangeStart: '5', quantity: '5', requestKey: `${f.id}-initial-unknown`, parameterHash: '0'.repeat(64),
      commandSnapshot: { fixtureBoundary: 'Initial neutral coordinates, not native producer or approval proof' },
    } });
    const next = await created(f, await command(f, '3', 'B'));
    expect(next.batch.rangeStart.toString()).toBe('1'); expect(next.batch.quantity.toString()).toBe('3');
    expect(await db().productionBatch.findUnique({ where: { id: initial.id } })).toEqual(initial);
    activePartition((await snapshot(f)).batches, '9');
  });

  it.each(['tail', 'interior'] as const)('PB32 initial persisted numeric NaN line rejects %s range without any write', async position => {
    const f = await fixture('initial-nan-' + position);
    if (position === 'interior') {
      const native = await created(f, await command(f, '1', 'A'));
      // Standalone INITIAL malformed storage fixture, not an alteration of a
      // native range or approval. Existing genuine source/audits stay intact.
      await db().productionBatch.create({ data: { ...native.batch, id: `${f.id}-nan-initial`, batchCode: `${f.id}-nan-history`,
        rangeStart: '5', quantity: '5', requestKey: `${f.id}-nan-initial-key`, parameterHash: '0'.repeat(64),
        commandSnapshot: { fixtureBoundary: 'Initial independent physical coordinates; not an executed shipping/approval fact' },
      } });
    }
    // PostgreSQL numeric supports NaN. This is deliberate initial malformed
    // data at the Batch boundary, not a business edit or invented approval.
    await db().$executeRaw`UPDATE "OrderLine" SET "quantity"='NaN'::numeric WHERE "id"=${f.lineId}`;
    const [{ quantity: persisted }] = await db().$queryRaw<Array<{ quantity: string }>>`SELECT "quantity"::text AS quantity FROM "OrderLine" WHERE "id"=${f.lineId}`;
    expect(persisted).toBe('NaN');
    const input = await command(f, '1', 'NaN-request'), before = await snapshot(f), app = application(), r = await create(f, input, app);
    expect(r.status, diagnostic(r.body)).toBe(409); expect(code(r)).toBe('CONFLICT'); safeBody(r); await unchanged(f, before, app);
  });

  it('PB33 neutral current-facts consumption rejects initial numeric NaN line without treating an incomparable range as valid', async () => {
    const f = await fixture('neutral-nan'), native = await created(f, await command(f, '1', 'A'));
    // This initial malformed persisted line is a consumer boundary, not an
    // executed edit, source approval or native creation proof. PB32 separately
    // records the current HTTP creation rejection without assuming its cause.
    await db().$executeRaw`UPDATE "OrderLine" SET "quantity"='NaN'::numeric WHERE "id"=${f.lineId}`;
    const [{ quantity: persisted }] = await db().$queryRaw<Array<{ quantity: string }>>`SELECT "quantity"::text AS quantity FROM "OrderLine" WHERE "id"=${f.lineId}`;
    expect(persisted).toBe('NaN'); const before = await snapshot(f);
    // Source identity is unchanged. Acquire actual parent/range locks; do not
    // call production eligibility or a write API as a fake neutral QC gate.
    await expect(db().$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${f.caseId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SealSample" WHERE "id"=${f.sealId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${f.orderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "OrderLine" WHERE "id"=${f.lineId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "ProductionBatch" WHERE "id"=${native.batch.id} FOR UPDATE`;
      return resolveCurrentProductionBatchFacts(tx, native.batch);
    })).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(await snapshot(f)).toEqual(before);
  });

});


describe('SealSample native occupied sequence regression', () => {
  it('SSN01 actual concurrent seal creation uses one locked sequence and distinct UUID identities', async () => {
    const f = await fixture('seal-concurrent');
    const links = await db().sealSampleBatch.findMany({ where: { sealSampleId: f.sealId } });
    expect(links).toHaveLength(1);
    const results = await Promise.all([0, 1].map(() => createSealSample({ prisma: db(), caseId: f.caseId, actorId: f.userId,
      input: { batchIds: [links[0].sampleBatchId], name: 'Synthetic native concurrent seal' } })));
    for (const result of results) expect(result.ok, diagnostic(result)).toBe(true);
    const seals = results.map(result => (result as any).data.seal);
    expect(new Set(seals.map(seal => seal.sealCode)).size).toBe(2);
    expect(new Set(seals.map(seal => seal.id)).size).toBe(2);
    for (const seal of seals) {
      expect(seal.sealCode).toMatch(/^SEAL-\d{4}-\d{4,}$/);
      expect(await db().auditLog.count({ where: { targetId: seal.id, action: 'create_seal_sample' } })).toBe(1);
    }
  });
  it('SSN02 soft-deleted occupied seal code is preserved and skipped without a failed PostgreSQL transaction', async () => {
    const f = await fixture('seal-history');
    const links = await db().sealSampleBatch.findMany({ where: { sealSampleId: f.sealId } });
    expect(links).toHaveLength(1);
    const year = new Date().getFullYear();
    const sequence = await db().businessSequence.findUniqueOrThrow({ where: { id: `SEQ_SEAL_${year}` } });
    const occupied = `SEAL-${year}-${String(sequence.seq + 1).padStart(4, '0')}`;
    // Only a deleted historical code collision fixture: no approval, stock or money fact.
    const historical = await db().sealSample.create({ data: { id: `${f.id}-old-seal`, sealCode: occupied,
      developmentCaseId: f.caseId, supplierRelationId: f.supplierId, status: 'draft', createdAt: 1n, updatedAt: 1n, deletedAt: 1n } });
    const result = await createSealSample({ prisma: db(), caseId: f.caseId, actorId: f.userId, input: { batchIds: [links[0].sampleBatchId] } });
    expect(result.ok, diagnostic(result)).toBe(true);
    expect((result as any).data.seal.sealCode).toBe(`SEAL-${year}-${String(sequence.seq + 2).padStart(4, '0')}`);
    expect(await db().sealSample.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical);
  });
});

/** Native bootstrap uses number toJSON globally. This isolated override
 * reproduces it without starting index/seed/scheduler or changing stored facts. */
async function withNativeNumberSerialization<T>(work: () => Promise<T>): Promise<T> {
  const decimal = Prisma.Decimal.prototype as unknown as { toJSON: () => unknown }, priorDecimal = decimal.toJSON;
  const bigint = BigInt.prototype as unknown as { toJSON?: () => unknown }, priorBigint = Object.getOwnPropertyDescriptor(bigint, 'toJSON');
  decimal.toJSON = function (this: Prisma.Decimal) { return Number(this); };
  Object.defineProperty(bigint, 'toJSON', { configurable: true, writable: true, value: function (this: bigint) { return Number(this); } });
  try { return await work(); } finally { decimal.toJSON = priorDecimal; if (priorBigint) Object.defineProperty(bigint, 'toJSON', priorBigint); else delete bigint.toJSON; }
}

describe('Production batch native Decimal wire contract', () => {
  it('native create, audited replay and list preserve exact string quantity despite bootstrap number hooks', async () => {
    const f = await fixture('number-wire-create'), body = await command(f, '3.2501'), app = application();
    await withNativeNumberSerialization(async () => {
      const made = await create(f, body, app); expect(made.status, diagnostic(made.body)).toBe(201);
      expect(made.body.batch.quantity).toBe('3.2501'); expect(made.body.batch.rangeStart).toBe('0');
      expect(typeof made.body.batch.createdAt).toBe('string'); expect(made.body.batch.commandSnapshot).toEqual(body);
      const replay = await create(f, body, app); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
      expect(replay.body.batch).toEqual(made.body.batch); expect(await batches().count({ where: { orderId: f.orderId } })).toBe(1);
      const read = await listing(f, app); expect(read.body.batches[0].quantity).toBe('3.2501'); expect(read.body.batches[0].rangeStart).toBe('0');
      expect((await batches().findUniqueOrThrow({ where: { id: made.body.batch.id } })).quantity.toString()).toBe('3.2501');
    });
  });
  it('native split retains exact child coordinates and original source on both first ACK and replay', async () => {
    const f = await fixture('number-wire-split'), parent = await created(f, await command(f, '3.2501')), body = await splitCommand(f, parent.batch, ['1.2501', '2']);
    await withNativeNumberSerialization(async () => {
      const result = await split(f, parent.batch.id, body); expect(result.status, diagnostic(result.body)).toBe(201);
      expect(result.body.parent.quantity).toBe('3.2501'); expect(result.body.parent.rangeStart).toBe('0');
      expect(result.body.children.map((row: any) => [row.quantity, row.rangeStart])).toEqual([['1.2501', '0'], ['2', '1.2501']]);
      const replay = await split(f, parent.batch.id, body); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
      expect(replay.body.children).toEqual(result.body.children); expect(await batches().count({ where: { orderId: f.orderId } })).toBe(3);
    });
  });
});
