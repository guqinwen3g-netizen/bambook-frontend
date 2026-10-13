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

const prefix = `acceptance-shipped-metadata-${randomUUID()}`;
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
async function consumerFixture(label: string, reportResult: 'pass' | 'fail' = 'pass') {
  const f = await fixture(label), batch = await originalBatch(f);
  const firstCommand = await receiptCommand(f, batch, '3.2501'), first = await receive(f, batch, firstCommand);
  expect(first.status, diagnostic(first.body)).toBe(201);
  const now = BigInt(Date.now()), secondWarehouseId = `${f.id}-WH2`;
  await db().warehouse.create({ data: { id: secondWarehouseId, code: secondWarehouseId, name: 'Configured second synthetic warehouse', type: 'Other', isActive: true, createdAt: now, updatedAt: now } });
  const secondCommand = { ...await receiptCommand(f, batch, '6.7499'), warehouseId: secondWarehouseId }, second = await receive(f, batch, secondCommand);
  expect(second.status, diagnostic(second.body)).toBe(201);
  const ship = await draft(f), rows = [await row(f, batch, '3.2501', '3.2501', first.body.receipt.id),
    await row(f, batch, '4.25', '4.25', second.body.receipt.id)];
  const allocated = await post(f, ship, input(f, rows, '7.5001', '7.5001'));
  expect(allocated.status, diagnostic(allocated.body)).toBe(201);
  const packing = await request(application().app).post(`/api/v1/shipping/${ship.id}/lines/pull-from-order`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(packing.status, diagnostic(packing.body)).toBe(200); expect(packing.body.lines[0].quantity).toBe('7.5001');
  const report = await qualifiedFinal(f, batch, reportResult), sample = await confirmedShipSample(f);
  // Preserve the real state machine: this control must use native booking
  // before it reaches dispatch, not weaken Draft -> Shipped to reach the gate.
  const booked = await patchShip(f, ship, await physicalCommand(f, ship, { status: 'Booked' }));
  expect(booked.status, diagnostic(booked.body)).toBe(200); expect(booked.body.status).toBe('Booked');
  return { f, batch, first: first.body.receipt, second: second.body.receipt, ship, allocated: allocated.body, report, sample };
}
async function consumerFacts(item: Awaited<ReturnType<typeof consumerFixture>>) {
  const { f, ship } = item;
  return { shipment: await db().shipment.findUniqueOrThrow({ where: { id: ship.id } }),
    inventory: await db().inventoryItem.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    movements: await db().stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: ship.id }, orderBy: { id: 'asc' } }),
    physical: await db().shipmentProductionAllocation.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'Shipment', targetId: ship.id }, orderBy: { id: 'asc' } }) };
}

