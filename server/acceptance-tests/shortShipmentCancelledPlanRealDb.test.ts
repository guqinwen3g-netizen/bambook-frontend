import { qcReportSourceFingerprint } from '../src/qc/qcReportAuthority';
import { createQcRouter } from '../src/qc/qcRoute';
import { createSample, advanceSampleStage } from '../src/samples/sampleManageService';
/** V1 actual physical shipment allocation contract, actual isolated PG only. All initial accounts,
 * customer, warehouse and unapproved Order/Line are explicitly synthetic.
 * Actual native Fabric sample/seal/asset/line-version and neutral-batch producers
 * establish each source. An actual received fact requires the new native HTTP
 * producer, a dedicated inventory item, an exact Inbound, receipt and mandatory
 * audit in one transaction. No QC/PP/production/shipment fact is seeded.
 * Exact technical personal grants are not company-default role UAT.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateShortShipment, SHORT_SHIP_BLOCKED_CODE } from '../src/shipping/shortShipmentGate';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createShippingRouter } from '../src/shipping/route';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { resolveCurrentProductionBatchFacts } from '../src/production/productionBatchService';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-short-plan-status-${randomUUID()}`;
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

async function fixture(label: string, shared = false, totalQuantity = '10', initialLegacyHeaderQuantity = 10) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), userId = `${id}-user`,
    customerId = `${id}-customer`, supplierId = `${id}-factory`, caseId = `${id}-case`,
    orderId = `${id}-order`, lineId = `${id}-line`, otherUserId = `${id}-other-user`, teamId = `${id}-team`, shareId = `${id}-share`;
  await db().$transaction(async tx => {
    for (const uid of [userId, otherUserId]) await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic current account', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'manager' } });
    await tx.userPermissionOverrides.createMany({ data: [
      'orders:read', 'orders:write', 'products:read', 'products:write', 'production:read', 'inventory:read', 'inventory:write', 'shipments:read', 'shipments:write',
    ].map(scope => ({ id: `${id}-${scope}`, userId, scope, isActive: true, grantedBy: userId, reason: 'Exact private technical grant, not company approval policy' })) });
    await tx.relation.create({ data: { id: customerId, name: customerId, category: 'Customer', type: 'Company', isOrganization: true,
      ownerId: shared ? otherUserId : userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.relation.create({ data: { id: supplierId, name: supplierId, category: 'Supplier', type: 'Company', isOrganization: true,
      ownerId: userId, salesRepIds: [], tags: [], contactInfo: '{}', lastInteraction: now } });
    await tx.developmentCase.create({ data: { id: caseId, code: caseId, name: 'Synthetic genuine source', type: 'fabric', stage: 'developing',
      owner: userId, customerRelationId: customerId, customerName: customerId, tags: [], createdAt: now, updatedAt: now } });
    await tx.order.create({ data: { id: orderId, poNumber: orderId, customer: customerId, customerRelationId: customerId,
      product: 'Synthetic fabric', type: 'fabric', quantity: initialLegacyHeaderQuantity, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10,
      ownerId: userId, millRelationId: supplierId, sourceCaseId: caseId, importedAt: now, updatedAt: now } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: totalQuantity, unit: 'm',
      description: 'Synthetic controlled physical range', tolerancePercent: '25', toleranceSource: 'line_override' } });
    await tx.warehouse.create({ data: { id: id + '-warehouse', code: id + '-WH', name: 'Synthetic configured warehouse, no stock seeded', type: 'Main', isActive: true, createdAt: now, updatedAt: now } });
    if (shared) {
      await tx.team.create({ data: { id: teamId, name: 'Synthetic current L2 team', status: 'active' } });
      await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
      await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerId,
        permission: 'read+followup', grantedBy: otherUserId } });
    }
  });
  const actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  expect(actor.authorizationLoaded).toBe(true); expect(actor.roles).toContain('manager'); expect(actor.permissions).toContain('orders:write');
  const f = { id, userId, otherUserId, customerId, supplierId, caseId, orderId, lineId, actor, teamId, shareId, sealId: '', assetId: '', warehouseId: id + '-warehouse' };
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
  app.use('/api/v1/qc', createQcRouter({ prisma: client, requireAuth: true, apiKeys: new Set() }));
  app.use('/api/v1/shipping', createShippingRouter({ prisma: client, requireAuth, apiKeys: new Set(), exceptionChecker: null, onDataChange: e => changes.push(e) }));
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

const receiptPath = (batchId: string) => `/api/v1/production-batches/${batchId}/stock-receipts`;
async function originalBatch(f: Fixture, qty = '10') { return (await created(f, await command(f, qty))).batch; }
async function receiptCommand(f: Fixture, batch: any, quantity = '3.2501') {
  const current = await request(application().app).get(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200);
  expect(current.body.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  return { expectedBatchRevision: batch.revision, expectedScopeFingerprint: current.body.scopeFingerprint,
    warehouseId: f.warehouseId, quantity, unit: 'm', movementDate: '2099-10-02',
    receiptReference: 'Synthetic software receipt observation; no actual manufactured goods',
    ownership: 'Owned', unitCost: null, currency: 'USD', requestKey: randomUUID() };
}
const receive = (f: Fixture, batch: any, body: any, app = application(), actor = f.actor) =>
  request(app.app).post(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);

const nativeAction = 'create_physical_shipment_allocation';
async function draft(f: Fixture) {
  const r = await request(application().app).post('/api/v1/shipping').set('Authorization', `Bearer ${auth.signToken(f.actor)}`)
    .send({ type: 'Export', shippingMethod: 'Sea', status: 'Draft', customerRelationId: f.customerId, customerName: f.customerId, notes: 'Synthetic draft only; no factory/shipment/QC fact' });
  expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.status).toBe('Draft'); return r.body;
}
const postPath = (ship: any) => `/api/v1/shipping/${ship.id}/allocations`;
const post = (f: Fixture, ship: any, body: any, app = application(), actor = f.actor) => request(app.app).post(postPath(ship)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
const patchAllocation = (f: Fixture, ship: any, allocationId: string, body: any, actor = f.actor) => request(application().app)
  .patch(`${postPath(ship)}/${allocationId}`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function row(f: Fixture, batch: any, plannedQty: string | null, actualQty: string | null = null, stockReceiptId: string | null = null) {
  const current = await request(application().app).get(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200);
  return { productionBatchId: batch.id, expectedRevision: batch.revision, expectedScopeFingerprint: current.body.scopeFingerprint, stockReceiptId, plannedQty, actualQty, unit: 'm' };
}
const input = (f: Fixture, rows: any[], plannedQty: string | null, actualQty: string | null = null) => ({ orderId: f.orderId, orderLineId: f.lineId,
  plannedQty, actualQty, unit: 'm', requestKey: randomUUID(), productionBatchAllocations: rows });
async function facts(f: Fixture) { return { allocations: await db().shipmentOrderAllocation.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
  physical: await db().shipmentProductionAllocation.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
  audits: await db().auditLog.findMany({ where: { actorId: f.userId, action: { in: [nativeAction, 'update_physical_shipment_allocation'] } }, orderBy: { id: 'asc' } }) }; }
function auditFailure(probe: { reached: boolean }) { return new Proxy(db(), { get(target, key) {
  if (key === '$transaction') return (work: any, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(transaction, delegate) {
    if (delegate === 'auditLog') return new Proxy(transaction.auditLog, { get(model, method) {
      if (method === 'create') return (arg: any) => { if (arg.data.action === nativeAction) { probe.reached = true;
        return model.create({ ...arg, data: { ...arg.data, actorId: prefix + '-actual-nonexistent-audit-actor' } }); } return model.create(arg); };
      const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
    } }); const value = Reflect.get(transaction, delegate); return typeof value === 'function' ? value.bind(transaction) : value;
  } })), options); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} }); }
async function qualifiedFinal(f: Fixture, batch: any, result: 'pass' | 'fail' = 'pass') {
  await db().userPermissionOverrides.createMany({ data: [f.userId, f.otherUserId].flatMap(userId =>
    ['qc:read', 'qc:write', 'orders:read'].map(scope => ({ id: `${f.id}-${userId}-${scope}`, userId,
      scope, isActive: true, grantedBy: f.userId, reason: 'Explicit synthetic QC control capability; not company role-policy UAT' }))), skipDuplicates: true });
  f.actor = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.userId));
  const inspector = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.otherUserId));
  const app = application();
  const http = (method: 'get' | 'post', url: string, actor = f.actor) => request(app.app)[method](url).set('Authorization', `Bearer ${auth.signToken(actor)}`);
  const scopes = await http('get', `/api/v1/qc/orders/${f.orderId}/inspection-scopes`);
  expect(scopes.status, diagnostic(scopes.body)).toBe(200);
  const scope = scopes.body.scopes.find((row: any) => row.productionBatchId === batch.id);
  expect(scope, 'native current batch coverage').toBeTruthy();
  const assigned = await http('post', '/api/v1/qc/assignments').send({ orderId: f.orderId, inspectionType: 'final', qcUserId: f.otherUserId,
    dueDate: '2099-01-01', scopeType: 'production_batch', productionBatchId: batch.id,
    expectedBatchRevision: batch.revision, expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID() });
  expect(assigned.status, diagnostic(assigned.body)).toBe(201);
  const started = await http('post', `/api/v1/qc/assignments/${assigned.body.item.id}/start`, inspector);
  expect(started.status, diagnostic(started.body)).toBe(200);
  const completed = await http('post', `/api/v1/qc/assignments/${assigned.body.item.id}/complete`, inspector).send({
    requestKey: randomUUID(), expectedScopeFingerprint: scope.scopeFingerprint, report: { result,
      inspectionDate: '2026-10-02', totalUnits: 10, passedUnits: result === 'pass' ? 10 : 0,
      criticalDefects: result === 'pass' ? 0 : 1, majorDefects: 0, minorDefects: 0, sampleSize: 10, lotSize: 10 } });
  expect(completed.status, diagnostic(completed.body)).toBe(200);
  expect(completed.body.report.approvedByBusiness).toBe(false);
  const report = completed.body.report;
  const decided = await http('post', `/api/v1/qc/reports/${report.id}/business-decision`).send({ decision: 'approved',
    expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
    expectedContentFingerprint: report.contentFingerprint, requestKey: randomUUID(), reason: 'Synthetic recorded business review; no factory instruction or actual shipping' });
  expect(decided.status, diagnostic(decided.body)).toBe(200);
  expect(decided.body.item.approvedByBusiness).toBe(true); return decided.body.item;
}
async function confirmedShipSample(f: Fixture) {
  const made = await createSample({ prisma: db(), actorId: f.userId, input: { type: 'ship', sourceCaseId: f.caseId,
    sourceOrderId: f.orderId, customerRelationId: f.customerId, supplierRelationId: f.supplierId,
    notes: 'Synthetic actual S/S workflow control, no external delivery' } });
  expect(made.ok, diagnostic(made)).toBe(true); const sampleId = (made as any).data.sample.id;
  for (const action of ['start', 'qc', 'submit', 'confirm'] as const) {
    const next = await advanceSampleStage({ prisma: db(), sampleId, actorId: f.userId, action,
      input: { qcStatus: 'passed', sentDate: '2026-10-02', customerStatus: 'approved',
        feedback: 'Synthetic native software confirmation; not actual customer approval' } });
    expect(next.ok, diagnostic(next)).toBe(true);
  }
  const current = await db().sample.findUniqueOrThrow({ where: { id: sampleId } });
  expect(current.customerStatus).toBe('approved'); expect(current.sourceOrderId).toBe(f.orderId); return current;
}
async function physicalCommand(f: Fixture, ship: any, patch: any, app = application()) {
  const current = await request(app.app).get(`/api/v1/shipping/${ship.id}/physical-context`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200); expect(current.body.kind).toBe('physical');
  return { ...patch, requestKey: randomUUID(), expectedShipmentUpdatedAt: current.body.updatedAt,
    expectedPhysicalAllocationFingerprint: current.body.allocationFingerprint };
}
const dispatchPatch = { status: 'Shipped', loadType: 'LCL', vesselOrFlight: 'Synthetic controlled vessel', voyageNumber: 'CTRL-001',
  portOfLoading: 'Synthetic origin', portOfDischarge: 'Synthetic destination' };
const patchShip = (f: Fixture, ship: any, body: any, app = application(), actor = f.actor) => request(app.app)
  .patch(`/api/v1/shipping/${ship.id}`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);

// Independent synthetic neutral rows configure the initial contract only. The
// source, two 100-unit PB ranges, first receipt, QC/S/S, SOA/SPA, packing and
// cancellation below are actual native producers. No approved or stock row is
// seeded and this never loads the original UI18 case or customer approval.
async function splitCase(label: string, planned = '100', actual: string | null = null, differentLine = false) {
  const f = await fixture(label, false, '200', 200), app = application();
  const firstBatch = (await created(f, await command(f, '100', 'FIRST'), app)).batch;
  const received = await receive(f, firstBatch, await receiptCommand(f, firstBatch, '100'), app);
  expect(received.status, diagnostic(received.body)).toBe(201);
  const first = await draft(f), allocation = await post(f, first, input(f,
    [await row(f, firstBatch, '100', '100', received.body.receipt.id)], '100', '100'), app);
  expect(allocation.status, diagnostic(allocation.body)).toBe(201);
  const packed = await request(app.app).post(`/api/v1/shipping/${first.id}/lines/pull-from-order`)
    .set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(packed.status, diagnostic(packed.body)).toBe(200); expect(packed.body.lines[0].quantity).toBe('100');
  const futureSource = differentLine ? await fixture(label + '-other-line', false, '200', 200) : f;
  const futureBatch = (await created(futureSource, await command(futureSource, '100', 'FUTURE'))).batch;
  const future = await draft(futureSource), plan = await post(futureSource, future,
    input(futureSource, [await row(futureSource, futureBatch, planned, actual)], planned, actual));
  expect(plan.status, diagnostic(plan.body)).toBe(201); expect(plan.body.actualQty).toBe(actual);
  expect(await db().productionStockReceipt.count({ where: { productionBatchId: futureBatch.id } })).toBe(0);
  expect(await db().inventoryItem.count({ where: { productionStockReceipt: { is: { productionBatchId: futureBatch.id } } } })).toBe(0);
  expect(await db().inspectionReport.count({ where: { productionBatchId: futureBatch.id } })).toBe(0);
  const report = await qualifiedFinal(f, firstBatch), sample = await confirmedShipSample(f);
  const booked = await patchShip(f, first, await physicalCommand(f, first, { status: 'Booked' }), app);
  expect(booked.status, diagnostic(booked.body)).toBe(200);
  const beforeDispatch = await db().inventoryItem.findUniqueOrThrow({ where: { id: received.body.receipt.inventoryItemId } });
  expect(beforeDispatch.quantity.toString()).toBe('100');
  return { f, app, first, firstBatch, receipt: received.body.receipt, allocation: allocation.body,
    futureSource, future, futureBatch, plan: plan.body, report, sample };
}
async function evaluation(item: Awaited<ReturnType<typeof splitCase>>) {
  return db().$transaction(tx => evaluateShortShipment(tx, { shipmentId: item.first.id, physicalSource: true }));
}
async function rejectedFinal(item: Awaited<ReturnType<typeof splitCase>>) {
  const result = await patchShip(item.f, item.first, await physicalCommand(item.f, item.first, dispatchPatch), item.app);
  expect(result.status, diagnostic(result.body)).toBe(409); expect(code(result)).toBe(SHORT_SHIP_BLOCKED_CODE);
  expect(result.body.error.shortShipDetails.blocked).toEqual([expect.objectContaining({ orderLineId: item.f.lineId,
    contractQty: 200, shippedQty: 100, allowedMin: 150, shortage: 50, tolerancePct: 25, toleranceSource: 'line_override' })]);
  expect((await db().shipment.findUniqueOrThrow({ where: { id: item.first.id } })).status).toBe('Booked');
  expect(await db().stockMovement.count({ where: { type: 'Outbound', referenceType: 'Shipment', referenceId: item.first.id } })).toBe(0);
  expect((await db().inventoryItem.findUniqueOrThrow({ where: { id: item.receipt.inventoryItemId } })).quantity.toString()).toBe('100');
  expect(await db().approvalRequest.count({ where: { targetId: item.f.lineId, status: 'approved' } })).toBe(0);
}
describe.sequential('cancelled physical future plans do not defer actual final short-shipment review', () => {
  it('native plan creation then original allocation cancel retains 100/null history and Draft future Shipment, but first dispatch is final and blocked', async () => {
    const item = await splitCase('cancel-original-plan');
    expect((await evaluation(item)).judgedLines).toBe(0);
    const originalAudits = await db().auditLog.findMany({ where: { targetId: item.plan.id }, orderBy: { id: 'asc' } });
    const cancelled = await patchAllocation(item.futureSource, item.future, item.plan.id,
      { status: 'Cancelled', expectedAllocationUpdatedAt: item.plan.updatedAt, requestKey: randomUUID() });
    expect(cancelled.status, diagnostic(cancelled.body)).toBe(200);
    const stored = await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: item.plan.id } });
    expect(stored.status).toBe('Cancelled'); expect(stored.plannedQty!.toString()).toBe('100'); expect(stored.actualQty).toBeNull();
    expect((await db().shipment.findUniqueOrThrow({ where: { id: item.future.id } })).status).toBe('Draft');
    expect((await db().shipmentProductionAllocation.findFirstOrThrow({ where: { allocationId: item.plan.id } })).state).toBe('released');
    const audits = await db().auditLog.findMany({ where: { targetId: item.plan.id }, orderBy: { id: 'asc' } });
    expect(audits.filter(row => originalAudits.some(old => old.id === row.id))).toEqual(originalAudits);
    expect(audits.filter(row => row.action === 'update_physical_shipment_allocation')).toHaveLength(1);
    await rejectedFinal(item);
    const closed = await evaluation(item); expect(closed.judgedLines).toBe(1); expect(closed.blocked.map(row => row.orderLineId)).toEqual([item.f.lineId]);
  });
  it('a genuine active future 100/null unreceived plan still allows first dispatch and deducts only the first original receipt', async () => {
    const item = await splitCase('active-future-plan'); const ev = await evaluation(item);
    expect(ev.judgedLines).toBe(0); expect(ev.blocked).toEqual([]);
    const sent = await patchShip(item.f, item.first, await physicalCommand(item.f, item.first, dispatchPatch), item.app);
    expect(sent.status, diagnostic(sent.body)).toBe(200); expect(sent.body.status).toBe('Shipped');
    const moves = await db().stockMovement.findMany({ where: { type: 'Outbound', referenceType: 'Shipment', referenceId: item.first.id } });
    expect(moves).toHaveLength(1); expect(moves[0].quantity.toString()).toBe('100'); expect(moves[0].itemId).toBe(item.receipt.inventoryItemId);
    expect((await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: item.plan.id } })).status).toBe('Planned');
    expect(await db().productionStockReceipt.count({ where: { productionBatchId: item.futureBatch.id } })).toBe(0);
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: item.future.id } })).toBe(0);
    expect(await db().approvalRequest.count({ where: { targetId: item.f.lineId } })).toBe(0);
  });
  it('native future Shipment cancellation still closes the short gate with the original plan quantities intact', async () => {
    const item = await splitCase('cancel-future-shipment');
    const cancelled = await patchShip(item.futureSource, item.future,
      await physicalCommand(item.futureSource, item.future, { status: 'Cancelled' }));
    expect(cancelled.status, diagnostic(cancelled.body)).toBe(200);
    const stored = await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: item.plan.id } });
    expect(stored.plannedQty!.toString()).toBe('100'); expect(stored.actualQty).toBeNull(); await rejectedFinal(item);
  });
  it('native exact zero/zero future history does not postpone final short-shipment review', async () => {
    const item = await splitCase('zero-history', '0', '0'); await rejectedFinal(item);
  });
  it('native zero/null future quantity remains unknown, never silently normalizes into zero/zero history', async () => {
    const item = await splitCase('unknown-future', '0', null), ev = await evaluation(item);
    expect(ev.judgedLines).toBe(0); expect(ev.blocked).toEqual([]); expect(ev.unfilled).toEqual([]);
    const sent = await patchShip(item.f, item.first, await physicalCommand(item.f, item.first, dispatchPatch), item.app);
    expect(sent.status, diagnostic(sent.body)).toBe(200);
    const unknown = await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: item.plan.id } });
    expect(unknown.plannedQty!.toString()).toBe('0'); expect(unknown.actualQty).toBeNull();
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: item.future.id } })).toBe(0);
  });
  it('a genuine active plan on a different native line cannot defer first-line shortage or substitute customer approval', async () => {
    const item = await splitCase('other-line', '100', null, true); await rejectedFinal(item);
    expect((await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: item.plan.id } })).orderLineId).not.toBe(item.f.lineId);
    expect((await db().shipment.findUniqueOrThrow({ where: { id: item.future.id } })).status).toBe('Draft');
  });
});
