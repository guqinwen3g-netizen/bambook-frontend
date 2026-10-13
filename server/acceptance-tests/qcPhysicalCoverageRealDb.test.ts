/** Private PG + actual signed QC routes. Independent bounded business contract:
 * docs/V1实际批次与验货交接契约-2026-10-02.md, QC coverage/revision clauses.
 * INITIAL synthetic Pending Order/Line, manual standalone Asset and neutral
 * ProductionBatch identities isolate QC. Their existence/ranges do NOT prove
 * native Batch creation, sample/PP approval, manufacturing, inventory or shipping.
 * Every task, completion/report, signature and business decision below must
 * come from the real routes. No approved report or signature is seeded.
 * Source-drift controls deliberately change INITIAL physical/source inputs;
 * the split projection fault is NOT claimed as a native Batch split journey.
 * Physical PG identity is checked before any fixture write. Root alone runs
 * this opt-in manifest in the isolated cluster; no shared DB/external action.
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
import { createQcRouter } from '../src/qc/qcRoute';
import { productionBatchSourceFingerprint } from '../src/production/productionBatchService';
import { assessInspectionRelease } from '../src/production/stageService';

const prefix = `acceptance-qc-physical-${randomUUID()}`, auth = createAuthService(), grantor = `${prefix}-grantor`;
let prisma: PrismaClient | undefined, sequence = 0;
const db = (): PrismaClient => { if (!prisma) throw Error('Private physical-QC PG identity not verified'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const code = (response: any) => response.body.error?.code ?? response.body.error;

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: grantor, displayName: 'Synthetic QC technical grantor', status: 'active' } });
});
afterAll(async () => { await prisma?.$disconnect(); });

async function current(userId: string) {
  const user = await loadUserWithRoles(db(), userId); expect(user?.status).toBe('active');
  const actor = await buildLoadedAuthTokenPayload(db(), user); expect(actor.authorizationLoaded).toBe(true);
  return { ...actor, permissionCeiling: ['qc:read', 'qc:write', 'orders:read'] } as TokenPayload;
}
async function fixture(label: string) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), ownerId = `${id}-owner`,
    inspectorAId = `${id}-qc-a`, inspectorBId = `${id}-qc-b`, otherId = `${id}-other`, headId = `${id}-head`,
    customerId = `${id}-customer`, factoryId = `${id}-factory`, otherFactoryId = `${id}-other-factory`,
    orderId = `${id}-order`, departmentId = `${id}-department`, teamId = `${id}-team`, shareId = `${id}-share`,
    lineAId = `${id}-line-a`, lineBId = `${id}-line-b`, batchAId = `${id}-batch-a`, batchBId = `${id}-batch-b`;
  const actorIds = [ownerId, inspectorAId, inspectorBId, otherId, headId];
  await db().$transaction(async tx => {
    for (const userId of actorIds) {
      await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic current QC participant', status: 'active' } });
      // Misleading display names are intentional: no canonical owner/admin
      // identity is assigned. Business authority comes from actual parent facts.
      const roleId = `${userId}-custom-role`;
      await tx.role.create({ data: { id: roleId, name: userId === otherId ? 'owner' : 'admin', isSystem: false } });
      await tx.userRole.create({ data: { id: `${userId}-assignment`, userId, roleId } });
      await tx.userPermissionOverrides.createMany({ data: ['qc:read', 'qc:write', 'orders:read'].map(scope => ({
        id: `${userId}-${scope}`, userId, scope, isActive: true, grantedBy: grantor,
        reason: 'Explicit private technical capability; not company role-policy UAT' })) });
    }
    await tx.department.create({ data: { id: departmentId, name: 'Synthetic actual QC business department', status: 'active', headId } });
    for (const [relationId, category] of [[customerId, 'Customer'], [factoryId, 'Supplier'], [otherFactoryId, 'Supplier']] as const) {
      await tx.relation.create({ data: { id: relationId, name: relationId, category, type: 'Company', isOrganization: true,
        tags: [], contactInfo: '{}', lastInteraction: now, ownerId, salesRepIds: relationId === customerId ? [headId] : [] } });
    }
    await tx.order.create({ data: { id: orderId, poNumber: `${id}-PO`, customer: customerId, customerRelationId: customerId,
      ownerId, departmentId, millRelationId: factoryId, product: 'Synthetic physical QC ranges', type: 'Fabric',
      quantity: 100, quoteAmount: '100', status: 'Pending', dueDate: '2099-01-01', updatedAt: now } });
    for (const [lineId, batchId, suffix, amount] of [[lineAId, batchAId, 'A', '40'], [lineBId, batchBId, 'B', '60']] as const) {
      const assetId = `${id}-asset-${suffix}`, specification = { materialCode: `SYNTHETIC-${suffix}`, width: '147CM', factoryRelationId: factoryId };
      await tx.productAsset.create({ data: { id: assetId, sku: `${id}-sku-${suffix}`, name: `Synthetic standalone input ${suffix}`,
        mainCategory: 'fabric', subCategoryId: 'synthetic', season: 'synthetic', status: 'active', source: 'manual', updatedAt: now } });
      await tx.fabricProfile.create({ data: { id: `${assetId}-profile`, productAssetId: assetId, millOrganizationId: factoryId, updatedAt: now } });
      const line = await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: suffix === 'A' ? 1 : 2,
        itemNo: suffix === 'A' ? '0010' : '0020', materialCode: `SYNTHETIC-${suffix}`, description: `Synthetic physical input ${suffix}`,
        quantity: amount, unit: 'M', width: '147CM', unitPrice: '1', netValue: amount,
        confirmedSourceType: 'Asset', confirmedSourceId: assetId, specSnapshot: specification } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      // Only the actual exported neutral identity recipe supplies the digest.
      // This INITIAL insert does not substitute for testing Batch API creation.
      const sourceFingerprint = productionBatchSourceFingerprint(order, line, factoryId);
      expect(sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      await tx.productionBatch.create({ data: { id: batchId, batchCode: `${id}-${suffix}`, orderId, orderLineId: lineId,
        factoryRelationId: factoryId, rangeStart: '0', quantity: amount, unit: 'M', revision: 1, state: 'active',
        confirmedSourceType: 'Asset', confirmedSourceId: assetId, specSnapshot: specification, sourceFingerprint,
        requestKey: `initial-${suffix}`, parameterHash: sourceFingerprint,
        commandSnapshot: { fixtureLayer: 'INITIAL synthetic neutral physical identity; not native producer evidence' },
        createdBy: ownerId, createdAt: now, updatedAt: now } });
    }
    await tx.team.create({ data: { id: teamId, name: 'Synthetic explicit business share', status: 'active' } });
    await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId: otherId } });
    await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
      permission: 'read+followup', grantedBy: ownerId } });
  });
  return { id, actorIds, ownerId, inspectorAId, inspectorBId, otherId, headId, orderId, customerId, departmentId,
    factoryId, otherFactoryId, teamId, shareId, lineAId, lineBId, batchAId, batchBId,
    owner: await current(ownerId), inspectorA: await current(inspectorAId), inspectorB: await current(inspectorBId),
    other: await current(otherId), head: await current(headId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function application(client = db()) {
  const app = express(), changes: unknown[] = [];
  app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(client)); app.use(createAuthorizationSnapshotGuard({ prisma: client, apiKeys: new Set() }));
  app.use('/qc', createQcRouter({ prisma: client, requireAuth: true, apiKeys: new Set(), onDataChange: value => changes.push(value) }));
  return { app, changes };
}
type App = ReturnType<typeof application>;
function http(app: App, method: 'get' | 'post', endpoint: string, actor: TokenPayload) {
  return request(app.app)[method](endpoint).set('Authorization', `Bearer ${auth.signToken(actor)}`);
}
async function scopes(item: Fixture, app = application(), actor = item.owner) {
  const response = await http(app, 'get', `/qc/orders/${item.orderId}/inspection-scopes`, actor);
  expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.ok).toBe(true);
  expect(Array.isArray(response.body.scopes)).toBe(true); return response.body.scopes as any[];
}
async function scope(item: Fixture, batchId: string | null, app = application()) {
  const found = (await scopes(item, app)).find(row => row.scopeType === (batchId ? 'production_batch' : 'whole_order')
    && (row.productionBatchId ?? null) === batchId);
  expect(found, 'scope must come from actual signed API').toBeTruthy(); expect(found.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/); return found;
}
function createBody(item: Fixture, coverage: any, qcUserId = item.inspectorAId) {
  return { orderId: item.orderId, inspectionType: 'final', qcUserId, dueDate: '2099-01-01',
    scopeType: coverage.scopeType, ...(coverage.productionBatchId ? { productionBatchId: coverage.productionBatchId,
      expectedBatchRevision: coverage.productionBatchRevision } : {}), expectedScopeFingerprint: coverage.scopeFingerprint, requestKey: randomUUID() };
}
async function assigned(item: Fixture, batchId: string | null = item.batchAId, qcUserId = item.inspectorAId, app = application()) {
  const coverage = await scope(item, batchId, app), body = createBody(item, coverage, qcUserId);
  const response = await http(app, 'post', '/qc/assignments', item.owner).send(body);
  expect(response.status, diagnostic(response.body)).toBe(201); expect(response.body.ok).toBe(true);
  expect(response.body.item).toMatchObject({ orderId: item.orderId, scopeType: batchId ? 'production_batch' : 'whole_order', productionBatchId: batchId,
    productionBatchRevision: coverage.productionBatchRevision, scopeFingerprint: coverage.scopeFingerprint, qcUserId, assignedById: item.ownerId });
  expect(response.body.item.requestKey).toBe(body.requestKey); expect(response.body.item.commandHash).toMatch(/^[a-f0-9]{64}$/);
  return { app, coverage, body, id: response.body.item.id as string };
}
type Task = Awaited<ReturnType<typeof assigned>>;
function reportBody(item: Fixture, task: Task, result: 'pass' | 'fail' = 'pass') {
  const a = task.coverage.productionBatchId === item.batchAId, count = a ? 10 : 12;
  return { requestKey: randomUUID(), expectedScopeFingerprint: task.coverage.scopeFingerprint, report: {
    result, inspectionDate: '2026-10-02', totalUnits: count, passedUnits: result === 'pass' ? count : 0,
    criticalDefects: result === 'fail' ? 1 : 0, majorDefects: 0, minorDefects: 0, sampleSize: count, lotSize: count,
    widthMeasurements: [{ orderLineId: a ? item.lineAId : item.lineBId, measuredWidthCm: 147, basisWidthCm: 147 }] } };
}
async function started(item: Fixture, task: Task, actor = item.inspectorA) {
  const response = await http(task.app, 'post', `/qc/assignments/${task.id}/start`, actor);
  expect(response.status, diagnostic(response.body)).toBe(200); return task;
}
async function completed(item: Fixture, task: Task, actor = item.inspectorA, result: 'pass' | 'fail' = 'pass') {
  await started(item, task, actor); const body = reportBody(item, task, result);
  const response = await http(task.app, 'post', `/qc/assignments/${task.id}/complete`, actor).send(body);
  expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.ok).toBe(true);
  expect(response.body.item).toMatchObject({ id: task.id, status: 'Completed', reportId: response.body.report?.id });
  expect(response.body.report).toMatchObject({ orderId: item.orderId, productionBatchId: task.coverage.productionBatchId,
    scopeFingerprint: task.coverage.scopeFingerprint, inspectedBy: actor.userId, approvedByBusiness: false, result });
  expect(response.body.report.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const actual = await db().inspectionReport.findUniqueOrThrow({ where: { id: response.body.report.id } });
  expect(actual.requestKey).toBe(body.requestKey); expect(actual.commandHash).toMatch(/^[a-f0-9]{64}$/);
  return { task, body, response, report: actual };
}
type Observation = Awaited<ReturnType<typeof completed>>;
function decisionBody(observation: Observation, decision: 'approved' | 'rejected' = 'approved') {
  return { expectedRevision: observation.report.revision, expectedScopeFingerprint: observation.report.scopeFingerprint,
    expectedContentFingerprint: observation.report.contentFingerprint, decision, requestKey: randomUUID(),
    reason: 'Synthetic software business decision; no physical shipping or factory instruction' };
}
async function approved(item: Fixture, observation: Observation, actor = item.owner) {
  const body = decisionBody(observation), response = await http(observation.task.app, 'post',
    `/qc/reports/${observation.report.id}/business-decision`, actor).send(body);
  expect(response.status, diagnostic(response.body)).toBe(200); expect(response.body.ok).toBe(true);
  expect(response.body.item).toMatchObject({ id: observation.report.id, approvedByBusiness: true, businessApprover: actor.userId });
  const actual = await db().inspectionReport.findUniqueOrThrow({ where: { id: observation.report.id } });
  expect(actual.approvedAt).not.toBeNull(); return { body, response, report: actual };
}
async function snapshot(item: Fixture) {
  const scopes = await db().releaseScope.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } });
  const scopeIds = scopes.map(row => row.id);
  return { tasks: await db().qCAssignment.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    reports: await db().inspectionReport.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    widths: await db().inspectionWidthMeasurement.findMany({ where: { orderId: item.orderId }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: { in: item.actorIds } }, orderBy: { id: 'asc' } }),
    releaseScopes: scopes,
    releases: await db().ppSampleRelease.findMany({ where: { scopeId: { in: scopeIds } }, orderBy: { id: 'asc' } }),
    releaseEvents: await db().releaseEvent.findMany({ where: { scopeId: { in: scopeIds } }, orderBy: { id: 'asc' } }),
    stocks: await db().stockMovement.findMany({ where: { referenceType: 'Order', referenceId: item.orderId }, orderBy: { id: 'asc' } }) };
}
async function unchanged(item: Fixture, before: Awaited<ReturnType<typeof snapshot>>, app: App) {
  expect(await snapshot(item), 'deny/replay cannot append success history or change QC/PP/stock facts').toEqual(before);
  expect(app.changes).toEqual([]);
}
async function noProductionFacts(item: Fixture) {
  const actual = await snapshot(item); expect(actual.releaseScopes).toEqual([]); expect(actual.releases).toEqual([]);
  expect(actual.releaseEvents).toEqual([]); expect(actual.stocks).toEqual([]);
}

type AuditProbe = { mode: 'complete' | 'decision'; reached?: boolean; actualCode?: string };
function auditFailure(item: Fixture, probe: AuditProbe): PrismaClient {
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return (work: any, options?: any) => {
      if (typeof work !== 'function') return (client.$transaction as any)(work, options);
      return client.$transaction(async tx => work(new Proxy(tx, { get(transaction, name) {
        if (name === 'auditLog') return new Proxy(transaction.auditLog, { get(model, method) {
          if (method === 'create') return async (args: any) => {
            const operation = probe.mode === 'complete' ? 'complete_scoped_assignment' : 'decide_scoped_report';
            if (args.data.action !== operation) return model.create(args);
            const staged = await tx.inspectionReport.findMany({ where: { orderId: item.orderId } });
            expect(staged).toHaveLength(1);
            expect(staged[0].approvedByBusiness, 'positive control: requested business fact staged before failing mandatory audit')
              .toBe(probe.mode === 'decision');
            if (probe.mode === 'complete') {
              expect(await tx.qCAssignment.findFirst({ where: { orderId: item.orderId, status: 'Completed', reportId: staged[0].id } })).not.toBeNull();
              expect(await tx.inspectionWidthMeasurement.count({ where: { reportId: staged[0].id } })).toBe(1);
            }
            probe.reached = true;
            try { return await model.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-audit-actor` } }); }
            catch (error) { expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError); probe.actualCode = (error as Prisma.PrismaClientKnownRequestError).code; throw error; }
          };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = Reflect.get(transaction, name); return typeof value === 'function' ? value.bind(transaction) : value;
      } })), { ...options, timeout: 20_000 });
    };
    const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value;
  } });
}

describe('QC physical scope/revision native routes, actual isolated PostgreSQL', () => {
  it('QPC01 signed scope selection exposes whole order plus two exact neutral ranges without manufacturing approval', async () => {
    const item = await fixture('scopes'), rows = await scopes(item);
    expect(rows).toHaveLength(3); expect(rows.filter(row => row.scopeType === 'whole_order')).toHaveLength(1);
    for (const [batchId, lineId, amount] of [[item.batchAId, item.lineAId, '40'], [item.batchBId, item.lineBId, '60']] as const) {
      const row = rows.find(value => value.productionBatchId === batchId);
      expect(row).toMatchObject({ scopeType: 'production_batch', productionBatchRevision: 1, factoryRelationId: item.factoryId });
      expect(row.scopeSnapshot.batch).toMatchObject({ id: batchId, quantity: amount, unit: 'M' });
      expect(row.scopeSnapshot.lines.map((line: any) => line.orderLineId)).toEqual([lineId]);
    }
    expect((await snapshot(item)).tasks).toEqual([]); expect((await snapshot(item)).reports).toEqual([]);
    const whole = await completed(item, await assigned(item, null));
    expect(whole.report.scopeType).toBe('whole_order'); expect(whole.report.productionBatchId).toBeNull();
    expect((whole.report.scopeSnapshot as any).lines.map((line: any) => line.orderLineId)).toEqual([item.lineAId, item.lineBId]);
    const decision = await approved(item, whole);
    expect(assessInspectionRelease(decision.report).qualified).toBe(true);
    const oldReport = await db().inspectionReport.findUniqueOrThrow({ where: { id: whole.report.id } });
    // A controlled revision change in INITIAL physical inputs is not a native
    // split claim. The old whole-order snapshot cannot cover a new revision.
    await db().productionBatch.update({ where: { id: item.batchAId }, data: { revision: 2 } });
    const currentWhole = await scope(item, null);
    expect(currentWhole.scopeFingerprint).not.toBe(oldReport.scopeFingerprint);
    expect(currentWhole.scopeSnapshot.batches.find((batch: any) => batch.id === item.batchAId).revision).toBe(2);
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: oldReport.id } })).toEqual(oldReport);
    await noProductionFacts(item);
  });
  it('QPC02 A pass and B fail have independent reports, counts and assigned-only read contexts; A approval never approves B', async () => {
    const item = await fixture('a-b'), a = await assigned(item), b = await assigned(item, item.batchBId, item.inspectorBId);
    const rb = await completed(item, b, item.inspectorB, 'fail');
    // A is still pending: task authorization must include scope before count,
    // not open every report sharing the Order/final inspection type.
    const pendingList = await http(a.app, 'get', `/qc/reports?orderId=${item.orderId}`, item.inspectorA);
    expect(pendingList.status).toBe(200); expect(pendingList.body.total).toBe(0); expect(pendingList.body.items).toEqual([]);
    expect((await http(a.app, 'get', `/qc/reports/${rb.report.id}`, item.inspectorA)).status).toBe(404);
    const ra = await completed(item, a);
    expect(ra.report.id).not.toBe(rb.report.id); expect(ra.report.totalUnits).toBe(10); expect(rb.report.totalUnits).toBe(12);
    const context = await http(a.app, 'get', `/qc/assignments/${a.id}/inspection-context`, item.inspectorA);
    expect(context.status).toBe(200); expect(context.body.assignment.productionBatchId).toBe(item.batchAId);
    expect(context.body.lines.map((line: any) => line.id)).toEqual([item.lineAId]);
    expect(diagnostic(context.body)).not.toMatch(/unitPrice|netValue|quoteAmount/);
    const list = await http(a.app, 'get', `/qc/reports?orderId=${item.orderId}`, item.inspectorA);
    expect(list.status).toBe(200); expect(list.body.total).toBe(1); expect(list.body.items.map((row: any) => row.id)).toEqual([ra.report.id]);
    expect((await http(a.app, 'get', `/qc/reports/${rb.report.id}`, item.inspectorA)).status).toBe(404);
    expect(assessInspectionRelease(ra.report).qualified).toBe(false);
    const decisionA = await approved(item, ra);
    expect(assessInspectionRelease(decisionA.report).qualified).toBe(true);
    expect(assessInspectionRelease(rb.report).qualified).toBe(false);
    expect((await db().inspectionReport.findUniqueOrThrow({ where: { id: rb.report.id } })).approvedByBusiness).toBe(false);
    // This consumes the actual reports through the existing quality predicate,
    // not a current-scoped Shipment selector or an executed Shipment, fabric
    // S/S/RC gate, stock or PP release. Their consumer slice is still separate.
    await noProductionFacts(item);
  });
  it('QPC03 native reinspection creates a new id/revision and supersedes pointer while preserving the old approved/signed report and audits', async () => {
    const item = await fixture('reinspection'), first = await completed(item, await assigned(item));
    const signed = await http(first.task.app, 'post', `/qc/reports/${first.report.id}/sign`, item.inspectorA).send({ role: 'qc' });
    expect(signed.status, diagnostic(signed.body)).toBe(200); await approved(item, first);
    const old = await db().inspectionReport.findUniqueOrThrow({ where: { id: first.report.id } });
    expect((old.signatures as any).qcSignerId).toBe(item.inspectorAId);
    const oldAudits = await db().auditLog.findMany({ where: { targetId: old.id }, orderBy: { id: 'asc' } }); expect(oldAudits.length).toBeGreaterThan(0);
    const second = await completed(item, await assigned(item));
    expect(second.report.id).not.toBe(old.id); expect(second.report.revision).toBe(old.revision + 1); expect(second.report.supersedesId).toBe(old.id);
    expect(second.report.approvedByBusiness).toBe(false); expect(second.report.approvedAt).toBeNull();
    expect((second.report.signatures as any)?.qcSignerId).toBeUndefined();
    expect(await db().inspectionReport.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await db().auditLog.findMany({ where: { targetId: old.id }, orderBy: { id: 'asc' } })).toEqual(oldAudits);
    const reports = await http(second.task.app, 'get', `/qc/orders/${item.orderId}/reports`, item.owner);
    expect(reports.status).toBe(200); expect(reports.body.items.map((row: any) => row.id)).toEqual(expect.arrayContaining([old.id, second.report.id]));
    expect(assessInspectionRelease(second.report).qualified).toBe(false);
    await noProductionFacts(item);
  });
  it.each(['quantity', 'specification', 'factory', 'split'] as const)('QPC04-07 current %s drift rejects the old completion range with 409 and zero report/audit increment', async variant => {
    const item = await fixture(`drift-${variant}`), task = await started(item, await assigned(item)), body = reportBody(item, task);
    // Controlled mutation of the explicitly INITIAL source/range inputs, not
    // a seeded approval or a claim of native Order/Batch edit/split coverage.
    if (variant === 'quantity') await db().orderLine.update({ where: { id: item.lineAId }, data: { quantity: '39' } });
    if (variant === 'specification') await db().orderLine.update({ where: { id: item.lineAId }, data: { specSnapshot: { materialCode: 'Changed physical specification', width: '140CM' } } });
    if (variant === 'factory') await db().order.update({ where: { id: item.orderId }, data: { millRelationId: item.otherFactoryId } });
    if (variant === 'split') await db().productionBatch.update({ where: { id: item.batchAId }, data: { state: 'split', revision: 2 } });
    const before = await snapshot(item); task.app.changes.length = 0;
    const response = await http(task.app, 'post', `/qc/assignments/${task.id}/complete`, item.inspectorA).send(body);
    expect(response.status, diagnostic(response.body)).toBe(409); expect(code(response)).toBe('CONFLICT'); await unchanged(item, before, task.app);
  });
  it('QPC08 assigned inspector with parent read access cannot business-approve by custom owner name, signed role labels or body role/actor', async () => {
    const item = await fixture('self-role'), observation = await completed(item, await assigned(item));
    await db().relation.update({ where: { id: item.customerId }, data: { salesRepIds: [item.inspectorAId, item.headId] } });
    const before = await snapshot(item); observation.task.app.changes.length = 0;
    for (const actor of [item.inspectorA, { ...item.inspectorA, roles: ['owner', 'admin'] } as TokenPayload, item.other]) {
      const response = await http(observation.task.app, 'post', `/qc/reports/${observation.report.id}/business-decision`, actor)
        .send({ ...decisionBody(observation), actorId: item.ownerId, role: 'owner', approvedByBusiness: true });
      expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN');
    }
    await unchanged(item, before, observation.task.app);
  });
  it('QPC09 actual active department head with parent L2 can decide without owner role labels; inactive head cannot', async () => {
    const item = await fixture('head'), observation = await completed(item, await assigned(item));
    expect(item.head.roles).not.toContain('owner'); await approved(item, observation, item.head);
    const second = await completed(item, await assigned(item)); await db().department.update({ where: { id: item.departmentId }, data: { status: 'inactive' } });
    const before = await snapshot(item); second.task.app.changes.length = 0;
    const denied = await http(second.task.app, 'post', `/qc/reports/${second.report.id}/business-decision`, item.head).send(decisionBody(second));
    expect(denied.status, diagnostic(denied.body)).toBe(403); await unchanged(item, before, second.task.app);
  });
  it('QPC10 current account, explicit signed empty ceiling and revoked qc:write each reject completion without partial report history', async () => {
    for (const variant of ['disabled', 'empty-cap', 'revoked'] as const) {
      const item = await fixture(`authority-${variant}`), task = await started(item, await assigned(item));
      let actor = item.inspectorA;
      if (variant === 'disabled') await db().userAccount.update({ where: { id: item.inspectorAId }, data: { status: 'inactive' } });
      if (variant === 'empty-cap') actor = { ...actor, permissionCeiling: [] };
      if (variant === 'revoked') await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.inspectorAId, scope: 'qc:write' } }, data: { isActive: false } });
      const before = await snapshot(item); task.app.changes.length = 0;
      const response = await http(task.app, 'post', `/qc/assignments/${task.id}/complete`, actor).send(reportBody(item, task));
      expect(response.status, diagnostic(response.body)).toBe(variant === 'disabled' ? 401 : 403); await unchanged(item, before, task.app);
    }
  });
  it('QPC11 removing a real team customer share invalidates scope selection and new dispatch despite a primed prior read', async () => {
    const item = await fixture('share-revoke'), app = application(), coverage = await scope(item, item.batchAId, app);
    expect((await scopes(item, app, item.other)).length).toBe(3);
    await db().teamDataGrant.update({ where: { id: item.shareId }, data: { revokedAt: new Date(), revokedBy: item.ownerId } });
    const before = await snapshot(item); app.changes.length = 0;
    expect((await http(app, 'get', `/qc/orders/${item.orderId}/inspection-scopes`, item.other)).status).toBe(404);
    const denied = await http(app, 'post', '/qc/assignments', item.other).send(createBody(item, coverage));
    expect(denied.status, diagnostic(denied.body)).toBe(404); await unchanged(item, before, app);
  });
  it('QPC12 an exact create retry returns the original task; changed full parameters under that key conflict without another task', async () => {
    const item = await fixture('create-replay'), task = await assigned(item), before = await snapshot(item); task.app.changes.length = 0;
    const replay = await http(task.app, 'post', '/qc/assignments', item.owner).send(task.body);
    expect(replay.status, diagnostic(replay.body)).toBe(201); expect(replay.body.replayed).toBe(true); expect(replay.body.item.id).toBe(task.id);
    expect(await snapshot(item)).toEqual(before);
    const changed = await http(task.app, 'post', '/qc/assignments', item.owner).send({ ...task.body, dueDate: '2099-01-02' });
    expect(changed.status, diagnostic(changed.body)).toBe(409); expect(code(changed)).toBe('CONFLICT');
    expect(await snapshot(item)).toEqual(before);
  });
  it('QPC13 an exact completion retry returns original report/revision; changed counts under that key cannot overwrite it', async () => {
    const item = await fixture('complete-replay'), observation = await completed(item, await assigned(item)), before = await snapshot(item);
    const replay = await http(observation.task.app, 'post', `/qc/assignments/${observation.task.id}/complete`, item.inspectorA).send(observation.body);
    expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.report).toMatchObject({ id: observation.report.id, revision: observation.report.revision, contentFingerprint: observation.report.contentFingerprint });
    expect(await snapshot(item)).toEqual(before);
    const changed = await http(observation.task.app, 'post', `/qc/assignments/${observation.task.id}/complete`, item.inspectorA)
      .send({ ...observation.body, report: { ...observation.body.report, passedUnits: 9 } });
    expect(changed.status, diagnostic(changed.body)).toBe(409); expect(await snapshot(item)).toEqual(before);
  });
  it('QPC14 an exact business decision retry returns original approval; changed reason conflicts and current revoked permission still rejects', async () => {
    const item = await fixture('decision-replay'), observation = await completed(item, await assigned(item)), decision = await approved(item, observation), before = await snapshot(item);
    const endpoint = `/qc/reports/${observation.report.id}/business-decision`;
    const replay = await http(observation.task.app, 'post', endpoint, item.owner).send(decision.body);
    expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.item.id).toBe(observation.report.id); expect(replay.body.item.businessApprover).toBe(item.ownerId);
    expect(await snapshot(item)).toEqual(before);
    expect((await http(observation.task.app, 'post', endpoint, item.owner).send({ ...decision.body, reason: 'Different actual instruction' })).status).toBe(409);
    expect(await snapshot(item)).toEqual(before);
    await db().userPermissionOverrides.update({ where: { userId_scope: { userId: item.ownerId, scope: 'qc:write' } }, data: { isActive: false } });
    expect((await http(observation.task.app, 'post', endpoint, item.owner).send(decision.body)).status).toBe(403);
    expect(await snapshot(item)).toEqual(before);
  });
  it('QPC15 real completion audit P2003 rolls back task/report/revision/widths and allows the same original command to retry', async () => {
    const item = await fixture('complete-audit'), task = await started(item, await assigned(item)), body = reportBody(item, task), before = await snapshot(item);
    const probe: AuditProbe = { mode: 'complete' }, faulty = application(auditFailure(item, probe));
    const response = await http(faulty, 'post', `/qc/assignments/${task.id}/complete`, item.inspectorA).send(body);
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003'); expect(response.status, diagnostic(response.body)).toBe(500);
    expect(diagnostic(response.body)).not.toMatch(/P2003|23503|Foreign key|missing-audit-actor/); await unchanged(item, before, faulty);
    const retry = await http(task.app, 'post', `/qc/assignments/${task.id}/complete`, item.inspectorA).send(body);
    expect(retry.status, diagnostic(retry.body)).toBe(200); expect(retry.body.replayed).toBe(false);
    expect((await snapshot(item)).reports).toHaveLength(1); expect((await snapshot(item)).widths).toHaveLength(1);
    expect(retry.body.report.revision).toBe(1); await noProductionFacts(item);
  });
  it('QPC16 real business-decision audit P2003 rolls back approval and receipt; same request then commits one native decision', async () => {
    const item = await fixture('decision-audit'), observation = await completed(item, await assigned(item)), body = decisionBody(observation), before = await snapshot(item);
    const probe: AuditProbe = { mode: 'decision' }, faulty = application(auditFailure(item, probe)), endpoint = `/qc/reports/${observation.report.id}/business-decision`;
    const response = await http(faulty, 'post', endpoint, item.owner).send(body);
    expect(probe.reached).toBe(true); expect(probe.actualCode).toBe('P2003'); expect(response.status, diagnostic(response.body)).toBe(500);
    expect(diagnostic(response.body)).not.toMatch(/P2003|23503|Foreign key|missing-audit-actor/); await unchanged(item, before, faulty);
    const retry = await http(observation.task.app, 'post', endpoint, item.owner).send(body);
    expect(retry.status, diagnostic(retry.body)).toBe(200); expect(retry.body.replayed).toBe(false);
    const actual = await db().inspectionReport.findUniqueOrThrow({ where: { id: observation.report.id } });
    expect(actual.approvedByBusiness).toBe(true); expect(actual.businessApprover).toBe(item.ownerId);
    expect(await db().auditLog.count({ where: { targetId: observation.report.id, action: 'decide_scoped_report' } })).toBe(1);
    await noProductionFacts(item);
  });
});

const mandatoryModernCounts = ['totalUnits', 'passedUnits', 'criticalDefects', 'majorDefects', 'minorDefects'] as const;
type MandatoryModernCount = typeof mandatoryModernCounts[number];
/** Unknown modern counts are not observations of zero. This deliberately
 * targets only a new scoped completion command, not legacy report semantics.
 * For totalUnits, known passed=0 isolates presence from the separate
 * passed>total arithmetic check; the exact corrected retry records 40/40.
 */
