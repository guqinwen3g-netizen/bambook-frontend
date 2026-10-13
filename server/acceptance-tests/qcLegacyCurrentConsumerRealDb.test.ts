/** TEST FIRST: private PG + actual mounted QC/production/batch routes.
 * Source contract: V1实际批次与验货交接契约 §§QC覆盖/报告修订 and immutable
 * native business decision. A production PUT cannot impersonate inspector or
 * business signer, nor upsert over signed/decided native history.
 * INITIAL Pending Order/Lines/manual standalone Assets isolate consumers; no
 * approval, report, completed inspection or ProductionBatch is seeded. Batch,
 * QC revisions, signatures/decisions and stage completion use real producers.
 * Native stage initialization owns its initial order_placed projection. The
 * synthetic checklist/PP stage sign/advances are software state controls, not
 * evidence of actual factory manufacture, sample qualification or shipment.
 * Fabric bulkQc is asserted separately: S/S, RC, LC, deposit, stock and actual
 * shipment eligibility are not replaced by passing QC or qc_shipped.
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
import { createQcRouter } from '../src/qc/qcRoute';
import { createProductionRouter } from '../src/production/route';
import { createProductionV2Router } from '../src/production/routeV2';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { initProductionStages, PRODUCTION_STAGES } from '../src/production/stageService';

const prefix = `acceptance-qc-current-${randomUUID()}`, auth = createAuthService();
const grants = ['qc:read', 'qc:write', 'orders:read', 'orders:write', 'products:read', 'production:read', 'production:write'];
let prisma: PrismaClient | undefined, sequence = 0;
const db = () => { if (!prisma) throw Error('Private QC-consumer PG identity not verified'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, row) => typeof row === 'bigint' ? row.toString() : row);
const code = (response: any) => response.body.error?.code ?? response.body.error;
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed isolated QC-consumer sandbox required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  // Exact supported current leader identity needed by the native Batch writer;
  // no role grants are changed. QC business authority remains actual Order.owner.
  await db().role.upsert({ where: { id: 'manager' }, update: {}, create: { id: 'manager', name: 'Synthetic current technical leader', isSystem: true } });
});
afterAll(async () => { await prisma?.$disconnect(); });
async function current(userId: string) {
  const user = await loadUserWithRoles(db(), userId); expect(user?.status).toBe('active');
  const actor = await buildLoadedAuthTokenPayload(db(), user); expect(actor.authorizationLoaded).toBe(true);
  return { ...actor, permissionCeiling: [...grants] } as TokenPayload;
}
async function fixture(label: string) {
  const id = `${prefix}-${++sequence}-${label}`, ownerId = `${id}-owner`, inspectorId = `${id}-inspector`, otherId = `${id}-other`,
    customerId = `${id}-customer`, factoryId = `${id}-factory`, orderId = `${id}-order`, now = BigInt(Date.now());
  const lineIds = [`${id}-line-a`, `${id}-line-b`];
  await db().$transaction(async tx => {
    for (const userId of [ownerId, inspectorId, otherId]) {
      await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic QC consumer participant', status: 'active' } });
      await tx.userPermissionOverrides.createMany({ data: grants.map(scope => ({ id: `${userId}-${scope}`, userId,
        scope, isActive: true, grantedBy: userId, reason: 'Exact isolated technical capability; not company default role-policy UAT' })) });
    }
    await tx.userRole.create({ data: { id: `${id}-manager-assignment`, userId: ownerId, roleId: 'manager' } });
    const customRoleId = `${id}-inspector-role`;
    await tx.role.create({ data: { id: customRoleId, name: 'owner', isSystem: false } });
    await tx.userRole.create({ data: { id: `${id}-inspector-assignment`, userId: inspectorId, roleId: customRoleId } });
    for (const [relationId, category] of [[customerId, 'Customer'], [factoryId, 'Supplier']] as const) {
      await tx.relation.create({ data: { id: relationId, name: relationId, category, type: 'Company', isOrganization: true,
        ownerId, salesRepIds: relationId === customerId ? [inspectorId] : [], tags: [], contactInfo: '{}', lastInteraction: now } });
    }
    await tx.order.create({ data: { id: orderId, poNumber: `${id}-PO`, customer: customerId, customerRelationId: customerId,
      ownerId, millRelationId: factoryId, product: 'Synthetic independent QC consumer', type: 'Fabric', quantity: 100,
      quoteAmount: '100', status: 'Pending', dueDate: '2099-01-01', updatedAt: now } });
    for (const [index, qty] of ['40', '60'].entries()) {
      const assetId = `${id}-asset-${index}`;
      await tx.productAsset.create({ data: { id: assetId, sku: `${id}-sku-${index}`, name: 'Synthetic manual standalone fabric',
        mainCategory: 'fabric', subCategoryId: 'synthetic', season: 'synthetic', status: 'active', source: 'manual', updatedAt: now } });
      await tx.fabricProfile.create({ data: { id: `${assetId}-profile`, productAssetId: assetId, millOrganizationId: factoryId, updatedAt: now } });
      await tx.orderLine.create({ data: { id: lineIds[index], orderId, lineNumber: index + 1, itemNo: `00${index + 1}0`,
        materialCode: `${id}-sku-${index}`, description: 'Synthetic neutral QC physical line', quantity: qty, unit: 'M',
        unitPrice: '1', netValue: qty, width: '147CM', confirmedSourceType: 'Asset', confirmedSourceId: assetId,
        specSnapshot: { mainCategory: 'fabric', productAssetId: assetId, width: '147CM', factoryRelationId: factoryId } } });
    }
  });
  return { id, ownerId, inspectorId, otherId, customerId, factoryId, orderId, lineIds,
    actorIds: [ownerId, inspectorId, otherId], owner: await current(ownerId), inspector: await current(inspectorId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application() {
  const app = express(), changes: unknown[] = [];
  app.use(express.json()); app.set('json replacer', (_key: string, row: any) => typeof row === 'bigint' ? row.toString() : row);
  app.use(createAccountStatusGuard(db())); app.use(createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/qc', createQcRouter({ prisma: db(), requireAuth: true, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v1/production', createProductionRouter({ prisma: db(), requireAuth: true, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v2/production', createProductionV2Router({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
  app.use('/api/v1/production-batches', createProductionBatchRouter({ prisma: db(), requireAuth: true, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  return { app, changes };
}
type App = ReturnType<typeof application>;
function http(app: App, method: 'get' | 'post' | 'put', endpoint: string, actor: TokenPayload) {
  return request(app.app)[method](endpoint).set('Authorization', `Bearer ${auth.signToken(actor)}`);
}
async function selectedScope(item: Fixture, app: App, batchId: string | null = null) {
  const response = await http(app, 'get', `/api/v1/qc/orders/${item.orderId}/inspection-scopes`, item.owner);
  expect(response.status, diagnostic(response.body)).toBe(200);
  const scope = response.body.scopes.find((row: any) => (row.productionBatchId ?? null) === batchId);
  expect(scope).toBeTruthy(); expect(scope.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/); return scope;
}
async function nativeReport(item: Fixture, app: App, options: { batchId?: string; result?: 'pass' | 'fail'; decide?: boolean; sign?: boolean } = {}) {
  const scope = await selectedScope(item, app, options.batchId ?? null), result = options.result ?? 'pass';
  const create = await http(app, 'post', '/api/v1/qc/assignments', item.owner).send({ orderId: item.orderId,
    qcUserId: item.inspectorId, inspectionType: 'final', scopeType: scope.scopeType,
    ...(scope.productionBatchId ? { productionBatchId: scope.productionBatchId, expectedBatchRevision: scope.productionBatchRevision } : {}),
    expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID() });
  expect(create.status, diagnostic(create.body)).toBe(201); const assignmentId = create.body.item.id;
  expect((await http(app, 'post', `/api/v1/qc/assignments/${assignmentId}/start`, item.inspector)).status).toBe(200);
  const complete = await http(app, 'post', `/api/v1/qc/assignments/${assignmentId}/complete`, item.inspector).send({
    expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID(), report: { result, inspectionDate: '2026-10-02',
      totalUnits: 40, passedUnits: result === 'pass' ? 40 : 0, criticalDefects: result === 'pass' ? 0 : 1, majorDefects: 0, minorDefects: 0 } });
  expect(complete.status, diagnostic(complete.body)).toBe(200); expect(complete.body.report.approvedByBusiness).toBe(false);
  const id = complete.body.report.id as string;
  if (options.sign) {
    const sign = await http(app, 'post', `/api/v1/qc/reports/${id}/sign`, item.inspector).send({ role: 'qc' });
    expect(sign.status, diagnostic(sign.body)).toBe(200);
  }
  if (options.decide) {
    const row = await db().inspectionReport.findUniqueOrThrow({ where: { id } });
    const decide = await http(app, 'post', `/api/v1/qc/reports/${id}/business-decision`, item.owner).send({
      expectedRevision: row.revision, expectedScopeFingerprint: row.scopeFingerprint, expectedContentFingerprint: row.contentFingerprint,
      decision: 'approved', requestKey: randomUUID(), reason: 'Synthetic current consumer verification; no external production/shipment instruction' });
    expect(decide.status, diagnostic(decide.body)).toBe(200); expect(decide.body.item.businessApprover).toBe(item.ownerId);
  }
  return db().inspectionReport.findUniqueOrThrow({ where: { id } });
}
async function nativeBatch(item: Fixture, app: App, lineIndex = 0) {
  const endpoint = `/api/v1/production-batches/orders/${item.orderId}/lines/${item.lineIds[lineIndex]}`;
  const list = await http(app, 'get', endpoint, item.owner);
  expect(list.status, diagnostic(list.body)).toBe(200); expect(list.body.lineFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const created = await http(app, 'post', endpoint, item.owner).send({ batchCode: `${item.id}-${lineIndex}`,
    quantity: lineIndex === 0 ? '40' : '60', unit: 'M', expectedLineFingerprint: list.body.lineFingerprint, requestKey: randomUUID() });
  expect(created.status, diagnostic(created.body)).toBe(201); expect(created.body.batch.orderLineId).toBe(item.lineIds[lineIndex]);
  expect(created.body.batch.state).toBe('active'); return created.body.batch;
}
async function consumers(item: Fixture, app: App) {
  const selected: any[] = [];
  for (const version of ['v1', 'v2']) {
    const response = await http(app, 'get', `/api/${version}/production/${item.orderId}`, item.owner);
    expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.ok).toBe(true);
    selected.push(version === 'v1' ? response.body.inspection : response.body.pipeline.inspection);
  }
  const eligibility = await http(app, 'get', `/api/v1/qc/orders/${item.orderId}/shipment-eligibility`, item.owner);
  expect(eligibility.status, diagnostic(eligibility.body)).toBe(200); expect(eligibility.body.applicable).toBe(true);
  return { selected, bulkQc: eligibility.body.conditions.bulkQc, fullFabric: eligibility.body };
}
async function prepareStageQc(item: Fixture, app: App) {
  // Native initializer owns order_placed=done. No direct done/approval insert.
  await initProductionStages(db(), item.orderId);
  const checklist = await http(app, 'put', `/api/v1/production/${item.orderId}/checklist`, item.owner).send({
    gradingConfirmed: true, consumptionConfirmed: true, patternConfirmed: true, preProductionMeeting: true,
    meetingNote: 'Synthetic software state only; not a real pre-production meeting' });
  expect(checklist.status, diagnostic(checklist.body)).toBe(200);
  const sign = await http(app, 'post', `/api/v1/production/${item.orderId}/sign/pp_sample_approved`, item.owner).send({ signType: 'business' });
  expect(sign.status, diagnostic(sign.body)).toBe(200);
  for (const stage of PRODUCTION_STAGES.filter(row => row.seq > 1 && row.seq < 10)) {
    const response = await http(app, 'post', `/api/v1/production/${item.orderId}/advance/${stage.key}`, item.owner).send({ note: 'Synthetic software stage control; no factory dispatch' });
    expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.stage.status).toBe('done');
  }
}
async function facts(item: Fixture) {
  const scopes = await db().releaseScope.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }), scopeIds = scopes.map(row => row.id);
  return { reports: await db().inspectionReport.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    tasks: await db().qCAssignment.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    widths: await db().inspectionWidthMeasurement.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { in: item.actorIds } }, orderBy: { id: 'asc' } }),
    batches: await db().productionBatch.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    stages: await db().productionStage.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    scopes, releases: await db().ppSampleRelease.findMany({ where: { scopeId: { in: scopeIds } }, orderBy: { id: 'asc' } }),
    stocks: await db().stockMovement.findMany({ where: { referenceType: 'Order', referenceId: item.orderId }, orderBy: { id: 'asc' } }) };
}
async function blockedStage(item: Fixture, app: App) {
  await prepareStageQc(item, app); const before = await facts(item);
  const response = await http(app, 'post', `/api/v1/production/${item.orderId}/advance/qc_shipped`, item.owner).send({ note: 'QC-negative control, must not advance' });
  expect(response.status, diagnostic(response.body)).toBe(400);
  expect(['INSPECTION_NOT_QUALIFIED', 'BUSINESS_APPROVAL_REQUIRED']).toContain(code(response));
  expect(await facts(item)).toEqual(before);
}

describe('Native current whole-report consumers and legacy production mutation boundary', () => {
  it('LC01 current exact whole approved report is consumed by both pipeline versions, bulkQc and actual qc_shipped', async () => {
    const item = await fixture('whole-pass'), app = application(), report = await nativeReport(item, app, { sign: true, decide: true });
    const view = await consumers(item, app);
    expect(view.selected.map(row => row.id)).toEqual([report.id, report.id]); expect(view.bulkQc.satisfied).toBe(true);
    expect(view.fullFabric.conditions.ss.satisfied).toBe(false); expect(view.fullFabric.eligible).toBe(false);
    await prepareStageQc(item, app);
    const advance = await http(app, 'post', `/api/v1/production/${item.orderId}/advance/qc_shipped`, item.owner).send({ note: 'Synthetic QC stage proof only; no shipment executed' });
    expect(advance.status, diagnostic(advance.body)).toBe(200); expect(advance.body.stage.status).toBe('done');
    expect(await db().auditLog.count({ where: { actorId: item.ownerId, action: 'advance_production_stage', targetId: advance.body.stage.id } })).toBe(1);
    expect((await facts(item)).stocks).toEqual([]);
  });
  it('LC02 latest failed whole reinspection blocks an older native signed approved pass without rewriting history', async () => {
    const item = await fixture('latest-fail'), app = application(), original = await nativeReport(item, app, { sign: true, decide: true });
    const oldAudits = await db().auditLog.findMany({ where: { targetId: original.id }, orderBy: { id: 'asc' } });
    const latest = await nativeReport(item, app, { result: 'fail' });
    expect(latest.supersedesId).toBe(original.id); expect(latest.revision).toBe(original.revision + 1);
    const view = await consumers(item, app); expect(view.selected.map(row => row.id)).toEqual([latest.id, latest.id]); expect(view.bulkQc.satisfied).toBe(false);
    await blockedStage(item, app);
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await db().auditLog.findMany({ where: { targetId: original.id }, orderBy: { id: 'asc' } })).toEqual(oldAudits);
  });
  it('LC03 latest unapproved whole pass cannot borrow an older actual business decision', async () => {
    const item = await fixture('latest-unapproved'), app = application(), original = await nativeReport(item, app, { sign: true, decide: true });
    const latest = await nativeReport(item, app); expect(latest.approvedByBusiness).toBe(false);
    const view = await consumers(item, app); expect(view.selected.map(row => row.id)).toEqual([latest.id, latest.id]); expect(view.bulkQc.satisfied).toBe(false);
    await blockedStage(item, app); expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });
  it('LC04 independently approved native A and B batch reports do not masquerade as a whole-order final', async () => {
    const item = await fixture('batch-only'), app = application(), a = await nativeBatch(item, app), b = await nativeBatch(item, app, 1);
    await nativeReport(item, app, { batchId: a.id, decide: true });
    expect((await consumers(item, app)).selected).toEqual([null, null]); expect((await consumers(item, app)).bulkQc.satisfied).toBe(false);
    await nativeReport(item, app, { batchId: b.id, decide: true });
    const view = await consumers(item, app); expect(view.selected).toEqual([null, null]); expect(view.bulkQc.satisfied).toBe(false);
    await blockedStage(item, app);
  });
  it('LC05 native new Batch changes the whole coverage basis and preserves the old decided report instead of widening it', async () => {
    const item = await fixture('changed-whole'), app = application(), original = await nativeReport(item, app, { sign: true, decide: true });
    expect((await consumers(item, app)).bulkQc.satisfied).toBe(true); await nativeBatch(item, app);
    const view = await consumers(item, app); expect(view.selected).toEqual([null, null]); expect(view.bulkQc.satisfied).toBe(false);
    expect((await selectedScope(item, app)).scopeFingerprint).not.toBe(original.scopeFingerprint);
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original); await blockedStage(item, app);
  });
  it('LC06 an actual unapproved legacy null-coverage whole row remains readable but cannot cover a native new Batch', async () => {
    const item = await fixture('legacy-null'), app = application();
    const write = await http(app, 'put', `/api/v1/production/${item.orderId}/inspection`, item.inspector).send({
      inspectionType: 'final', result: 'pass', totalUnits: 40, passedUnits: 40, criticalDefects: 0, majorDefects: 0, minorDefects: 0 });
    expect(write.status, diagnostic(write.body)).toBe(200); const original = await db().inspectionReport.findUniqueOrThrow({ where: { id: write.body.inspection.id } });
    expect(original.scopeFingerprint).toBeNull(); expect(original.scopeSnapshot).toBeNull(); expect(original.approvedByBusiness).toBe(false);
    expect((await consumers(item, app)).selected.map(row => row.id)).toEqual([original.id, original.id]);
    expect((await consumers(item, app)).bulkQc.satisfied).toBe(false); await nativeBatch(item, app);
    const view = await consumers(item, app); expect(view.selected).toEqual([null, null]); expect(view.bulkQc.satisfied).toBe(false);
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original); await blockedStage(item, app);
  });
  it.each(['v1', 'v2'] as const)('LC07 %s legacy PUT cannot upsert over a native signed approved first whole revision', async version => {
    const item = await fixture(`overwrite-${version}`), app = application(), original = await nativeReport(item, app, { sign: true, decide: true });
    expect((original.signatures as any).qcSignerId).toBe(item.inspectorId); expect(original.revision).toBe(1);
    const before = await facts(item); app.changes.length = 0;
    const response = await http(app, 'put', `/api/${version}/production/${item.orderId}/inspection`, item.inspector).send({
      inspectionType: 'final', result: 'pass', totalUnits: 40, passedUnits: 40, criticalDefects: 0,
      notes: 'Different contents cannot inherit the original approval or signature' });
    expect(response.status, diagnostic(response.body)).toBe(409); expect(code(response)).toBe('CONFLICT');
    expect(await facts(item)).toEqual(before); expect(app.changes).toEqual([]);
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });
  it.each(['v1', 'v2'] as const)('LC08 %s legacy PUT cannot impersonate a different existing inspector from body fields', async version => {
    const item = await fixture(`inspector-body-${version}`), app = application(), before = await facts(item);
    const response = await http(app, 'put', `/api/${version}/production/${item.orderId}/inspection`, item.inspector).send({
      inspectionType: 'final', result: 'pass', totalUnits: 40, passedUnits: 40, criticalDefects: 0, inspectedBy: item.otherId });
    expect(response.status, diagnostic(response.body)).toBe(400); expect(code(response)).toBe('VALIDATION_FAILED');
    expect(await facts(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it.each(['v1', 'v2'] as const)('LC09 %s production scope and a body business approver cannot replace the actual native business decision', async version => {
    const item = await fixture(`approval-body-${version}`), app = application(), before = await facts(item);
    const response = await http(app, 'put', `/api/${version}/production/${item.orderId}/inspection`, item.inspector).send({
      inspectionType: 'final', result: 'pass', totalUnits: 40, passedUnits: 40, criticalDefects: 0,
      approvedByBusiness: true, businessApprover: item.ownerId });
    expect(response.status, diagnostic(response.body)).toBe(400); expect(code(response)).toBe('VALIDATION_FAILED');
    expect(await facts(item)).toEqual(before); expect(app.changes).toEqual([]);
  });
});
