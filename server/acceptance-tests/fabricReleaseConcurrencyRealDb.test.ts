/** Opt-in private PG concurrency: synthetic initial development/customer observations,
 * actual native batch start/send/approve/convert + real audit/history, native
 * repeat/version HTTP and production domain consumers. No seeded approval,
 * PpSampleRelease or completed stage. Technical fixtures are not human UAT. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createOrdersRouter } from '../src/orders/route';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createSampleBatch, advanceSampleBatchStage, submitBatchCustomerFeedback, convertToFabricAsset, createSealSample, sealSampleConfirm } from '../src/development/fabricDevelopmentService';
import { assertFabricAssetEligible } from '../src/development/fabricAssetEligibility';
import { listProductionBatches, createProductionBatch, splitProductionBatch } from '../src/production/productionBatchService';
import { createReleaseScope, createReleaseRequest, signReleaseRequest, evaluateProductionRelease, summarizeOrderReleases } from '../src/production/releaseService';
import { advanceStage, savePreCutChecklist, PRODUCTION_STAGES } from '../src/production/stageService';
import { createSample, advanceSampleStage } from '../src/samples/sampleManageService';

const prefix = 'acceptance-fabric-release-concurrency-' + randomUUID();
let prisma: PrismaClient | undefined, sequence = 0;
const connections: PrismaClient[] = [];
const db = (): any => { if (!prisma) throw Error('Private fabric-asset PG identity not verified'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name, BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Independent acceptance sandbox required');
  const url = new URL(DATABASE_URL); expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe('/' + name); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/); expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
});
afterAll(async () => { await Promise.all(connections.map(value => value.$disconnect())); await prisma?.$disconnect(); });

async function fixture(label: string, options: { supplier?: { id: string; name: string } } = {}) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), actorId = id + '-leader', roleId = id + '-explicit-grants';
  await db().userAccount.create({ data: { id: actorId, displayName: id, status: 'active' } });
  await db().role.create({ data: { id: roleId, name: 'Synthetic isolated exact grants', isSystem: false } });
  await db().userRole.create({ data: { id: id + '-assignment', userId: actorId, roleId } });
  await db().role.upsert({ where: { id: 'role-super-admin' }, update: {}, create: { id: 'role-super-admin', name: 'Canonical technical fixture authority', isSystem: true } });
  await db().userRole.create({ data: { id: id + '-canonical', userId: actorId, roleId: 'role-super-admin' } });
  for (const scope of ['products:write', 'products:read', 'orders:write', 'orders:read', 'production:read', 'production:write', 'production:pp_release:business_sign']) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: prefix + '-' + scope, scope } });
    await db().rolePermission.create({ data: { id: id + '-' + scope, roleId, permissionId: permission.id } });
  }
  const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(actorId); expect(current).not.toBeNull();
  const trustedActor = { userId: actorId, roles: current!.legacyRoleCodes, roleIds: current!.roleIds, permissions: current!.scopes, departmentIds: current!.departmentIds, authorizationLoaded: true as const };
  const token = createAuthService().signToken(trustedActor);
  const supplier = options.supplier ?? await db().relation.create({ data: { id: id + '-supplier', name: id + '-actual-mill', category: 'Supplier', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
  const devCase = await db().developmentCase.create({ data: { id: id + '-case', code: id + '-case', name: id, type: 'fabric', stage: 'developing', owner: actorId, tags: [], createdAt: now, updatedAt: now } });
  const made = await createSampleBatch({ prisma: db(), caseId: devCase.id, actorId, input: { sampleType: 'lab-dip', supplierRelationId: supplier.id, supplierName: supplier.name } });
  expect(made.ok, diagnostic(made)).toBe(true); const batchId = (made as any).data.batch.id;
  const f = { id, actorId, trustedActor, token, supplier, caseId: devCase.id, batchId, assetId: '', orderId: '', lineId: '', scopeId: '' };
  await action(f, 'start'); await action(f, 'send'); await action(f, 'approve');
  const converted = await convertToFabricAsset({ prisma: db(), caseId: f.caseId, sourceType: 'batch', sourceId: f.batchId, actorId, trustedActor });
  expect(converted.ok, diagnostic(converted)).toBe(true); f.assetId = (converted as any).data.asset.id;
  const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'convert_fabric_to_asset', targetType: 'ProductAsset', targetId: f.assetId } });
  expect(audit.detail).toMatchObject({ source: 'route:dev:fabric-convert-asset', after: { fromCase: f.caseId, sourceType: 'batch', sourceId: f.batchId } });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function action(f: Pick<Fixture, 'batchId' | 'actorId' | 'trustedActor'>, action: 'start' | 'send' | 'approve' | 'revise', patch: Record<string, any> = {}) {
  const batch = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.batchId } });
  const input = { requestKey: randomUUID(), expectedRound: batch.round, expectedRevision: (batch.attachments as any)?.fabricHistory?.revision ?? 0, ...patch };
  const result = await advanceSampleBatchStage({ prisma: db(), batchId: f.batchId, action, input, actorId: f.actorId, trustedActor: f.trustedActor });
  expect(result.ok, diagnostic(result)).toBe(true); return result;
}
async function feedback(f: Fixture, status: string, database = db()) {
  const batch = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.batchId } });
  const result = await submitBatchCustomerFeedback({ prisma: database, batchId: f.batchId, actorId: f.actorId, trustedActor: f.trustedActor,
    input: { status, note: 'Synthetic actual customer observation', requestKey: randomUUID(), expectedRound: batch.round, expectedRevision: (batch.attachments as any).fabricHistory.revision } });
  expect(result.ok, diagnostic(result)).toBe(true);
}
function app(database = db()) {
  const value = express(); value.use(express.json()); value.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  value.use(createAccountStatusGuard(db())); value.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  value.use('/api/v1/orders', createOrdersRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  value.use('/api/v1/order-lines', createOrderLinesRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  return value;
}
async function repeat(f: Fixture, database = db(), assetId = f.assetId) {
  return request(app(database)).post('/api/v1/orders/lines').set('Authorization', 'Bearer ' + f.token).send({ confirmedSourceType: 'Asset', confirmedSourceId: assetId,
    millRelationId: f.supplier.id, clientRequestId: randomUUID(), quantity: 100, dueDate: '2099-11-01', quoteAmount: 100, poNumber: f.id, customer: 'Synthetic independent repeat buyer' });
}

async function nativeOrder(f: Fixture) {
  const created = await repeat(f); expect(created.status, diagnostic(created.body)).toBe(201); f.orderId = created.body.order.id;
  f.lineId = (await db().orderLine.findFirstOrThrow({ where: { orderId: f.orderId } })).id;
  const placed = await db().productionStage.findUniqueOrThrow({ where: { orderId_stageKey: { orderId: f.orderId, stageKey: 'order_placed' } } });
  expect(placed).toMatchObject({ status: 'done', stageSeq: 1 }); expect(placed.doneAt).not.toBeNull();
  const audit = await db().auditLog.findFirstOrThrow({ where: { actorId: f.actorId, action: 'create_direct_repeat_order', targetType: 'Order', targetId: f.orderId } });
  expect(audit.detail).toMatchObject({ source: 'route:orders:direct-repeat', after: { orderId: f.orderId, confirmedSourceId: f.assetId } });
  await savePreCutChecklist(db(), f.orderId, { gradingConfirmed: true, consumptionConfirmed: true, patternConfirmed: true, preProductionMeeting: true, confirmedBy: f.actorId });
  for (const step of PRODUCTION_STAGES.filter(step => step.seq > 1 && step.seq < 7)) {
    const advanced = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: step.key, operator: f.actorId }); expect(advanced.ok, diagnostic(advanced)).toBe(true);
  }
  expect(await db().productionStage.findUniqueOrThrow({ where: { id: placed.id } })).toEqual(placed);
  return f;
}
async function nativePp(f: Fixture, approved: boolean) {
  const created = await createSample({ prisma: db(), actorId: f.actorId, input: { type: 'pp', sourceOrderId: f.orderId, supplierRelationId: f.supplier.id, productAssetId: f.assetId } });
  expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok) throw Error('Native Sample creation failed');
  const sampleId = created.data.sample.id;
  for (const action of ['start', 'qc', 'submit', ...(approved ? ['confirm', 'approve'] as const : [])] as const) {
    const result = await advanceSampleStage({ prisma: db(), sampleId, action, actorId: f.actorId,
      input: { qcStatus: 'passed', customerStatus: 'approved', feedback: 'Synthetic observed PP sample decision', sentDate: '2099-11-01' } });
    expect(result.ok, diagnostic(result)).toBe(true);
  }
  const actual = await db().sample.findUniqueOrThrow({ where: { id: sampleId } });
  expect(actual.sourceCaseId).toBeNull(); expect(actual.sourceOrderId).toBe(f.orderId); expect(actual.status).toBe(approved ? 'approved' : 'submitted');
  if (approved) expect(await db().auditLog.count({ where: { action: 'advance_sample_stage', targetType: 'Sample', targetId: sampleId, detail: { path: ['after', 'action'], equals: 'approve' } } })).toBe(1);
  return sampleId;
}
/** Synthetic fixture unit is explicitly recorded by the original OrderLine
 * writer. Unknown units never authorize a guessed PB or implicit conversion. */