async function rejectsUnknownModernCount(field: MandatoryModernCount, absence: 'omitted' | 'null') {
  const item = await fixture(`required-${field}-${absence}`), task = await started(item, await assigned(item));
  const body = reportBody(item, task);
  body.report.totalUnits = 40; body.report.passedUnits = 40; body.report.lotSize = 40; body.report.sampleSize = 40;
  const malformed: any = JSON.parse(JSON.stringify(body));
  if (field === 'totalUnits') malformed.report.passedUnits = 0;
  if (absence === 'omitted') delete malformed.report[field]; else malformed.report[field] = null;
  const before = await snapshot(item), app = application(), endpoint = `/qc/assignments/${task.id}/complete`;
  const response = await http(app, 'post', endpoint, item.inspectorA).send(malformed);
  expect(response.status, diagnostic({ field, absence, response: response.body })).toBe(400);
  expect(code(response)).toBe('VALIDATION_FAILED'); await unchanged(item, before, app);
  expect(await db().qCAssignment.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'InProgress', reportId: null });
  expect(await db().inspectionReport.count({ where: { orderId: item.orderId } }),
    'unknown critical/other counts cannot create an approvable report or a zero-valued release basis').toBe(0);

  // An uncommitted validation rejection must not burn the stable key. A real
  // corrected observation can retry it and only native business approval
  // makes the existing quality predicate qualify this exact 40/40 report.
  const retry = await http(app, 'post', endpoint, item.inspectorA).send(body);
  expect(retry.status, diagnostic(retry.body)).toBe(200); expect(retry.body.ok).toBe(true); expect(retry.body.replayed).toBe(false);
  const actual = await db().inspectionReport.findUniqueOrThrow({ where: { id: retry.body.report.id } });
  expect(actual).toMatchObject({ requestKey: body.requestKey, result: 'pass', totalUnits: 40, passedUnits: 40,
    criticalDefects: 0, majorDefects: 0, minorDefects: 0, approvedByBusiness: false });
  expect(assessInspectionRelease(actual).qualified).toBe(false);
  const decision = await approved(item, { task, body, response: retry, report: actual });
  expect(assessInspectionRelease(decision.report).qualified).toBe(true);
  expect((await snapshot(item)).reports).toHaveLength(1);
  await noProductionFacts(item);
}

describe('Modern scoped QC completion must record all five counts explicitly', () => {
  it.each(mandatoryModernCounts)('QPC17 omitted required %s rejects with zero writes, then the same key records a real 40/40 pass', async field => {
    await rejectsUnknownModernCount(field, 'omitted');
  });
  it.each(mandatoryModernCounts)('QPC18 null required %s rejects with zero writes, then the same key records a real 40/40 pass', async field => {
    await rejectsUnknownModernCount(field, 'null');
  });
});
