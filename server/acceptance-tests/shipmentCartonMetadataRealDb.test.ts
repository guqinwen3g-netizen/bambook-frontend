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
import { realpathSync, appendFileSync } from 'node:fs';
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

const prefix = `acceptance-shipped-carton-${randomUUID()}`;
const auth = createAuthService();
const successActions = ['create_production_batch', 'split_production_batch'];
let prisma: PrismaClient | undefined, sequence = 0;
const connections: PrismaClient[] = [];
function db(): PrismaClient { if (!prisma) throw Error('Independent ProductionBatch identity not verified'); return prisma; }
const batches = (client: any = db()) => client.productionBatch;
function journal(kind:string,value:unknown){const root=process.env.BAMBOOK_CARTON_EVIDENCE_DIR;if(!root)throw Error('Private evidence directory required');appendFileSync(path.join(root,'native-facts.jsonl'),diagnostic({kind,value})+'\n');}
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
  const diagnosticDb = new Proxy(db(), {get(t,k){if(k==='$transaction')return async(work:any,options:any)=>{try{return await t.$transaction(work,options);}catch(error){console.error('PRIVATE_SOURCE_TRANSACTION',error);throw error;}};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
  const asset = await convertToFabricAsset({ prisma: diagnosticDb, caseId, sourceType: 'seal', sourceId: f.sealId, actorId: userId, trustedActor: actor });
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
    await row(f, batch, '6.7499', '6.7499', second.body.receipt.id)];
  const allocated = await post(f, ship, input(f, rows, '10', '10'));
  expect(allocated.status, diagnostic(allocated.body)).toBe(201);
  const packing = await request(application().app).post(`/api/v1/shipping/${ship.id}/lines/pull-from-order`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(packing.status, diagnostic(packing.body)).toBe(200); expect(packing.body.lines[0].quantity).toBe('10');
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
const metadataPath = (ship: any) => `/api/v1/shipping/${ship.id}/carton-metadata`;
const metadataRead = (item: Awaited<ReturnType<typeof consumerFixture>>, app = application(), actor = item.f.actor) => request(app.app).get(metadataPath(item.ship)).set('Authorization', `Bearer ${auth.signToken(actor)}`);
const metadataPut = (item: Awaited<ReturnType<typeof consumerFixture>>, body: any, app = application(), actor = item.f.actor) => request(app.app).put(metadataPath(item.ship)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function dispatched(label: string) {
  const item = await consumerFixture(label);const sent = await patchShip(item.f, item.ship, await physicalCommand(item.f,item.ship,dispatchPatch));
  expect(sent.status, diagnostic(sent.body)).toBe(200);expect(sent.body.status).toBe('Shipped');
  const header=await patchShip(item.f,item.ship,await physicalCommand(item.f,item.ship,{totalPackages:10,grossWeight:'60',netWeight:'50',volume:'0.5'}));expect(header.status,diagnostic(header.body)).toBe(200);
  expect(await db().shipmentCarton.count({where:{shipmentId:item.ship.id}})).toBe(0);return item;
}
function metadataBody(s: any, key = randomUUID()): any {
  const line=s.lines[0];return { requestKey:key,expectedShipmentUpdatedAt:s.context.updatedAt,expectedPhysicalAllocationFingerprint:s.context.allocationFingerprint,
    expectedSourceFingerprint:s.metadata.sourceFingerprint,expectedDispatchHash:s.metadata.dispatchHash,reason:'Explicit synthetic single-box source observation; no factory instruction',
    cartons:[{cartonNo:'ACTUAL-A',description:'First actual synthetic box',length:null,width:null,height:null,grossWeight:'6',netWeight:'5',volume:'0.05',items:[{shipmentLineId:line.id,quantity:'3.2501'}]},
      {cartonNo:'ACTUAL-Z',description:null,length:null,width:null,height:null,grossWeight:'6',netWeight:'5',volume:'0.05',items:[{shipmentLineId:line.id,quantity:'6.7499'}]}] };
}
const ownActions=['SHIPPED_CARTON_METADATA_CARTONS','SHIPPED_CARTON_METADATA_ITEMS','SHIPPED_CARTON_METADATA_HEADER','save_shipped_carton_metadata','reject_shipped_carton_metadata'];
async function protectedFacts(item: Awaited<ReturnType<typeof consumerFixture>>) {
 const f=item.f,id=item.ship.id;const snapshot=JSON.parse(diagnostic({
  lines:await db().shipmentLine.findMany({where:{shipmentId:id},orderBy:{id:'asc'}}),soa:await db().shipmentOrderAllocation.findMany({where:{shipmentId:id},orderBy:{id:'asc'}}),spa:await db().shipmentProductionAllocation.findMany({where:{shipmentId:id},orderBy:{id:'asc'}}),
  batches:await db().productionBatch.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),receipts:await db().productionStockReceipt.findMany({where:{productionBatchId:item.batch.id},orderBy:{id:'asc'}}),reports:await db().inspectionReport.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),
  scopes:await db().releaseScope.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),releases:await db().releaseEvent.findMany({where:{scopeId:{in:(await db().releaseScope.findMany({where:{orderId:f.orderId},select:{id:true}})).map(row=>row.id)}},orderBy:{id:'asc'}}),events:await db().shipmentEvent.findMany({where:{shipmentId:id},orderBy:{id:'asc'}}),
  inventory:await db().inventoryItem.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),movements:await db().stockMovement.findMany({where:{OR:[{referenceId:id},{itemId:{in:(await db().inventoryItem.findMany({where:{orderId:f.orderId},select:{id:true}})).map(x=>x.id)}}]},orderBy:{id:'asc'}}),
  dispatchProof:await db().auditLog.findMany({where:{targetId:id,action:'update_physical_shipment'},orderBy:{id:'asc'}}),financial:await db().orderShipmentBatch.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}}),ioa:await db().invoiceOrderAllocation.findMany({where:{orderId:f.orderId},orderBy:{id:'asc'}})
 }));journal('protectedFacts',{shipmentId:id,snapshot});return snapshot;
}
async function metadataFacts(item: Awaited<ReturnType<typeof consumerFixture>>) {const snapshot=JSON.parse(diagnostic({shipment:await db().shipment.findUniqueOrThrow({where:{id:item.ship.id}}),cartons:await db().shipmentCarton.findMany({where:{shipmentId:item.ship.id},include:{items:{orderBy:{id:'asc'}}},orderBy:{id:'asc'}}),audits:await db().auditLog.findMany({where:{targetId:item.ship.id,action:{in:ownActions}},orderBy:{id:'asc'}})}));journal('metadataFacts',{shipmentId:item.ship.id,snapshot});return snapshot;}
function observed(client:PrismaClient,hook:(tx:any,model:PropertyKey,method:PropertyKey,args:any,invoke:()=>Promise<any>)=>Promise<any>):PrismaClient {
 return new Proxy(client,{get(target,key){if(key==='$transaction')return async(work:any,options:any)=>target.$transaction(async tx=>work(new Proxy(tx,{get(t,k){const value=Reflect.get(t,k);if(value&&typeof value==='object')return new Proxy(value,{get(d,m){const fn=Reflect.get(d,m);return typeof fn==='function'?(args:any)=>hook(tx,k,m,args,()=>fn.call(d,args)):fn;}});return typeof value==='function'?value.bind(t):value;}})),options);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}}) as PrismaClient;
}
describe('actual native Shipped carton-only completion; no dispatch or inventory rewrite',()=>{
 it('SCM01 native source read and single-box metadata commit preserve every original physical fact; same key and later old-key replay never overwrite',async()=>{
  const item=await dispatched('completion');const frozen=await protectedFacts(item);const read=await metadataRead(item);expect(read.status,diagnostic(read.body)).toBe(200);expect(read.body.metadata.dispatchHash).toMatch(/^[a-f0-9]{64}$/);
  const body=metadataBody(read.body),saved=await metadataPut(item,body);expect(saved.status,diagnostic(saved.body)).toBe(200);expect(saved.body.lines).toEqual(read.body.lines);expect(saved.body.cartons.map((c:any)=>c.cartonNo)).toEqual(['ACTUAL-A','ACTUAL-Z']);
  expect(saved.body.shipment).toMatchObject({status:'Shipped',totalPackages:2,grossWeight:'12',netWeight:'10',volume:'0.1'});expect(await protectedFacts(item)).toEqual(frozen);
  const after=await metadataFacts(item);expect(after.shipment).toEqual(saved.body.shipment);expect([...after.cartons].sort((a:any,b:any)=>a.id.localeCompare(b.id))).toEqual([...saved.body.cartons].sort((a:any,b:any)=>a.id.localeCompare(b.id)));expect(after.audits).toHaveLength(4);const replay=await metadataPut(item,body);expect(replay.status,diagnostic(replay.body)).toBe(200);expect(replay.body.acknowledgement).toEqual(saved.body.acknowledgement);expect(await metadataFacts(item)).toEqual(after);
  const next=await metadataRead(item);expect(next.status).toBe(200);const changed=metadataBody(next.body);changed.reason='Second accurate synthetic correction';changed.cartons[0].cartonNo='ACTUAL-B';const later=await metadataPut(item,changed);expect(later.status,diagnostic(later.body)).toBe(200);
  const beforeOldReplay=await metadataFacts(item);const old=await metadataPut(item,body);expect(old.status).toBe(200);expect(old.body.acknowledgement).toEqual(saved.body.acknowledgement);expect(await metadataFacts(item)).toEqual(beforeOldReplay);expect(await protectedFacts(item)).toEqual(frozen);
  const altered=await metadataPut(item,{...body,reason:'Same key changed params'});expect(altered.status).toBe(409);expect(await metadataFacts(item)).toEqual(beforeOldReplay);
 });
 it('SCM02 unknown per-box measurements preserve known original header source without fake zero; incomplete quantity, ranges, foreign IDs and non-Shipped are rejected',async()=>{
  const item=await dispatched('precise-coverage');const read=await metadataRead(item);expect(read.status,diagnostic(read.body)).toBe(200);const frozen=await protectedFacts(item),base=metadataBody(read.body),before=await metadataFacts(item);
  for(const mutate of [(b:any)=>b.cartons[0].items[0].quantity=null,(b:any)=>b.cartons[1].items[0].quantity='6',(b:any)=>b.cartons[0].items[0].shipmentLineId='foreign-source',(b:any)=>b.cartons[0].cartonNo='1-60',(b:any)=>b.cartons[1].cartonNo=b.cartons[0].cartonNo,(b:any)=>b.lines=[]]){
    const bad=structuredClone(base);bad.requestKey=randomUUID();mutate(bad);const denied=await metadataPut(item,bad);expect([400,409]).toContain(denied.status);safeBody(denied);const after=await metadataFacts(item);expect(after.shipment).toEqual(before.shipment);expect(after.cartons).toEqual(before.cartons);expect(await protectedFacts(item)).toEqual(frozen);
  }
  const missing=structuredClone(base);missing.requestKey=randomUUID();missing.cartons.forEach((c:any)=>{c.grossWeight=null;c.netWeight=null;c.volume=null;});const saved=await metadataPut(item,missing);expect(saved.status,diagnostic(saved.body)).toBe(200);expect(saved.body.shipment.grossWeight).toBe(before.shipment.grossWeight);expect(saved.body.shipment.netWeight).toBe(before.shipment.netWeight);expect(saved.body.shipment.volume).toBe(before.shipment.volume);expect(saved.body.headerSources).toMatchObject({grossWeight:'existing_shipment',netWeight:'existing_shipment',volume:'existing_shipment'});expect(await protectedFacts(item)).toEqual(frozen);
  const arrived=await patchShip(item.f,item.ship,await physicalCommand(item.f,item.ship,{status:'Arrived'}));expect(arrived.status,diagnostic(arrived.body)).toBe(200);expect((await metadataRead(item)).status).toBe(409);expect((await metadataPut(item,{...base,requestKey:randomUUID()})).status).toBe(409);
 });
 it('SCM03 current revoked grant, empty signed ceiling, stale Owner JWT, moved parent scope, source/storage faults and damaged dispatch cannot produce metadata',async()=>{
  const item=await dispatched('authority');const read=await metadataRead(item);expect(read.status,diagnostic(read.body)).toBe(200);const body=metadataBody(read.body),before=await metadataFacts(item);
  const empty={...item.f.actor,permissionCeiling:[]};expect((await metadataPut(item,body,application(),empty)).status).toBe(403);
  await db().userPermissionOverrides.update({where:{id:`${item.f.id}-shipments:write`},data:{isActive:false}});const stale={...item.f.actor,roles:['owner' as const]};expect((await metadataPut(item,body,application(),stale)).status).toBe(403);await db().userPermissionOverrides.update({where:{id:`${item.f.id}-shipments:write`},data:{isActive:true}});
  await db().relation.update({where:{id:item.f.customerId},data:{ownerId:item.f.otherUserId}});expect((await metadataPut(item,body)).status).toBe(404);await db().relation.update({where:{id:item.f.customerId},data:{ownerId:item.f.userId}});
  let accountFault=false;const account=observed(db(),async(_tx,m,op,args,invoke)=>{if(m==='userAccount'&&op==='findUnique'){accountFault=true;throw Error('private account SELECT fault');}return invoke();});const fault=await metadataPut(item,body,application(account));expect(fault.status).toBe(503);expect(accountFault).toBe(true);safeBody(fault);
  let auditReadFault=false;const storage=observed(db(),async(_tx,m,op,args,invoke)=>{if(m==='auditLog'&&op==='findMany'){auditReadFault=true;throw Error('private dispatch SELECT fault');}return invoke();});const unknown=await metadataPut(item,body,application(storage));expect(unknown.status).toBe(500);expect(auditReadFault).toBe(true);safeBody(unknown);
  expect(await metadataFacts(item)).toEqual(before);
  const dispatch=before.shipment.id;const log=await db().auditLog.findFirstOrThrow({where:{targetId:dispatch,action:'update_physical_shipment',detail:{path:['after','ack','shipmentAfter','status'],equals:'Shipped'}}});const original=log.detail;await db().auditLog.update({where:{id:log.id},data:{detail:{damaged:'synthetic negative'}}});expect((await metadataPut(item,body)).status).toBe(409);await db().auditLog.update({where:{id:log.id},data:{detail:original as any}});expect(await metadataFacts(item)).toEqual(before);
 });
 it('SCM04 each real carton/item/header producer and mandatory audit failure rolls back; late independent grant withdrawal refuses after main proof INSERT',async()=>{
  const item=await dispatched('producer-rollback');const read=await metadataRead(item);expect(read.status,diagnostic(read.body)).toBe(200);const frozen=await protectedFacts(item),before=await metadataFacts(item);const conn=new PrismaClient();connections.push(conn);expect((await conn.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid).not.toBe((await db().$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid);
  for(const fault of ['shipmentCarton','shipmentCartonItem','shipment',...ownActions.slice(0,4),'late-grant']){
   let triggered=false;const body=metadataBody(read.body);const proxy=observed(db(),async(tx,m,op,args,invoke)=>{
    if(!triggered&&((fault==='shipmentCarton'&&m==='shipmentCarton'&&op==='create')||(fault==='shipmentCartonItem'&&m==='shipmentCartonItem'&&op==='create')||(fault==='shipment'&&m==='shipment'&&op==='update'))){triggered=true;throw Error('private real producer fault');}
    if(m==='auditLog'&&op==='create'&&args.data.action===fault){triggered=true;return (tx as any).auditLog.create({...args,data:{...args.data,actorId:prefix+'-nonexistent-audit-actor'}});}
    const result=await invoke();if(fault==='late-grant'&&!triggered&&m==='auditLog'&&op==='create'&&args.data.action==='save_shipped_carton_metadata'){triggered=true;await conn.userPermissionOverrides.update({where:{id:`${item.f.id}-shipments:write`},data:{isActive:false}});}return result;
   });const refused=await metadataPut(item,body,application(proxy));expect(refused.status,fault+diagnostic(refused.body)).toBe(fault==='late-grant'?403:500);expect(triggered,fault).toBe(true);safeBody(refused);if(fault==='late-grant')await conn.userPermissionOverrides.update({where:{id:`${item.f.id}-shipments:write`},data:{isActive:true}});expect(await metadataFacts(item),fault).toEqual(before);expect(await protectedFacts(item),fault).toEqual(frozen);
  }
 });
 it('SCM05 two genuine PG connections same-key completion commit one carton set and four proofs; distinct keys at one version never replace the winner; orphan primitive stays unknown',async()=>{
  const item=await dispatched('concurrency');const read=await metadataRead(item);expect(read.status,diagnostic(read.body)).toBe(200);const body=metadataBody(read.body),frozen=await protectedFacts(item);const a=new PrismaClient(),b=new PrismaClient();connections.push(a,b);const results=await Promise.all([metadataPut(item,body,application(a)),metadataPut(item,body,application(b))]);results.forEach(r=>expect(r.status,diagnostic(r.body)).toBe(200));expect(results[0].body.acknowledgement).toEqual(results[1].body.acknowledgement);expect((await metadataFacts(item)).audits).toHaveLength(4);
  const next=await metadataRead(item);expect(next.status).toBe(200);const one=metadataBody(next.body),two=metadataBody(next.body);one.cartons[0].cartonNo='FIRST';two.cartons[0].cartonNo='SECOND';const raced=await Promise.all([metadataPut(item,one,application(a)),metadataPut(item,two,application(b))]);expect(raced.map(r=>r.status).sort()).toEqual([200,409]);const current=await metadataFacts(item);expect(current.cartons).toHaveLength(2);expect(await protectedFacts(item)).toEqual(frozen);
  const main=current.audits.find((x:any)=>x.action==='save_shipped_carton_metadata'&&x.detail.after.command.requestKey===body.requestKey);expect(main).toBeTruthy();await db().auditLog.delete({where:{id:main.id}});const beforeOrphan=await metadataFacts(item);const unknown=await metadataPut(item,body);expect(unknown.status).toBe(409);expect(await metadataFacts(item)).toEqual(beforeOrphan);expect(await protectedFacts(item)).toEqual(frozen);
 });
});
