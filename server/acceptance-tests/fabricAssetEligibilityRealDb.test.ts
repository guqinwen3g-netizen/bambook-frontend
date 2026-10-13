/** Opt-in private PG: synthetic initial development/customer observations,
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
import { createOrderLine } from '../src/orders/orderLineMutationService';
import { createSampleBatch, advanceSampleBatchStage, submitBatchCustomerFeedback, convertToFabricAsset, createSealSample, sealSampleConfirm } from '../src/development/fabricDevelopmentService';
import { assertFabricAssetEligible } from '../src/development/fabricAssetEligibility';
import { listProductionBatches, createProductionBatch, splitProductionBatch } from '../src/production/productionBatchService';
import { createReleaseScope, createReleaseRequest, signReleaseRequest, evaluateProductionRelease, summarizeOrderReleases } from '../src/production/releaseService';
import { advanceStage, savePreCutChecklist, PRODUCTION_STAGES } from '../src/production/stageService';

const prefix = 'acceptance-fabric-asset-' + randomUUID();
let prisma: PrismaClient | undefined, sequence = 0;
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
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string) {
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
  const supplier = await db().relation.create({ data: { id: id + '-supplier', name: id + '-actual-mill', category: 'Supplier', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
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
async function feedback(f: Fixture, status: string) {
  const batch = await db().sampleBatch.findUniqueOrThrow({ where: { id: f.batchId } });
  const result = await submitBatchCustomerFeedback({ prisma: db(), batchId: f.batchId, actorId: f.actorId, trustedActor: f.trustedActor,
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
    millRelationId: f.supplier.id, clientRequestId: randomUUID(), quantity: 100, dueDate: '2099-11-01', quoteAmount: 100, customer: 'Synthetic independent repeat buyer' });
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
async function releasedOrder(f: Fixture) {
  const created = await repeat(f); expect(created.status, diagnostic(created.body)).toBe(201); f.orderId = created.body.order.id;
  f.lineId = (await db().orderLine.findFirstOrThrow({ where: { orderId: f.orderId } })).id;
  // The native repeat endpoint calls initProductionStages: business order
  // placement is already completed there. Verify that actual source fact and
  // its native creation audit instead of attempting to complete it twice.
  const initializedStages = await db().productionStage.findMany({ where: { orderId: f.orderId }, orderBy: { stageSeq: 'asc' } });
  expect(initializedStages).toHaveLength(PRODUCTION_STAGES.length);
  expect(initializedStages[0]).toMatchObject({ stageKey: 'order_placed', stageSeq: 1, status: 'done' });
  expect(initializedStages[0].doneAt).not.toBeNull();
  expect(initializedStages.slice(1).every((stage: any) => stage.status === 'pending' && stage.doneAt === null)).toBe(true);
  const placementAudit = await db().auditLog.findFirstOrThrow({ where: { actorId: f.actorId, action: 'create_direct_repeat_order', targetType: 'Order', targetId: f.orderId } });
  expect(placementAudit.detail).toMatchObject({ source: 'route:orders:direct-repeat', after: { orderId: f.orderId, confirmedSourceType: 'Asset', confirmedSourceId: f.assetId } });
  await savePreCutChecklist(db(), f.orderId, { gradingConfirmed: true, consumptionConfirmed: true, patternConfirmed: true, preProductionMeeting: true, confirmedBy: f.actorId });
  for (const step of PRODUCTION_STAGES.filter(step => step.seq > 1 && step.seq < 7)) {
    const result = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: step.key, operator: f.actorId }); expect(result.ok, diagnostic(result)).toBe(true);
  }
  expect(await db().productionStage.findUniqueOrThrow({ where: { id: initializedStages[0].id } })).toEqual(initializedStages[0]);
  const actualBatch = await nativePhysicalBatch(f, f.lineId, true);
  const scope = await createReleaseScope({ prisma: db(), orderId: f.orderId, orderLineId: f.lineId, actorId: f.actorId,
    input: { productionBatchId: actualBatch.id, expectedBatchRevision: actualBatch.revision, factoryRelationId: f.supplier.id, quantity: actualBatch.quantity, unit: actualBatch.unit, confirmedSourceType: 'Asset', confirmedSourceId: f.assetId,
      specSnapshot: (await db().orderLine.findUniqueOrThrow({ where: { id: f.lineId } })).specSnapshot } });
  expect(scope.ok, diagnostic(scope)).toBe(true); f.scopeId = (scope as any).data.scope.id;
  const requested = await createReleaseRequest({ prisma: db(), scopeId: f.scopeId, input: {}, actorId: f.actorId }); expect(requested.ok, diagnostic(requested)).toBe(true);
  const signed = await signReleaseRequest({ prisma: db(), requestId: (requested as any).data.request.id, role: 'business', actorId: f.actorId });
  expect(signed.ok, diagnostic(signed)).toBe(true); return f;
}
async function history(f: Fixture) {
  return { batch: await db().sampleBatch.findUniqueOrThrow({ where: { id: f.batchId } }), release: await db().ppSampleRelease.findMany({ where: { scopeId: f.scopeId } }),
    events: await db().releaseEvent.findMany({ where: { scopeId: f.scopeId }, orderBy: { sequence: 'asc' } }), scope: f.scopeId ? await db().releaseScope.findUniqueOrThrow({ where: { id: f.scopeId } }) : null,
    stages: await db().productionStage.findMany({ where: { orderId: f.orderId }, orderBy: { stageSeq: 'asc' } }), audits: await db().auditLog.findMany({ where: { actorId: f.actorId }, orderBy: { id: 'asc' } }) };
}

describe.sequential('native fabric asset current-source consumers with real PG', () => {
  it('FAE01 native approval/conversion, repeat, manual split and actual stage advance qualify', async () => {
    const f = await releasedOrder(await fixture('current'));
    expect(await evaluateProductionRelease({ prisma: db(), scopeId: f.scopeId })).toMatchObject({ ok: true, data: { eligible: true } });
    const result = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId }); expect(result.ok, diagnostic(result)).toBe(true);
    const manufacturing = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'manufacturing', operator: f.actorId }); expect(manufacturing.ok, diagnostic(manufacturing)).toBe(true);
  });
  it.each(['needs_recast', 'rejected'])('FAE02 current %s refuses repeat and version without writes while retaining conversion facts', async status => {
    const f = await releasedOrder(await fixture(status)); await feedback(f, status); const before = await history(f), count = await db().order.count();
    const blocked = await repeat(f); expect(blocked.status, diagnostic(blocked.body)).toBe(409);
    const version = await request(app()).patch('/api/v1/order-lines/' + f.lineId + '/version').set('Authorization', 'Bearer ' + f.token).send({ confirmedSourceType: 'Asset', confirmedSourceId: f.assetId });
    expect(version.status, diagnostic(version.body)).toBe(409); expect(await db().order.count()).toBe(count); expect(await history(f)).toEqual(before);
  });
  it('FAE03 actual new round conversion does not make the old asset independent', async () => {
    const f = await fixture('old-id'), oldId = f.assetId; await feedback(f, 'needs_recast'); await action(f, 'revise', { feedback: 'Synthetic customer requests new round' });
    await action(f, 'start'); await action(f, 'send'); await action(f, 'approve');
    const converted = await convertToFabricAsset({ prisma: db(), caseId: f.caseId, sourceType: 'batch', sourceId: f.batchId, actorId: f.actorId, trustedActor: f.trustedActor });
    expect(converted.ok, diagnostic(converted)).toBe(true); const newId = (converted as any).data.asset.id; expect(newId).not.toBe(oldId);
    const blocked = await repeat(f, db(), oldId); expect(blocked.status, diagnostic(blocked.body)).toBe(409);
    const current = await repeat(f, db(), newId); expect(current.status, diagnostic(current.body)).toBe(201);
    expect(await db().auditLog.count({ where: { action: 'convert_fabric_to_asset', targetId: oldId } })).toBe(1);
  });
  it.each(['pp_sample_approved', 'manufacturing'] as const)('FAE04 %s blocks ownerOverride, appends invalidation once and retains all old approvals', async stageKey => {
    const f = await releasedOrder(await fixture(stageKey));
    if (stageKey === 'manufacturing') expect((await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId })).ok).toBe(true);
    await feedback(f, 'needs_recast'); const before = await history(f);
    expect(await summarizeOrderReleases({ prisma: db(), orderId: f.orderId })).toMatchObject({ ok: true, data: { ready: 0 } }); expect(await history(f)).toEqual(before);
    const result = await advanceStage({ prisma: db(), orderId: f.orderId, stageKey, operator: f.actorId, ownerOverride: { reason: 'Synthetic urgent attempt' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } }); const after = await history(f);
    expect(after.release).toEqual(before.release); expect(after.stages).toEqual(before.stages); expect(after.scope).toMatchObject({ state: 'invalidated', currentReleaseId: before.scope.currentReleaseId });
    expect(after.events).toHaveLength(before.events.length + 1); expect(after.events.at(-1)).toMatchObject({ kind: 'invalidated', releaseId: before.scope.currentReleaseId });
    expect(after.audits.filter((row: any) => row.action === 'invalidate_release_source')).toHaveLength(1);
    await advanceStage({ prisma: db(), orderId: f.orderId, stageKey, operator: f.actorId, ownerOverride: { reason: 'Repeat urgent attempt' } }); expect(await history(f)).toEqual(after);
  });
  it('FAE05 invalidation mandatory audit real P2003 rolls back event/projection and preserves stage; normal retry commits', async () => {
    const f = await releasedOrder(await fixture('audit-fault')); await feedback(f, 'rejected'); const before = await history(f); const observed: any = {};
    const faulty = new Proxy(db(), { get(base, key) {
      if (key === '$transaction') return (work: any, options: any) => base.$transaction((tx: any) => work(new Proxy(tx, { get(current, model) {
        if (model === 'auditLog') return new Proxy(current.auditLog, { get(audit, method) {
          if (method === 'create') return async (args: any) => {
            if (args.data.action !== 'invalidate_release_source') return audit.create(args);
            observed.stagedScope = await current.releaseScope.findUniqueOrThrow({ where: { id: f.scopeId } });
            observed.stagedEvents = await current.releaseEvent.count({ where: { scopeId: f.scopeId } });
            try { return await audit.create({ ...args, data: { ...args.data, actorId: prefix + '-missing-actual-FK' } }); }
            catch (error: any) { observed.code = error.code; throw error; }
          };
          const value = Reflect.get(audit, method); return typeof value === 'function' ? value.bind(audit) : value;
        } });
        const value = Reflect.get(current, model); return typeof value === 'function' ? value.bind(current) : value;
      } })), options);
      const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
    } });
    expect(await advanceStage({ prisma: faulty, orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId })).toMatchObject({ ok: false, error: { code: 'STAGE_UPDATE_FAILED' } });
    expect(observed).toMatchObject({ code: 'P2003', stagedScope: { state: 'invalidated' }, stagedEvents: before.events.length + 1 }); expect(await history(f)).toEqual(before);
    expect(await advanceStage({ prisma: db(), orderId: f.orderId, stageKey: 'pp_sample_approved', operator: f.actorId })).toMatchObject({ ok: false, error: { code: 'PP_RELEASE_BLOCKED' } });
    expect((await history(f)).scope.state).toBe('invalidated');
  });
  it('FAE06 standalone manually authored asset can repeat and bind a version without inferred development provenance', async () => {
    const f = await fixture('standalone'), id = f.id + '-independent'; await db().productAsset.create({ data: { id, sku: id, name: 'Fabric development-looking manual title', mainCategory: 'Fabric', subCategoryId: 'uncategorized', season: '', source: 'development', status: 'Development', cost: null, updatedAt: BigInt(Date.now()) } });
    const created = await repeat(f, db(), id); expect(created.status, diagnostic(created.body)).toBe(201); const line = await db().orderLine.findFirstOrThrow({ where: { orderId: created.body.order.id } });
    const bound = await request(app()).patch('/api/v1/order-lines/' + line.id + '/version').set('Authorization', 'Bearer ' + f.token).send({ confirmedSourceType: 'Asset', confirmedSourceId: id });
    expect(bound.status, diagnostic(bound.body)).toBe(200); expect(await assertFabricAssetEligible(db(), id)).toEqual({ source: null });
  });
  it('FAE07 seal-native conversion follows actual component batches and becomes ineligible on current rejection', async () => {
    const f = await fixture('seal'); const seal = await createSealSample({ prisma: db(), caseId: f.caseId, actorId: f.actorId, input: { batchIds: [f.batchId] } }); expect(seal.ok, diagnostic(seal)).toBe(true);
    const sealId = (seal as any).data.seal.id; const sealed = await sealSampleConfirm({ prisma: db(), sealId, actorId: f.actorId, trustedActor: f.trustedActor }); expect(sealed.ok, diagnostic(sealed)).toBe(true);
    const converted = await convertToFabricAsset({ prisma: db(), caseId: f.caseId, sourceType: 'seal', sourceId: sealId, actorId: f.actorId, trustedActor: f.trustedActor }); expect(converted.ok, diagnostic(converted)).toBe(true);
    const assetId = (converted as any).data.asset.id; expect((await repeat(f, db(), assetId)).status).toBe(201); await feedback(f, 'rejected');
    const blocked = await repeat(f, db(), assetId); expect(blocked.status, diagnostic(blocked.body)).toBe(409);
  });
  it('FAE08 damaged conversion audit cannot be rescued by approved/current-pointer projections', async () => {
    const f = await fixture('damaged'); const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'convert_fabric_to_asset', targetId: f.assetId } });
    await db().auditLog.update({ where: { id: audit.id }, data: { detail: { ...audit.detail, after: { ...audit.detail.after, sourceId: f.id + '-missing-batch' } } } }); // Explicit corruption after native fact formation.
    const count = await db().order.count(); const blocked = await repeat(f); expect(blocked.status, diagnostic(blocked.body)).toBe(409); expect(await db().order.count()).toBe(count);
  });
  it('FAE09 current source is rechecked inside the actual transaction after an initially valid HTTP read', async () => {
    const f = await fixture('transaction-recheck'); const count = await db().order.count(); let reached = false;
    const changed = new Proxy(db(), { get(base, key) {
      if (key === '$transaction') return async (work: any, options: any) => {
        if (!reached) { reached = true; await feedback(f, 'needs_recast'); }
        return base.$transaction(work, options);
      };
      const value = Reflect.get(base, key); return typeof value === 'function' ? value.bind(base) : value;
    } });
    const blocked = await repeat(f, changed); expect(reached).toBe(true); expect(blocked.status, diagnostic(blocked.body)).toBe(409);
    expect(await db().order.count()).toBe(count); expect(await db().orderLine.count({ where: { confirmedSourceId: f.assetId } })).toBe(0);
    expect(await db().auditLog.count({ where: { actorId: f.actorId, action: 'create_direct_repeat_order' } })).toBe(0);
  });
});


describe.sequential('native exclusive fabric refusal is not permission and survives business rollback', () => {
  it('FAE12 actual denied OrderLine transaction keeps all original facts and a separate attempted-use audit', async () => {
    const f = await fixture('exclusive-refused-attempt');
    const placed = await repeat(f); expect(placed.status, diagnostic(placed.body)).toBe(201); f.orderId = placed.body.order.id;
    const owner = await db().relation.create({ data: { id: f.id + '-foreign-owner', name: f.id + '-exclusive-owner',
      category: 'Customer', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
    const clientCode = f.id + '-exclusive-code';
    await db().fabricCustomerCode.create({ data: { id: f.id + '-exclusive-mapping', productAssetId: f.assetId,
      clientCode, customerOrganizationId: owner.id, customerNameSnapshot: owner.name, isExclusive: true, updatedAt: BigInt(Date.now()) } });
    const before = { order: await db().order.findUniqueOrThrow({ where: { id: f.orderId } }),
      lines: await db().orderLine.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
      audits: await db().auditLog.findMany({ where: { actorId: f.actorId }, orderBy: { id: 'asc' } }) };
    const denied = await createOrderLine({ prisma: db(), orderId: f.orderId, materialCode: clientCode,
      quantity: 10, actorId: f.actorId, trustedActor: f.trustedActor });
    expect(denied).toMatchObject({ ok: false, error: { code: 'EXCLUSIVE_FABRIC_BLOCKED' } });
    expect(await db().order.findUniqueOrThrow({ where: { id: f.orderId } })).toEqual(before.order);
    expect(await db().orderLine.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } })).toEqual(before.lines);
    const after = await db().auditLog.findMany({ where: { actorId: f.actorId }, orderBy: { id: 'asc' } });
    for (const old of before.audits) expect(after.find((row: any) => row.id === old.id)).toEqual(old);
    const attempts = after.filter((row: any) => !before.audits.some((old: any) => old.id === row.id));
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ action: 'exclusive_fabric_violation_attempt',
      targetType: 'ProductAsset', targetId: f.assetId, detail: { source: 'fabric-exclusivity:order-line:create',
        after: { documentRef: { orderId: f.orderId } } } });
  });
  it('FAE13 actual current-source storage rejection cannot become an allowed OrderLine write', async () => {
    const f = await fixture('exclusive-source-unavailable');
    const placed = await repeat(f); expect(placed.status, diagnostic(placed.body)).toBe(201); f.orderId = placed.body.order.id;
    const clientCode = f.id + '-current-code';
    await db().fabricCustomerCode.create({ data: { id: f.id + '-current-mapping', productAssetId: f.assetId,
      clientCode, isExclusive: false, updatedAt: BigInt(Date.now()) } });
    const before = await db().orderLine.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
    const audits = await db().auditLog.findMany({ where: { actorId: f.actorId }, orderBy: { id: 'asc' } });
    let rejectedSourceReads = 0;
    const database = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return (work: any, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, {
        get(actual, model) {
          if (model === 'productAsset') return new Proxy(actual.productAsset, { get(delegate, method) {
            if (method === 'findMany') return async () => { rejectedSourceReads++; throw new Error('SQL private_source_unavailable'); };
            const value = delegate[method]; return typeof value === 'function' ? value.bind(delegate) : value;
          } });
          const value = actual[model]; return typeof value === 'function' ? value.bind(actual) : value;
        },
      })), options);
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const denied = await createOrderLine({ prisma: database, orderId: f.orderId, materialCode: clientCode,
      quantity: 10, actorId: f.actorId, trustedActor: f.trustedActor });
    expect(rejectedSourceReads).toBe(1); expect(denied).toMatchObject({ ok: false, error: { code: 'PRODUCT_EXCLUSIVITY_CHECK_FAILED' } });
    expect(JSON.stringify(denied)).not.toMatch(/SQL|private_source_unavailable/);
    expect(await db().orderLine.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await db().auditLog.findMany({ where: { actorId: f.actorId }, orderBy: { id: 'asc' } })).toEqual(audits);
  });
});