async function nativePhysicalBatch(f: Fixture, lineId: string, splitRange = false) {
  let line = await db().orderLine.findUniqueOrThrow({ where: { id: lineId } });
  if (line.unit == null) {
    const setUnit = await request(app()).put('/api/v1/order-lines/' + lineId).set('Authorization', 'Bearer ' + f.token).send({ unit: 'M' });
    expect(setUnit.status, diagnostic(setUnit.body)).toBe(200);
    line = await db().orderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line.unit).toBe('M');
  }
  const listed = await listProductionBatches({ prisma: db(), orderId: f.orderId, lineId, actor: f.trustedActor });
  expect(listed.ok, diagnostic(listed)).toBe(true); if (!listed.ok) throw Error('Native PB source listing failed');
  const command = { batchCode: f.id + '-release-' + line.lineNumber, quantity: line.quantity.toString(), unit: line.unit,
    expectedLineFingerprint: listed.data.lineFingerprint, requestKey: f.id + '-create-' + lineId };
  const made = await createProductionBatch({ prisma: db(), orderId: f.orderId, lineId, actor: f.trustedActor, input: command });
  expect(made.ok, diagnostic(made)).toBe(true); if (!made.ok) throw Error('Native PB create failed');
  let batch = made.data.batch;
  if (splitRange) {
    expect(line.quantity.toString()).toBe('100');
    const current = await listProductionBatches({ prisma: db(), orderId: f.orderId, lineId, actor: f.trustedActor });
    expect(current.ok, diagnostic(current)).toBe(true); if (!current.ok) throw Error('Native PB split source listing failed');
    const split = await splitProductionBatch({ prisma: db(), batchId: batch.id, actor: f.trustedActor, input: {
      expectedRevision: batch.revision, expectedLineFingerprint: current.data.lineFingerprint, requestKey: f.id + '-split-' + lineId,
      children: [{ batchCode: f.id + '-child40', quantity: '40' }, { batchCode: f.id + '-child60', quantity: '60' }] } });
    expect(split.ok, diagnostic(split)).toBe(true); if (!split.ok) throw Error('Native PB split failed');
    expect(split.data.parent.state).toBe('split'); expect(split.data.children.map((row: any) => row.quantity)).toEqual(['40','60']);
    batch = split.data.children[0];
  }
  const actual = await db().productionBatch.findUniqueOrThrow({ where: { id: batch.id } });
  expect(actual).toMatchObject({ orderId: f.orderId, orderLineId: lineId, revision: batch.revision, state: 'active',
    confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId });
  expect(actual.quantity.toString()).toBe(batch.quantity); expect(actual.unit).toBe(line.unit);
  return batch;
}
async function nativeScope(f: Fixture, lineId = f.lineId, assetId = f.assetId, millId = f.supplier.id) {
  const actualBatch = await nativePhysicalBatch(f, lineId);
  const line = await db().orderLine.findUniqueOrThrow({ where: { id: lineId } });
  const result = await createReleaseScope({ prisma: db(), orderId: f.orderId, orderLineId: lineId, actorId: f.actorId,
    input: { productionBatchId: actualBatch.id, expectedBatchRevision: actualBatch.revision, factoryRelationId: millId, quantity: actualBatch.quantity, unit: actualBatch.unit, confirmedSourceType: 'Asset', confirmedSourceId: assetId, specSnapshot: line.specSnapshot } });
  expect(result.ok, diagnostic(result)).toBe(true); if (!result.ok) throw Error('Native release scope failed');
  return result.data.scope.id;
}
async function requestFor(f: Fixture, sampleId?: string) {
  const actual = await createReleaseRequest({ prisma: db(), scopeId: f.scopeId, input: { sampleId }, actorId: f.actorId });
  expect(actual.ok, diagnostic(actual)).toBe(true); if (!actual.ok) throw Error('Native release request failed'); return actual.data.request.id;
}
async function released(f: Fixture, sampleMode?: 'approved' | 'submitted') {
  await nativeOrder(f); const sampleId = sampleMode ? await nativePp(f, sampleMode === 'approved') : undefined;
  f.scopeId = await nativeScope(f); const requestId = await requestFor(f, sampleId);
  const signed = await signReleaseRequest({ prisma: db(), requestId, role: 'business', actorId: f.actorId }); expect(signed.ok, diagnostic(signed)).toBe(true);
  expect(await evaluateProductionRelease({ prisma: db(), scopeId: f.scopeId })).toMatchObject({ ok: true, data: { eligible: true } });
  return { ...f, sampleId };
}
async function history(f: Fixture) {
  return { scope: await db().releaseScope.findUniqueOrThrow({ where: { id: f.scopeId } }),
    releases: await db().ppSampleRelease.findMany({ where: { scopeId: f.scopeId }, orderBy: { id: 'asc' } }),
    events: await db().releaseEvent.findMany({ where: { scopeId: f.scopeId }, orderBy: { sequence: 'asc' } }),
    stage: await db().productionStage.findUniqueOrThrow({ where: { orderId_stageKey: { orderId: f.orderId, stageKey: 'pp_sample_approved' } } }) };
}
function signal<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function connection() {
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('connection_limit', '3');
  const value = new PrismaClient({ datasources: { db: { url: url.toString() } } }); connections.push(value);
  const [actual] = await value.$queryRawUnsafe<any[]>('SELECT current_database() AS name,current_setting(\'data_directory\') AS directory,inet_server_port() AS port');
  expect(actual).toEqual({ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) });
  return value;
}
type Witness = { pid: number; ended: boolean; value?: any; error?: unknown };
type Hook = (phase: 'before' | 'after', model: string, method: string, args: any[], value: any, tx: any) => Promise<void>;
function scheduled(database: any, witness: Witness, hook?: Hook) {
  return new Proxy(database, { get(base, key) {
    if (key === '$transaction') return (work: any, options?: any) => base.$transaction(async (tx: any) => {
      const [identity] = await tx.$queryRawUnsafe('SELECT current_database() AS name,pg_backend_pid() AS pid');
      expect(identity.name).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_NAME); witness.pid = identity.pid;
      const wrapped = new Proxy(tx, { get(current, model) {
        const delegate = Reflect.get(current, model);
        if (!delegate || typeof delegate !== 'object' || !hook) return typeof delegate === 'function' ? delegate.bind(current) : delegate;
        return new Proxy(delegate, { get(actual, method) {
          const value = Reflect.get(actual, method); if (typeof value !== 'function') return value;
          return async (...args: any[]) => { await hook('before', String(model), String(method), args, undefined, tx);
            const result = await value.apply(actual, args); await hook('after', String(model), String(method), args, result, tx); return result; };
        } });
      } });
      return work(wrapped);
    }, { ...options, timeout: 20000, maxWait: 10000 });
    const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
  } });
}
function tracked<T>(work: Promise<T>, witness: Witness): Promise<T> {
  return work.then(value => { witness.value = value; witness.ended = true; return value; }, error => { witness.error = error; witness.ended = true; throw error; });
}
async function until<T>(check: () => Promise<T | null>, why: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) { const actual = await check(); if (actual !== null) return actual; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Actual PostgreSQL scheduling witness absent: ' + why);
}
async function endedOrBlocked(waiter: Witness, blocker: Witness) {
  return until(async () => {
    if (waiter.ended) return { kind: 'completed' as const, blockers: [] as number[] };
    if (!waiter.pid || !blocker.pid) return null;
    const [actual] = await db().$queryRawUnsafe('SELECT pg_blocking_pids($1::integer) AS blockers', waiter.pid);
    return actual.blockers.includes(blocker.pid) ? { kind: 'blocked' as const, blockers: actual.blockers as number[] } : null;
  }, 'native writer completion or actual parent row-lock wait');
}
async function reached(gate: { promise: Promise<void> }, writer: Promise<unknown>) {
  await Promise.race([gate.promise, writer.then(value => { throw Error('Native writer returned before the scheduled real SQL seam: ' + diagnostic(value)); })]);
}
async function retains(original: any[], f: Fixture) {
  expect(await db().ppSampleRelease.findMany({ where: { id: { in: original.map(row => row.id) } }, orderBy: { id: 'asc' } })).toEqual(original);
}