// No production execution rule is changed: this suite qualifies the existing
// no-status metadata command used by the real form regression above.
const metadata = { billOfLadingNo: 'SYNTH-BL-SOURCE-01', etd: '2026-10-02', ata: '2026-10-03', notes: 'Synthetic post-dispatch document/date readback' };
async function events(ship: any) { return db().shipmentEvent.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }); }
async function metadataFacts(item: Awaited<ReturnType<typeof consumerFixture>>) { return { ...await consumerFacts(item), events: await events(item.ship) }; }
async function dispatched(label: string) {
  const item = await consumerFixture(label), body = await physicalCommand(item.f, item.ship, dispatchPatch);
  const response = await patchShip(item.f,item.ship,body); expect(response.status,diagnostic(response.body)).toBe(200);
  expect(response.body.status).toBe('Shipped'); return { item, body, response };
}
function failMandatoryAudit(probe: { reached: boolean }, inspect: (tx: any) => Promise<void>) {
  return new Proxy(db(), { get(target,key) {
    if(key==='$transaction')return (work:any,options:any)=>target.$transaction((tx:any)=>work(new Proxy(tx,{ get(transaction,delegate) {
      if(delegate==='auditLog')return new Proxy(transaction.auditLog,{ get(model,method) {
        if(method==='create')return async(arg:any)=>{ if(arg.data.action==='update_physical_shipment') { await inspect(tx);probe.reached=true;return model.create({...arg,data:{...arg.data,actorId:prefix+'-nonexistent-audit-actor'}}); } return model.create(arg); };
        const value=Reflect.get(model,method);return typeof value==='function' ? value.bind(model) : value;
      } });const value=Reflect.get(transaction,delegate);return typeof value==='function' ? value.bind(transaction) : value;
    } })),options);const value=Reflect.get(target,key);return typeof value==='function' ? value.bind(target) : value;
  } });
}
describe.sequential('Actual native shipped metadata command with original source and physical stock',()=>{
  it('SME01 BL/ETD/ATA no-status current command succeeds without another stock/event/release, keeps original dispatch ACK, and original cancellation reverses each receipt exactly once',async()=>{
    const { item,body:dispatch,response:sent }=await dispatched('metadata-source'),{f,ship}=item;
    const before=await metadataFacts(item),command=await physicalCommand(f,ship,metadata);
    expect(command).not.toHaveProperty('status');const changed=await patchShip(f,ship,command);
    expect(changed.status,diagnostic(changed.body)).toBe(200);expect(changed.body).toMatchObject({...metadata,id:ship.id,status:'Shipped'});
    expect(changed.body.acknowledgement.command).toMatchObject({shipmentId:ship.id,actorId:f.userId,patch:metadata,requestKey:command.requestKey});
    const after=await metadataFacts(item);expect(after.shipment).toMatchObject(metadata);expect(after.inventory).toEqual(before.inventory);expect(after.movements).toEqual(before.movements);expect(after.physical).toEqual(before.physical);expect(after.events).toEqual(before.events);
    const savedAudit=after.audits.find(row=>row.action==='update_physical_shipment' && (row.detail as any)?.after?.ack?.commandSnapshot?.requestKey===command.requestKey)
      ?? after.audits.find(row=>row.action==='update_physical_shipment' && (row.detail as any)?.after?.ack?.shipmentAfter?.billOfLadingNo===metadata.billOfLadingNo);
    expect(savedAudit).toBeTruthy();expect((savedAudit!.detail as any).after.ack.shipmentAfter).toMatchObject(metadata);
    const sourceProof=before.audits.find(row=>row.action==='update_physical_shipment' && (row.detail as any)?.after?.ack?.shipmentAfter?.status==='Shipped')!.detail as any;
    expect(sourceProof.after.ack.releaseGate.orders[0].physicalBatches[0]).toMatchObject({productionBatchId:item.batch.id,reportId:item.report.id,satisfied:true});
    expect((await db().productionStockReceipt.findMany({where:{orderId:f.orderId}})).map(row=>row.id).sort()).toEqual([item.first.id,item.second.id].sort());
    const history=await request(application().app).get(`/api/v1/shipping/${ship.id}/schedule-history`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`);
    expect(history.status,diagnostic(history.body)).toBe(200);expect(history.body.shipmentId).toBe(ship.id);
    expect(history.body.changes.filter((row:any)=>['etd','ata'].includes(row.field)).map((row:any)=>[row.field,row.toValue]).sort()).toEqual([['ata',metadata.ata],['etd',metadata.etd]]);
    expect(history.body.changes.some((row:any)=>row.field==='billOfLadingNo')).toBe(false); // Preserve the real 14-field schedule contract.
    expect((await patchShip(f,ship,dispatch)).body).toEqual(sent.body);expect(await metadataFacts(item)).toEqual(after);
    const alteredOldKey=await patchShip(f,ship,{...dispatch,...metadata});expect(alteredOldKey.status,diagnostic(alteredOldKey.body)).toBe(409);expect(await metadataFacts(item)).toEqual(after);
    const cancel=await physicalCommand(f,ship,{status:'Cancelled'}),cancelled=await patchShip(f,ship,cancel);
    expect(cancelled.status,diagnostic(cancelled.body)).toBe(200);expect(cancelled.body.status).toBe('Cancelled');const reversed=await metadataFacts(item);
    expect(reversed.movements).toHaveLength(4);expect(reversed.movements.filter(row=>row.type==='Outbound')).toEqual(before.movements);expect(reversed.physical.every(row=>row.state==='reversed')).toBe(true);
    for(const receipt of [item.first,item.second]) { const ledger=reversed.movements.filter(row=>row.itemId===receipt.inventoryItemId);expect(ledger).toHaveLength(2);expect(ledger.map(row=>row.type).sort()).toEqual(['Inbound','Outbound']);expect(ledger[0].quantity.equals(ledger[1].quantity)).toBe(true); }
    expect(reversed.inventory.reduce((sum,row)=>sum.plus(row.quantity),new Prisma.Decimal(0)).toString()).toBe('10');
    expect((await patchShip(f,ship,cancel)).body).toEqual(cancelled.body);expect(await metadataFacts(item)).toEqual(reversed);
    const sameCancel=await patchShip(f,ship,await physicalCommand(f,ship,{status:'Cancelled'}));expect(sameCancel.status,diagnostic(sameCancel.body)).toBe(409);expect(await metadataFacts(item)).toEqual(reversed);
  });
  it('SME02 a fresh current-version new-key explicit same Shipped command still fails, and omitted/stale physical command never changes the ticket',async()=>{
    const {item}=await dispatched('same-state-negative'),{f,ship}=item,before=await metadataFacts(item);
    const same=await patchShip(f,ship,await physicalCommand(f,ship,{status:'Shipped',...metadata}));expect(same.status,diagnostic(same.body)).toBe(409);expect(same.body.error.message).toContain('已有执行事实');expect(await metadataFacts(item)).toEqual(before);
    const missing=await patchShip(f,ship,metadata);expect(missing.status,diagnostic(missing.body)).toBe(409);expect(await metadataFacts(item)).toEqual(before);
    const stale=await physicalCommand(f,ship,metadata);const first=await patchShip(f,ship,stale);expect(first.status,diagnostic(first.body)).toBe(200);const after=await metadataFacts(item);
    const staleNew=await patchShip(f,ship,{...stale,requestKey:randomUUID(),notes:'Changed stale request'});expect(staleNew.status,diagnostic(staleNew.body)).toBe(409);expect(await metadataFacts(item)).toEqual(after);
    const badFingerprint=await patchShip(f,ship,{...await physicalCommand(f,ship,metadata),expectedPhysicalAllocationFingerprint:'0'.repeat(64)});expect(badFingerprint.status,diagnostic(badFingerprint.body)).toBe(409);expect(await metadataFacts(item)).toEqual(after);
  });
  it('SME03 no-status metadata remains bounded by original customer scope and live signed/current permission, including original replay',async()=>{
    const {item}=await dispatched('scope-permission'),{f,ship}=item,body=await physicalCommand(f,ship,metadata),before=await metadataFacts(item);
    const ceiling=await patchShip(f,ship,body,application(),{...f.actor,permissionCeiling:[]});expect(ceiling.status,diagnostic(ceiling.body)).toBe(403);expect(await metadataFacts(item)).toEqual(before);
    await db().userPermissionOverrides.createMany({data:['orders:read','shipments:read','shipments:write'].map(scope=>({id:f.id+'-outsider-'+scope,userId:f.otherUserId,scope,isActive:true,grantedBy:f.userId,reason:'Private technical negative scope capability, no company policy change'})),skipDuplicates:true});
    const outsider=await buildLoadedAuthTokenPayload(db(),await loadUserWithRoles(db(),f.otherUserId));
    const out=await patchShip(f,ship,body,application(),outsider);expect([403,404],diagnostic(out.body)).toContain(out.status);expect(await metadataFacts(item)).toEqual(before);
    const success=await patchShip(f,ship,body);expect(success.status,diagnostic(success.body)).toBe(200);const after=await metadataFacts(item);
    await db().userPermissionOverrides.updateMany({where:{userId:f.userId,scope:'shipments:write'},data:{isActive:false}});
    const withdrawn=await patchShip(f,ship,body);expect(withdrawn.status,diagnostic(withdrawn.body)).toBe(403);expect(await metadataFacts(item)).toEqual(after);
  });
  it('SME04 metadata mandatory audit failure rolls back fields and logs; original retry succeeds, then cancelled receipt reversals also roll back on audit failure before exact original retry',async()=>{
    const {item}=await dispatched('metadata-cancel-audit'),{f,ship}=item,before=await metadataFacts(item),body=await physicalCommand(f,ship,metadata),probe={reached:false};
    const client=failMandatoryAudit(probe,async tx=>{expect(await tx.stockMovement.count({where:{referenceType:'Shipment',referenceId:ship.id}})).toBe(2);});
    const failure=await patchShip(f,ship,body,application(client));expect(probe.reached).toBe(true);expect(failure.status,diagnostic(failure.body)).toBe(500);safeBody(failure);expect(await metadataFacts(item)).toEqual(before);
    expect((await patchShip(f,ship,body)).status).toBe(200);const after=await metadataFacts(item),cancel=await physicalCommand(f,ship,{status:'Cancelled'}),cancelProbe={reached:false};
    const cancelClient=failMandatoryAudit(cancelProbe,async tx=>{expect(await tx.stockMovement.count({where:{referenceType:'Shipment',referenceId:ship.id}})).toBe(4);});
    const cancelFailure=await patchShip(f,ship,cancel,application(cancelClient));expect(cancelProbe.reached).toBe(true);expect(cancelFailure.status,diagnostic(cancelFailure.body)).toBe(500);safeBody(cancelFailure);expect(await metadataFacts(item)).toEqual(after);
    const recovered=await patchShip(f,ship,cancel);expect(recovered.status,diagnostic(recovered.body)).toBe(200);expect((await metadataFacts(item)).movements).toHaveLength(4);
    const restored=await metadataFacts(item);expect((await patchShip(f,ship,cancel)).body).toEqual(recovered.body);expect(await metadataFacts(item)).toEqual(restored);
  });
});
