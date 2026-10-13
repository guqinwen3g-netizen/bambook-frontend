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
import { createReleaseRouter } from '../src/production/releaseRoute';
import { initProductionStages, advanceStage, savePreCutChecklist, PRODUCTION_STAGES } from '../src/production/stageService';
import { createSample, advanceSampleStage, updateSample } from '../src/samples/sampleManageService';
import { createQcScopedService } from '../src/qc/qcScopedService';
import { resolveCurrentProductionBatchFacts } from '../src/production/productionBatchService';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-release-batch-${randomUUID()}`;
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
  app.use('/api/v1/order-lines', createOrderLinesRouter({ prisma: client, requireAuth, apiKeys: new Set() }));
  app.use('/api/v1/production-batches', createProductionBatchRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v1/releases', createReleaseRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
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


const releaseBase = '/api/v1/releases';
async function releaseGrant(f: Fixture, scope = 'production:pp_release:business_sign') {
  await db().userPermissionOverrides.upsert({ where: { id: `${f.id}-${scope}` }, update: { isActive: true },
    create: { id: `${f.id}-${scope}`, userId: f.userId, scope, isActive: true, grantedBy: f.userId, reason: 'Exact private sign capability; not policy' } });
  return await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.userId));
}
const scopeCreate = (f: Fixture, batch: any, extra: any = {}, app = application(), actor: TokenPayload = f.actor) =>
  request(app.app).post(`${releaseBase}/orders/${f.orderId}/lines/${f.lineId}/release-scopes`)
    .set('Authorization', `Bearer ${auth.signToken(actor)}`).send({ productionBatchId: batch.id, expectedBatchRevision: batch.revision, quantity: String(batch.quantity), unit: batch.unit, ...extra });
async function scopeMade(f: Fixture, batch: any, app = application()) {
  const r = await scopeCreate(f, batch, {}, app); expect(r.status, diagnostic(r.body)).toBe(201); return r.body.scope;
}
async function asked(f: Fixture, scope: any, app = application()) {
  const r = await request(app.app).post(`${releaseBase}/release-scopes/${scope.id}/requests`)
    .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ expectedScopeRevision: scope.scopeRevision });
  expect(r.status, diagnostic(r.body)).toBe(201); return r.body.request;
}
const signed = (f: Fixture, rr: any, actor: TokenPayload, app = application(), extra: any = {}) =>
  request(app.app).post(`${releaseBase}/release-requests/${rr.id}/signatures`).set('Authorization', `Bearer ${auth.signToken(actor)}`)
    .send({ role: 'business', ...extra });
async function releaseSnapshot(f: Fixture) {
  const scopes = await db().releaseScope.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
  const ids = scopes.map(r => r.id), requests = await db().releaseRequest.findMany({ where: { scopeId: { in: ids } }, orderBy: { id: 'asc' } });
  return { scopes, requests, signatures: await db().releaseSignature.findMany({ where: { requestId: { in: requests.map(r => r.id) } }, orderBy: { id: 'asc' } }),
    releases: await db().ppSampleRelease.findMany({ where: { scopeId: { in: ids } }, orderBy: { id: 'asc' } }),
    events: await db().releaseEvent.findMany({ where: { scopeId: { in: ids } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'ReleaseScope', actorId: f.userId }, orderBy: { id: 'asc' } }) };
}
function afterInsert(client: PrismaClient, model: 'auditLog' | 'releaseEvent', predicate: (arg: any) => boolean,
  inserted: ReturnType<typeof signal>, resume: ReturnType<typeof signal>, proof: { actualInsert: boolean; pid?: number }): PrismaClient {
  return new Proxy(client, { get(base, key) {
    if (key === '$transaction') return (work: any, options?: any) => base.$transaction(async tx => {
      const [row] = await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid'); proof.pid = row.pid;
      return work(new Proxy(tx, { get(current, key) {
        if (key === model) return new Proxy((current as any)[key], { get(delegate, method) {
          if (method === 'create') return async (arg: any) => { const native = await delegate.create(arg);
            if (predicate(arg)) { proof.actualInsert = true; inserted.resolve(); await resume.promise; } return native; };
          const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(current, key); return typeof value === 'function' ? value.bind(current) : value;
      } }));
    }, options);
    const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
  } });
}
async function nativePp(f: Fixture) {
  const result = await createSample({ prisma: db(), actorId: f.userId, input: { type: 'pp', sourceOrderId: f.orderId,
    supplierRelationId: f.supplierId, productAssetId: f.assetId } });
  expect(result.ok, diagnostic(result)).toBe(true); if (!result.ok) throw Error('Native PP Sample creation failed');
  const id = result.data.sample.id;
  for (const action of ['start','qc','submit'] as const) {
    const next = await advanceSampleStage({ prisma: db(), sampleId: id, actorId: f.userId, action,
      input: { qcStatus: 'passed', customerStatus: 'approved', feedback: 'Synthetic observed PP evidence', sentDate: '2099-11-01' } });
    expect(next.ok, diagnostic(next)).toBe(true);
  }
  expect(await db().sample.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'submitted', sourceCaseId: null, sourceOrderId: f.orderId });
  return id;
}
function afterNativeSampleUpdate(client: PrismaClient, sampleId: string, written: ReturnType<typeof signal>, resume: ReturnType<typeof signal>, proof: { pid: number; inserted: boolean }) {
  return new Proxy(client, { get(base,key) {
    if(key==='$transaction') return (work:any, opts?:any) => base.$transaction(async tx=>{
      const [row]=await tx.$queryRawUnsafe<any[]>('SELECT pg_backend_pid() AS pid'); proof.pid=row.pid;
      return work(new Proxy(tx,{get(current,key){
        if(key==='sample') return new Proxy(current.sample,{get(delegate,method){
          if(method==='update') return async (arg:any)=>{ const native=await delegate.update(arg); if(arg.where.id===sampleId){proof.inserted=true;written.resolve();await resume.promise;} return native; };
          const value=Reflect.get(delegate,method);return typeof value==='function'?value.bind(delegate):value;
        }});
        const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;
      }}));
    }, {...opts,timeout:20000,maxWait:10000});
    const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;
  }});
}
describe.sequential('Release full native ProductionBatch binding and original history', () => {
  it('RBB01 native full batch derives exact scope and a signer without orders:write still approves as itself', async () => {
    const f = await fixture('full'), made = await created(f, await command(f, '10')); const actor = await releaseGrant(f);
    const scope = await scopeMade(f, made.batch), rr = await asked(f, scope);
    expect(scope).toMatchObject({ productionBatchId: made.batch.id, productionBatchRevision: made.batch.revision,
      quantity: '10', unit: 'm', factoryRelationId: f.supplierId, confirmedSourceId: f.sealId });
    await db().userPermissionOverrides.update({ where: { id: `${f.id}-orders:write` }, data: { isActive: false } });
    const response = await signed(f, rr, actor, application(), { actorId: f.otherUserId, actorName: 'FORGED', permissionCeiling: ['*'] });
    expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.release.approvedBy).toBe(f.userId);
    const state = await releaseSnapshot(f); expect(state.signatures).toHaveLength(1); expect(state.releases).toHaveLength(1);
    expect(state.events.map(r => r.kind)).toEqual(['granted']); expect(state.audits).toHaveLength(1);
    expect(state.scopes[0].productionBatchRevision).toBe(made.batch.revision); expect(state.scopes[0].quantity.toString()).toBe('10');
  });
  it.each(['missing', 'foreign', 'wrong-line', 'stale', 'quantity', 'unit', 'factory', 'source', 'spec'])('RBB02 %s cannot bind or supersede a whole native scope', async kind => {
    const f = await fixture(kind), made = await created(f, await command(f, '10')), app = application();
    const whole = await request(app.app).post(`${releaseBase}/orders/${f.orderId}/lines/${f.lineId}/release-scopes`)
      .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ quantity: '10', unit: 'm' }); expect(whole.status).toBe(201);
    const before = await releaseSnapshot(f); let batch = made.batch, extra: any = {};
    if (kind === 'missing') batch = { ...batch, id: 'PB_missing_' + f.id };
    if (kind === 'foreign') { const other = await fixture('foreign-source'); batch = (await created(other, await command(other, '10'))).batch; }
    if (kind === 'wrong-line') extra = { productionBatchId: made.batch.id }; // exact different real line path below
    if (kind === 'stale') extra = { expectedBatchRevision: batch.revision + 1 };
    if (kind === 'quantity') extra = { quantity: '9.9999' }; if (kind === 'unit') extra = { unit: 'PC' };
    if (kind === 'factory') extra = { factoryRelationId: f.customerId }; if (kind === 'source') extra = { confirmedSourceId: 'other' };
    if (kind === 'spec') extra = { specSnapshot: { other: true } };
    let response;
    if (kind === 'wrong-line') {
      const second = await db().orderLine.create({ data: { id: f.id + '-line2', orderId: f.orderId, lineNumber: 2, itemNo: '0020', quantity: '10', unit: 'm',
        confirmedSourceType: 'SealSample', confirmedSourceId: f.sealId, specSnapshot: made.batch.specSnapshot } });
      response = await request(app.app).post(`${releaseBase}/orders/${f.orderId}/lines/${second.id}/release-scopes`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`)
        .send({ productionBatchId: batch.id, expectedBatchRevision: batch.revision });
    } else response = await scopeCreate(f, batch, extra, app);
    expect(response.status, diagnostic(response.body)).toBeGreaterThanOrEqual(400); expect(await releaseSnapshot(f)).toEqual(before);
  });
  it('RBB03 native split parent and missing historic revision cannot produce fresh approval but original history remains', async () => {
    const f = await fixture('split-parent'), made = await created(f, await command(f, '10')), actor = await releaseGrant(f);
    const scope = await scopeMade(f, made.batch), rr = await asked(f, scope); expect((await signed(f, rr, actor)).status).toBe(200);
    const before = await releaseSnapshot(f), cut = await split(f, made.batch.id, await splitCommand(f, made.batch, ['4','6'])); expect(cut.status).toBe(201);
    const rejected = await scopeCreate(f, made.batch); expect(rejected.status).toBeGreaterThanOrEqual(400);
    const read = await request(application().app).get(`${releaseBase}/orders/${f.orderId}/releases`).set('Authorization', `Bearer ${auth.signToken(actor)}`);
    expect(read.status, diagnostic(read.body)).toBe(200); expect(read.body.total).toBe(0); expect(read.body.historyTotal).toBe(1);
    expect(read.body.scopes[0].classification).toBe('historical'); expect((await releaseSnapshot(f)).releases).toEqual(before.releases);
    const current = await request(application().app).get(`${releaseBase}/release-scopes/${scope.id}/eligibility`).set('Authorization', `Bearer ${auth.signToken(actor)}`);
    expect(current.body.eligible).toBe(false);
    // Corrupt only this synthetic scope, not native original acknowledgements.
    await db().releaseScope.update({ where: { id: scope.id }, data: { productionBatchRevision: null } });
    const retry = await request(application().app).post(`${releaseBase}/release-scopes/${scope.id}/requests`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({});
    expect(retry.status).toBeGreaterThanOrEqual(400);
  });
  it.each(['1.2345','90071992547409.9999'])('RBB04 Decimal18,4 %s survives actual number JSON hooks with no input rounding', async value => {
    const f = await fixture('decimal');
    const updated = await request(application().app).put(`/api/v1/order-lines/${f.lineId}`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ quantity: value });
    // Original native line producer is mounted explicitly for this controlled edit.
    if (updated.status !== 200) throw Error('Actual OrderLine quantity producer failed: '+diagnostic(updated.body));
    const made = await created(f, await command(f, value));
    const original = Prisma.Decimal.prototype.toJSON; Prisma.Decimal.prototype.toJSON = function decimalToNumberJSON() { return Number(this); };
    try { const response = await scopeCreate(f, made.batch); expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body.scope.quantity).toBe(value);
      expect((await db().releaseScope.findUniqueOrThrow({ where: { id: response.body.scope.id } })).quantity.toString()).toBe(value); }
    finally { Prisma.Decimal.prototype.toJSON = original; }
    for (const quantity of ['1.23456','0','-1','',' 1','1e0',90071992547410]) {
      const other = await fixture('invalid-decimal'), pb = await created(other, await command(other, '10')), before = await releaseSnapshot(other);
      const response = await scopeCreate(other, pb.batch, { quantity }); expect(response.status, diagnostic(response.body)).toBeGreaterThanOrEqual(400); expect(await releaseSnapshot(other)).toEqual(before);
    }
  });
  it('RBB05 original native create and split receipts replay unchanged after release and splitting', async () => {
    const f = await fixture('ack'), body = await command(f, '10'), made = await created(f, body), scope = await scopeMade(f, made.batch), actor = await releaseGrant(f);
    const rr = await asked(f, scope); expect((await signed(f, rr, actor)).status).toBe(200);
    const prior = await db().auditLog.findMany({ where: { targetType: 'ProductionBatch', actorId: f.userId }, orderBy: { id: 'asc' } });
    const cutBody = await splitCommand(f, made.batch, ['4','6']), cut = await split(f, made.batch.id, cutBody); expect(cut.status).toBe(201);
    const again = await create(f, body); expect(again.status).toBe(200); expect(again.body.batch).toEqual(made.response.body.batch);
    const splitAgain = await split(f, made.batch.id, cutBody); expect(splitAgain.status).toBe(200); expect(splitAgain.body.parent).toEqual(cut.body.parent); expect(splitAgain.body.children).toEqual(cut.body.children);
    expect((await db().auditLog.findMany({ where: { id: { in: prior.map(r => r.id) } }, orderBy: { id: 'asc' } }))).toEqual(prior);
  });
  it('RBB06 split and binding enter a witnessed two-connection Source→Order→Scope→PB wait graph without a new deadlock', async () => {
    const f = await fixture('lock'), made = await created(f, await command(f, '10')), cut = await splitCommand(f, made.batch, ['4','6']);
    const result = await competing(f, [app => split(f, made.batch.id, cut, app), app => scopeCreate(f, made.batch, {}, app)]);
    expect(result.responses.every(r => !diagnostic(r.body).includes('40P01'))).toBe(true); expect(result.responses[0].status, diagnostic(result.responses[0].body)).toBe(201);
    expect([201,409]).toContain(result.responses[1].status);
    const read = await request(application().app).get(`${releaseBase}/orders/${f.orderId}/releases`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
    expect(read.status).toBe(200); expect(read.body.ready).toBe(0);
  });
  it.each([['create','grant'],['create','share'],['create','account'],['sign','grant'],['sign','share'],['sign','account']] as const)('RBB07 %s actual last INSERT then external %s withdrawal rolls back every native fact', async (mode, kind) => {
    const f = await fixture('late-'+mode, true), made = await created(f, await command(f, '10')), actor = await releaseGrant(f);
    const scope = mode === 'sign' ? await scopeMade(f, made.batch) : null, rr = scope ? await asked(f, scope) : null;
    const before = await releaseSnapshot(f), inserted = signal(), resume = signal(), proof = { actualInsert: false, pid: 0 };
    const writer = await connection(), revoke = await connection(), app = application(afterInsert(writer, mode === 'create' ? 'auditLog' : 'releaseEvent',
      arg => mode === 'create' ? arg.data.action === 'create_release_scope' : arg.data.kind === 'granted', inserted, resume, proof));
    const response = mode === 'create' ? scopeCreate(f, made.batch, {}, app) : signed(f, rr, actor, app);
    const running = response.then(r => r);
    try { await Promise.race([inserted.promise, running.then(r => { throw Error('Ended before native last INSERT '+diagnostic(r.body)); })]);
      expect(proof.actualInsert).toBe(true); expect(proof.pid).toBeGreaterThan(0);
      if (kind === 'grant') await revoke.userPermissionOverrides.update({ where: { id: `${f.id}-${mode === 'create' ? 'orders:write' : 'production:pp_release:business_sign'}` }, data: { isActive: false } });
      if (kind === 'share') await revoke.teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date(), revokedBy: f.otherUserId, revokeReason: 'Synthetic actual share withdrawal' } });
      if (kind === 'account') await revoke.userAccount.update({ where: { id: f.userId }, data: { status: 'disabled' } });
      resume.resolve(); const result = await running; expect(result.status, diagnostic(result.body)).toBe(kind === 'grant' ? 403 : kind === 'share' ? 404 : 401); expect(await releaseSnapshot(f)).toEqual(before);
    } finally { resume.resolve(); await Promise.allSettled([running]); }
  });
  it.each(['create','sign'])('RBB07 %s native failing SQL rolls back and real retry commits once', async mode => {
    const f = await fixture('sql-fault-'+mode), made = await created(f, await command(f, '10')), actor = await releaseGrant(f);
    const scope = mode === 'sign' ? await scopeMade(f, made.batch) : null, rr = scope ? await asked(f, scope) : null;
    const before = await releaseSnapshot(f); let physicalSqlAttempted = false;
    const client = await connection(), wrapped = new Proxy(client, { get(base,key) {
      if(key === '$transaction') return (work:any,opts?:any) => base.$transaction(tx => work(new Proxy(tx,{get(current,key) {
        const target = mode === 'create' ? 'auditLog' : 'releaseEvent';
        if(key === target) return new Proxy((current as any)[key],{get(delegate,method) {
          if(method === 'create') return async (arg:any) => {
            const applies = mode === 'create' ? arg.data.action === 'create_release_scope' : arg.data.kind === 'granted';
            if(!applies) return delegate.create(arg); physicalSqlAttempted = true;
            if(mode === 'create') return delegate.create({...arg,data:{...arg.data,actorId:f.id+'-missing-audit-actor'}});
            await delegate.create(arg); return delegate.create(arg); // actual duplicate PK after original INSERT
          };
          const value=Reflect.get(delegate,method); return typeof value==='function'?value.bind(delegate):value;
        }});
        const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;
      }})),opts);
      const value=Reflect.get(base,key);return typeof value==='function'?value.bind(base):value;
    }});
    const app = application(wrapped), response = mode === 'create' ? await scopeCreate(f,made.batch,{},app) : await signed(f,rr,actor,app);
    expect(physicalSqlAttempted).toBe(true);expect(response.status).toBeGreaterThanOrEqual(400);expect(await releaseSnapshot(f)).toEqual(before);
    expect(diagnostic(response.body)).not.toMatch(/P2003|P2002|constraint|missing-audit-actor/);
    const retry = mode === 'create' ? await scopeCreate(f,made.batch) : await signed(f,rr,actor);expect(retry.status).toBe(mode === 'create'?201:200);
  });
  it.each([[[]], [['orders:write']], [['production:pp_release:business_sign']]])('RBB01 signed ceiling %j and current grants are intersected despite forged body permissions',async ceiling=>{
    const f=await fixture('ceiling'),made=await created(f,await command(f,'10')),actor=await releaseGrant(f),scope=await scopeMade(f,made.batch),rr=await asked(f,scope);
    const tokenActor={...actor,permissionCeiling:ceiling};const before=await releaseSnapshot(f);
    const response=await signed(f,rr,tokenActor,application(),{permissions:['*'],permissionCeiling:['*'],actorId:f.otherUserId});
    expect(response.status,diagnostic(response.body)).toBe(ceiling.includes('production:pp_release:business_sign')?200:403);
    if(response.status!==200)expect(await releaseSnapshot(f)).toEqual(before);else expect(response.body.release.approvedBy).toBe(f.userId);
  });
  it.each(['metadata','revise'] as const)('RBB08 actual Sample %s writer and bound request witness Source→Order locks and current evidence', async mode => {
    const f=await fixture('sample-'+mode), made=await created(f,await command(f,'10')), actor=await releaseGrant(f), scope=await scopeMade(f,made.batch), sampleId=await nativePp(f);
    const priorRequest=mode==='revise'?await request(application().app).post(`${releaseBase}/release-scopes/${scope.id}/requests`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`).send({sampleId,expectedScopeRevision:scope.scopeRevision}):null;
    if(priorRequest)expect(priorRequest.status,diagnostic(priorRequest.body)).toBe(201);
    const written=signal(),resume=signal(),proof={pid:0,inserted:false}, probe:Probe={pids:[]};
    const writer=afterNativeSampleUpdate(await connection(),sampleId,written,resume,proof);
    const changing=mode==='metadata'?updateSample({prisma:writer,sampleId,input:{notes:'Synthetic metadata correction'},actorId:f.userId}):advanceSampleStage({prisma:writer,sampleId,action:'revise',input:{feedback:'Synthetic PP correction'},actorId:f.userId});
    let downstream:Promise<any>|undefined;
    try {
      await Promise.race([written.promise,changing.then(value=>{throw Error('Source writer ended before actual UPDATE '+diagnostic(value));})]);
      expect(proof.inserted).toBe(true);
      const app=application(intercepted(await connection(),probe));
      downstream=(mode==='metadata'?request(app.app).post(`${releaseBase}/release-scopes/${scope.id}/requests`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`).send({sampleId,expectedScopeRevision:scope.scopeRevision}):signed(f,priorRequest!.body.request,actor,app)).then(value=>value);
      let witnessed=false;
      for(let i=0;i<200;i++) { if(probe.pids?.length){const [row]=await db().$queryRawUnsafe<any[]>('SELECT pg_blocking_pids($1::integer) AS blockers, query FROM pg_stat_activity WHERE pid=$1::integer',probe.pids[0]);if(row?.blockers.includes(proof.pid)){expect(row.query).toContain('Sample');expect(probe.pids[0]).not.toBe(proof.pid);witnessed=true;break;}} await new Promise(done=>setTimeout(done,20)); }
      expect(witnessed,'Actual Sample writer must block bound request/sign before Order').toBe(true);
      resume.resolve();expect((await changing).ok).toBe(true);const response=await downstream;
      expect(response.status,diagnostic(response.body)).toBe(mode==='metadata'?201:409);
      expect(diagnostic(response.body)).not.toContain('40P01');
      if(mode==='revise'){const actual=await releaseSnapshot(f);expect(actual.signatures).toHaveLength(0);expect(actual.releases).toHaveLength(0);expect((await db().sample.findUniqueOrThrow({where:{id:sampleId}})).status).toBe('revising');}
    } finally {resume.resolve();await Promise.allSettled([changing,...(downstream?[downstream]:[])]);}
  },30000);
  it('RBB08 actual scoped QC failure records on a native neutral batch without any PP release',async()=>{
    const f=await fixture('neutral-qc'), made=await created(f,await command(f,'10'));
    await releaseGrant(f,'qc:read');const actor=await releaseGrant(f,'qc:write'), service=createQcScopedService(db());
    const coverage=(await service.scopes(f.orderId,actor)).scopes.find((item:any)=>item.productionBatchId===made.batch.id)!;expect(coverage).toBeTruthy();
    const task=await service.create({orderId:f.orderId,inspectionType:'final',qcUserId:f.userId,scopeType:'production_batch',productionBatchId:made.batch.id,
      expectedBatchRevision:made.batch.revision,expectedScopeFingerprint:coverage.scopeFingerprint,requestKey:randomUUID()},actor);
    const done=await service.complete(task.item.id,{requestKey:randomUUID(),expectedScopeFingerprint:coverage.scopeFingerprint,report:{result:'fail',inspectionDate:'2026-10-02',totalUnits:10,passedUnits:0,criticalDefects:1,majorDefects:0,minorDefects:0,sampleSize:10,lotSize:10}},actor);
    expect(done.report).toMatchObject({result:'fail',productionBatchId:made.batch.id,approvedByBusiness:false,inspectedBy:f.userId});
    expect(await db().inspectionReport.findUniqueOrThrow({where:{id:done.report.id}})).toMatchObject({result:'fail',productionBatchId:made.batch.id});
    expect((await releaseSnapshot(f)).releases).toHaveLength(0);expect(await db().auditLog.count({where:{actorId:f.userId,action:{in:['create_scoped_assignment','complete_scoped_assignment']}}})).toBe(2);
  });
  it('RBB08 retired-only scopes never fall back to legacy double-sign, and actual binding is neutral for QC facts', async () => {
    const f = await fixture('history'), made = await created(f, await command(f, '10')), actor = await releaseGrant(f), scope = await scopeMade(f, made.batch);
    const rr = await asked(f, scope); expect((await signed(f, rr, actor)).status).toBe(200);
    expect(await resolveCurrentProductionBatchFacts(db(), await batches().findUniqueOrThrow({ where: { id: made.batch.id } }))).toMatchObject({ batch: { id: made.batch.id } });
    expect((await snapshot(f)).qc).toHaveLength(0);
    await initProductionStages(db(), f.orderId);
    await savePreCutChecklist(db(), f.orderId, { gradingConfirmed: true, consumptionConfirmed: true, patternConfirmed: true, preProductionMeeting: true, confirmedBy: f.userId });
    for (const stage of PRODUCTION_STAGES) { if (stage.key === 'manufacturing') break; const existing = await db().productionStage.findUniqueOrThrow({ where: { orderId_stageKey: { orderId: f.orderId, stageKey: stage.key } } }); if (existing.status === 'done') continue; const advanced = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: stage.key, operator: f.userId }); expect(advanced.ok, diagnostic(advanced)).toBe(true); }
    const cut = await split(f, made.batch.id, await splitCommand(f, made.batch, ['4','6'])); expect(cut.status).toBe(201);
    const before = await db().productionStage.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
    const result = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'manufacturing', operator: f.userId, ownerOverride: true });
    expect(result.ok, diagnostic(result)).toBe(false); expect(await db().productionStage.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } })).toEqual(before);
    const unchanged = await releaseSnapshot(f); expect(unchanged.releases).toHaveLength(1); expect(unchanged.signatures).toHaveLength(1);
    const children=await batches().findMany({where:{parentBatchId:made.batch.id},orderBy:{rangeStart:'asc'}});expect(children).toHaveLength(2);
    const first=await scopeMade(f,children[0]), second=await scopeMade(f,children[1]);expect((await signed(f,await asked(f,first),actor)).status).toBe(200);
    const current=await request(application().app).get(`${releaseBase}/orders/${f.orderId}/releases`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`);
    expect(current.body).toMatchObject({total:2,ready:1,blocked:1,historyTotal:1});expect(current.body.scopes.find((row:any)=>row.id===second.id).state).toBe('no_release');
    const partial=await advanceStage({prisma:db(),orderId:f.orderId,stageKey:'manufacturing',operator:f.userId});expect(partial.ok,diagnostic(partial)).toBe(true);

  });
});