describe.sequential('native production release lock order and isolated current eligibility with real PG', () => {
  it('FRC01 a delayed signer cannot resurrect a scope invalidated after its earlier read; serialized valid sign remains legal', async () => {
    const f = await released(await fixture('stale-sign')), original = await history(f), pending = await requestFor(f);
    const signWitness: Witness = { pid: 0, ended: false }, changeWitness: Witness = { pid: 0, ended: false }, read = signal(), resume = signal();
    let paused = false, signing: Promise<any> | undefined, changing: Promise<any> | undefined;
    try {
      const signer = scheduled(await connection(), signWitness, async (phase, model, method, args, value) => {
        if (!paused && phase === 'after' && model === 'releaseScope' && method === 'findFirst' && args[0]?.where?.id === f.scopeId && value) {
          paused = true; expect(value.state).toBe('ready'); read.resolve(); await resume.promise;
        }
      });
      signing = tracked(signReleaseRequest({ prisma: signer, requestId: pending, role: 'business', actorId: f.actorId }), signWitness);
      await reached(read, signing);
      changing = tracked(feedback(f, 'needs_recast', scheduled(await connection(), changeWitness)), changeWitness);
      const scheduling = await endedOrBlocked(changeWitness, signWitness);
      if (scheduling.kind === 'blocked') {
        expect(scheduling.blockers).toContain(signWitness.pid); resume.resolve();
        expect((await signing).ok).toBe(true); await changing;
      } else {
        await changing;
        expect(await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId })).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } });
        resume.resolve(); expect((await signing).ok, 'No source/scope lock held: signer must reject the committed invalidation').toBe(false);
        expect(await db().ppSampleRelease.count({ where: { requestId: pending } })).toBe(0);
        expect(await db().releaseSignature.count({ where: { requestId: pending } })).toBe(0);
      }
      expect(await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId })).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } });
      const after = await history(f); expect(after.scope.state).toBe('invalidated'); expect(after.stage).toEqual(original.stage);
      expect(after.events.at(-1)).toMatchObject({ kind: 'invalidated', releaseId: after.scope.currentReleaseId }); await retains(original.releases, f);
      expect(await evaluateProductionRelease({ prisma: db(), scopeId: f.scopeId })).toMatchObject({ ok: true, data: { eligible: false } });
    } finally { resume.resolve(); await Promise.allSettled([signing, changing].filter(Boolean) as Promise<unknown>[]); }
  }, 30000);

  it('FRC02 actual event uniqueness and scope row locks cannot form an Event→Scope / Scope→Event deadlock', async () => {
    const f = await released(await fixture('event-lock-order')), original = await history(f), pending = await requestFor(f);
    const signWitness: Witness = { pid: 0, ended: false }, changeWitness: Witness = { pid: 0, ended: false }, stageWitness: Witness = { pid: 0, ended: false };
    const inserted = signal(), resume = signal(); let paused = false, signing: Promise<any> | undefined, changing: Promise<any> | undefined, advancing: Promise<any> | undefined;
    try {
      const signer = scheduled(await connection(), signWitness, async (phase, model, method, args, value) => {
        if (!paused && phase === 'after' && model === 'releaseEvent' && method === 'create' && args[0]?.data?.kind === 'granted' && args[0]?.data?.scopeId === f.scopeId) {
          paused = true; expect(value.sequence).toBe(original.events.at(-1).sequence + 1); inserted.resolve(); await resume.promise;
        }
      });
      signing = tracked(signReleaseRequest({ prisma: signer, requestId: pending, role: 'business', actorId: f.actorId }), signWitness); await reached(inserted, signing);
      changing = tracked(feedback(f, 'needs_recast', scheduled(await connection(), changeWitness)), changeWitness);
      const sourceSchedule = await endedOrBlocked(changeWitness, signWitness);
      if (sourceSchedule.kind === 'blocked') {
        expect(sourceSchedule.blockers).toContain(signWitness.pid); resume.resolve(); expect((await signing).ok).toBe(true); await changing;
        advancing = tracked(advanceStage({ prisma: scheduled(await connection(), stageWitness), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId }), stageWitness);
      } else {
        await changing;
        advancing = tracked(advanceStage({ prisma: scheduled(await connection(), stageWitness), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId }), stageWitness);
        const eventWait = await endedOrBlocked(stageWitness, signWitness);
        expect(eventWait.kind).toBe('blocked'); expect(eventWait.blockers).toContain(signWitness.pid);
        const [actual] = await db().$queryRawUnsafe('SELECT query FROM pg_stat_activity WHERE pid=$1::integer', stageWitness.pid);
        expect(actual.query).toContain('ReleaseEvent'); resume.resolve();
        // Both sides are real transactions. The old implementation reaches a
        // genuine PG deadlock; neither a timeout nor a mocked P2034 proves it.
        expect((await signing).ok, diagnostic(signWitness.value)).toBe(true);
      }
      expect(await advancing).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } });
      const after = await history(f); expect(after.scope.state).toBe('invalidated'); expect(after.stage).toEqual(original.stage); await retains(original.releases, f);
      expect(after.events.map((row: any) => row.sequence)).toEqual(after.events.map((_row: any, index: number) => index + 1));
    } finally { resume.resolve(); await Promise.allSettled([signing, changing, advancing].filter(Boolean) as Promise<unknown>[]); }
  }, 30000);

  it('FRC03 a separately committed PP revision after the last eligibility read cannot finish production from stale evidence', async () => {
    // Native Sample approved has no native revise transition. This uses a
    // genuinely submitted/revisable PP sample and the current native leader
    // release approval, not a seeded Approved→revising or completed stage.
    const f = await released(await fixture('pp-evidence-gap'), 'submitted'), original = await history(f);
    const stageWitness: Witness = { pid: 0, ended: false }, sampleWitness: Witness = { pid: 0, ended: false }, lastRead = signal(), resume = signal();
    let paused = false, advancing: Promise<any> | undefined, revising: Promise<any> | undefined;
    try {
      const stageDatabase = scheduled(await connection(), stageWitness, async (phase, model, method, args) => {
        if (!paused && phase === 'before' && model === 'productionStage' && method === 'update' && args[0]?.where?.id === original.stage.id && args[0]?.data?.status === 'done') {
          paused = true; lastRead.resolve(); await resume.promise;
        }
      });
      advancing = tracked(advanceStage({ prisma: stageDatabase, orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId }), stageWitness); await reached(lastRead, advancing);
      revising = tracked(advanceSampleStage({ prisma: scheduled(await connection(), sampleWitness), sampleId: f.sampleId!, action: 'revise', actorId: f.actorId, input: { feedback: 'Synthetic PP correction while production really waits' } }), sampleWitness);
      const observed = await until(async () => {
        const current = await db().sample.findUniqueOrThrow({ where: { id: f.sampleId! } });
        if (current.status === 'revising') return { kind: 'committed' as const, current };
        if (sampleWitness.ended) throw Error('Native revise ended without revision: ' + diagnostic(sampleWitness.value));
        if (!sampleWitness.pid) return null;
        const [actual] = await db().$queryRawUnsafe('SELECT pg_blocking_pids($1::integer) AS blockers', sampleWitness.pid);
        return actual.blockers.includes(stageWitness.pid) ? { kind: 'blocked' as const, current } : null;
      }, 'real PP revision commit or stage-held Sample lock');
      resume.resolve(); const stageResult = await advancing;
      if (observed.kind === 'committed') {
        expect(observed.current.round).toBe(1); // revision is invalid before any next-round increment.
        expect(stageResult.ok, 'PP invalidity committed before the stage write; old qualification must not complete production').toBe(false);
      } else {
        expect(observed.current.status).toBe('submitted'); expect(stageResult.ok, diagnostic(stageResult)).toBe(true);
      }
      const revision = await revising; expect(revision.ok, diagnostic(revision)).toBe(true);
      expect(await db().sample.findUniqueOrThrow({ where: { id: f.sampleId! } })).toMatchObject({ status: 'revising', round: 1 });
      expect(await evaluateProductionRelease({ prisma: db(), scopeId: f.scopeId })).toMatchObject({ ok: true, data: { eligible: false } });
      await retains(original.releases, f);
      if (observed.kind === 'committed') expect((await history(f)).stage).toEqual(original.stage);
    } finally { resume.resolve(); await Promise.allSettled([advancing, revising].filter(Boolean) as Promise<unknown>[]); }
  }, 30000);

  it('FRC04 fully native PP approval and a valid current fabric source still advance with immutable approval history', async () => {
    const f = await released(await fixture('approved-pp-control'), 'approved'), original = await history(f);
    expect(original.releases).toHaveLength(1); expect(original.releases[0]).toMatchObject({ sampleId: f.sampleId, sampleRound: 1 });
    expect(await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId })).toMatchObject({ ok: true });
    expect(await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'manufacturing', operator: f.actorId })).toMatchObject({ ok: true });
    await retains(original.releases, f); expect((await history(f)).events).toEqual(original.events);
  });

  it('FRC05 one corrupt historical source cannot block a different native ready line; only its scope is invalidated', async () => {
    const bad = await released(await fixture('partial-bad')), good = await fixture('partial-good', { supplier: bad.supplier }), badBefore = await history(bad);
    const goodAsset = await db().productAsset.findUniqueOrThrow({ where: { id: good.assetId } });
    const createdLine = await request(app()).post('/api/v1/order-lines').set('Authorization', 'Bearer ' + bad.token)
      .send({ poNumber: bad.id, materialCode: goodAsset.sku, description: 'Synthetic independent valid line', quantity: 100 });
    expect(createdLine.status, diagnostic(createdLine.body)).toBe(200); const goodLineId = createdLine.body.line.id;
    const version = await request(app()).patch('/api/v1/order-lines/' + goodLineId + '/version').set('Authorization', 'Bearer ' + bad.token)
      .send({ confirmedSourceType: 'Asset', confirmedSourceId: good.assetId, millRelationId: good.supplier.id });
    expect(version.status, diagnostic(version.body)).toBe(200);
    const goodScopeId = await nativeScope(bad, goodLineId, good.assetId, good.supplier.id), goodScopeFixture = { ...bad, scopeId: goodScopeId };
    const goodRequestId = await requestFor(goodScopeFixture);
    const goodSign = await signReleaseRequest({ prisma: db(), requestId: goodRequestId, role: 'business', actorId: bad.actorId }); expect(goodSign.ok, diagnostic(goodSign)).toBe(true);
    const goodBefore = await history(goodScopeFixture);
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'convert_fabric_to_asset', targetType: 'ProductAsset', targetId: bad.assetId } });
    // Explicitly damage one already native-produced historical fact. No
    // manufacturing, approved source or sign fact is seeded by the probe.
    await db().auditLog.update({ where: { id: audit.id }, data: { detail: { ...audit.detail, after: { ...audit.detail.after, sourceId: bad.id + '-missing-actual-batch' } } } });
    expect(await summarizeOrderReleases({ prisma: db(), orderId: bad.orderId })).toMatchObject({ ok: true, data: { total: 2, ready: 1, blocked: 1, summary: 'partial' } });
    expect(await advanceStage({ prisma: db(), orderId: bad.orderId, stageKey: 'pp_sample_approved', operator: bad.actorId })).toMatchObject({ ok: true });
    const badAfter = await history(bad), goodAfter = await history(goodScopeFixture);
    expect(badAfter.scope).toMatchObject({ state: 'invalidated', currentReleaseId: badBefore.scope.currentReleaseId });
    expect(badAfter.events).toHaveLength(badBefore.events.length + 1); expect(badAfter.events.at(-1)).toMatchObject({ kind: 'invalidated', releaseId: badBefore.scope.currentReleaseId });
    expect(goodAfter.scope).toEqual(goodBefore.scope); expect(goodAfter.events).toEqual(goodBefore.events); await retains(badBefore.releases, bad); await retains(goodBefore.releases, goodScopeFixture);
    expect(await db().auditLog.count({ where: { action: 'invalidate_release_source', targetType: 'ReleaseScope', targetId: bad.scopeId } })).toBe(1);
    expect(await advanceStage({ prisma: db(), orderId: bad.orderId, stageKey: 'manufacturing', operator: bad.actorId })).toMatchObject({ ok: true });
    expect(await summarizeOrderReleases({ prisma: db(), orderId: bad.orderId })).toMatchObject({ ok: true, data: { ready: 1, blocked: 1, summary: 'partial' } });
  }, 30000);
});
