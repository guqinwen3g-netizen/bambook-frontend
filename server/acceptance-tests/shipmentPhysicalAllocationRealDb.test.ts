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

const prefix = `acceptance-shipment-physical-${randomUUID()}`;
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
describe.sequential('actual private PG native SOA to physical batch and original receipt', () => {
  it('SPA01 a real unreceived batch can reserve a plan; it never fabricates receipt, stock, QC or shipped facts', async () => {
    const f = await fixture('plan'), batch = await originalBatch(f), ship = await draft(f), body = input(f, [await row(f, batch, '3.2501')], '3.2501');
    const r = await post(f, ship, body); expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.replayed).toBe(false);
    expect(r.body.plannedQty).toBe('3.2501'); expect(r.body.actualQty).toBeNull(); expect(r.body.productionBatchAllocations).toHaveLength(1);
    const projection = await db().shipmentProductionAllocation.findFirstOrThrow({ where: { allocationId: r.body.id } });
    expect(projection).toMatchObject({ productionBatchId: batch.id, productionBatchRevision: batch.revision, state: 'reserved', createdBy: f.userId });
    expect(String(projection.plannedQty)).toBe('3.2501'); expect(projection.actualQty).toBeNull();
    expect((projection.scopeSnapshot as any).receiptAllocations).toMatchObject([{ stockReceiptId: null, plannedQty: '3.2501', actualQty: null }]);
    expect(await db().productionStockReceipt.count({ where: { orderId: f.orderId } })).toBe(0); expect(await db().inventoryItem.count({ where: { orderId: f.orderId } })).toBe(0);
    expect(await db().inspectionReport.count({ where: { orderId: f.orderId } })).toBe(0); expect(await db().shipment.findUniqueOrThrow({ where: { id: ship.id } })).toMatchObject({ status: 'Draft', orderId: f.orderId });
    expect((await facts(f)).audits).toHaveLength(1);
  });
  it('SPA02 one batch can bind two real receipts in two warehouses without collapsing original receipt or decimal identity', async () => {
    const f = await fixture('two-warehouses'), batch = await originalBatch(f), ship = await draft(f), firstCommand = await receiptCommand(f, batch, '3.2501');
    const first = await receive(f, batch, firstCommand); expect(first.status, diagnostic(first.body)).toBe(201);
    const now = BigInt(Date.now()), secondWarehouse = f.id + '-warehouse2';
    await db().warehouse.create({ data: { id: secondWarehouse, code: secondWarehouse, name: 'Explicit INITIAL second warehouse; no stock', type: 'Main', isActive: true, createdAt: now, updatedAt: now } });
    const second = await receive(f, batch, { ...await receiptCommand(f, batch, '2.4999'), warehouseId: secondWarehouse }); expect(second.status, diagnostic(second.body)).toBe(201);
    const body = input(f, [await row(f, batch, '3.2501', '3.2501', first.body.receipt.id), await row(f, batch, '2.4999', '2.4999', second.body.receipt.id)], '5.75', '5.75');
    const r = await post(f, ship, body); expect(r.status, diagnostic(r.body)).toBe(201);
    expect(r.body.productionBatchAllocations).toHaveLength(1); const projection = await db().shipmentProductionAllocation.findFirstOrThrow({ where: { allocationId: r.body.id } });
    expect(String(projection.actualQty)).toBe('5.75'); expect((projection.scopeSnapshot as any).receiptAllocations.map((x: any) => x.stockReceiptId).sort()).toEqual([first.body.receipt.id, second.body.receipt.id].sort());
    expect((await db().productionStockReceipt.findMany({ where: { orderId: f.orderId } })).map(x => x.inventoryItemId).sort()).toEqual([first.body.inventoryItem.id, second.body.inventoryItem.id].sort());
    expect(await db().stockMovement.count({ where: { itemId: { in: [first.body.inventoryItem.id, second.body.inventoryItem.id] }, type: 'Outbound' } })).toBe(0);
  });
  it('SPA03 actual goods require a real receipt, and a modern batch cannot silently fall back to legacy allocation when its list is omitted', async () => {
    const f = await fixture('no-receipt'), batch = await originalBatch(f), ship = await draft(f), before = await facts(f);
    const r = await post(f, ship, input(f, [await row(f, batch, null, '2')], null, '2')); expect(r.status, diagnostic(r.body)).toBe(400);
    const omitted = await post(f, ship, { orderId: f.orderId, orderLineId: f.lineId, plannedQty: '2', actualQty: null, unit: 'm' }); expect(omitted.status, diagnostic(omitted.body)).toBe(409);
    expect(await facts(f)).toEqual(before);
  });
  it('SPA04 original create and update ACKs remain immutable after subsequent quantities change; changed parameters under either old key conflict', async () => {
    const f = await fixture('replay'), batch = await originalBatch(f), ship = await draft(f), body = input(f, [await row(f, batch, '3')], '3');
    const made = await post(f, ship, body); expect(made.status, diagnostic(made.body)).toBe(201);
    const update = { plannedQty: '2.0001', expectedAllocationUpdatedAt: made.body.updatedAt, requestKey: randomUUID(), productionBatchAllocations: [await row(f, batch, '2.0001')] };
    const changed = await patchAllocation(f, ship, made.body.id, update); expect(changed.status, diagnostic(changed.body)).toBe(200); expect(changed.body.updatedAt).not.toBe(made.body.updatedAt);
    const original = await post(f, ship, body); expect(original.status, diagnostic(original.body)).toBe(200); expect(original.body).toEqual({ ...made.body, replayed: true });
    const second = await patchAllocation(f, ship, made.body.id, update); expect(second.status, diagnostic(second.body)).toBe(200); expect(second.body).toEqual({ ...changed.body, replayed: true });
    expect((await facts(f)).audits).toHaveLength(2); expect((await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: made.body.id } })).plannedQty!.toString()).toBe('2.0001');
    expect((await post(f, ship, { ...body, plannedQty: '4' })).status).toBe(409); expect((await patchAllocation(f, ship, made.body.id, { ...update, plannedQty: '4' })).status).toBe(409);
  });
  it('SPA05 omitted associations are preserved on unrelated edits; unmatched quantity/unit changes and stale timestamps preserve every original fact', async () => {
    const f = await fixture('patch-preserve'), batch = await originalBatch(f), ship = await draft(f), made = await post(f, ship, input(f, [await row(f, batch, '3')], '3'));
    expect(made.status, diagnostic(made.body)).toBe(201);
    const changed = await patchAllocation(f, ship, made.body.id, { batchOrCartonNote: 'Actual note only', expectedAllocationUpdatedAt: made.body.updatedAt, requestKey: randomUUID() });
    expect(changed.status, diagnostic(changed.body)).toBe(200); expect(changed.body.productionBatchAllocations).toHaveLength(1); const before = await facts(f);
    for (const change of [{ plannedQty: '4' }, { unit: 'yd' }, { expectedAllocationUpdatedAt: made.body.updatedAt }]) {
      const r = await patchAllocation(f, ship, made.body.id, { expectedAllocationUpdatedAt: changed.body.updatedAt, requestKey: randomUUID(), ...change });
      expect(r.status, diagnostic(r.body)).toBe(409); expect(await facts(f)).toEqual(before);
    }
  });
  it('SPA06 two concurrent plans cannot reserve more than one actual batch; one6m allocation commits and one409', async () => {
    const f = await fixture('concurrent'), batch = await originalBatch(f), ships = [await draft(f), await draft(f)], rows = [await row(f, batch, '6')];
    const results = await Promise.all(ships.map(ship => post(f, ship, input(f, rows, '6'))));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]); const actual = await facts(f); expect(actual.allocations).toHaveLength(1); expect(actual.physical).toHaveLength(1); expect(actual.audits).toHaveLength(1);
  });
  it('SPA07 current permission withdrawal and signed empty ceiling reject original replay as well as new writes', async () => {
    const f = await fixture('auth'), batch = await originalBatch(f), ship = await draft(f), body = input(f, [await row(f, batch, '3')], '3'), made = await post(f, ship, body);
    expect(made.status, diagnostic(made.body)).toBe(201); const before = await facts(f);
    expect((await post(f, ship, body, application(), { ...f.actor, permissionCeiling: [] })).status).toBe(403);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: false } });
    expect((await post(f, ship, body)).status).toBe(403); expect(await facts(f)).toEqual(before);
  });
  it('SPA08 a physical mandatory audit FK failure rolls back SOA, SPA and shipment projection; the same original request can then retry', async () => {
    const f = await fixture('audit-rollback'), batch = await originalBatch(f), ship = await draft(f), body = input(f, [await row(f, batch, '3')], '3'), probe = { reached: false }, before = await facts(f);
    const failed = await post(f, ship, body, application(auditFailure(probe))); expect(probe.reached).toBe(true); expect(failed.status).toBe(500); safeBody(failed);
    expect(await facts(f)).toEqual(before); expect((await db().shipment.findUniqueOrThrow({ where: { id: ship.id } })).orderId).toBeNull();
    const retry = await post(f, ship, body); expect(retry.status, diagnostic(retry.body)).toBe(201); expect(retry.body.replayed).toBe(false);
  });
  it.each(['2.00001', 'NaN', '-1', ' 2 ', 2])('SPA09 invalid decimal %s cannot become a rounded, zero or unknown actual allocation', async value => {
    const f = await fixture('bad-decimal'), batch = await originalBatch(f), ship = await draft(f), before = await facts(f), rows = [await row(f, batch, '2')];
    const r = await post(f, ship, { ...input(f, rows, '2'), plannedQty: value }); expect(r.status, diagnostic(r.body)).toBe(400); expect(await facts(f)).toEqual(before);
  });

  it('SPA10 exact native allocation reads expose original batch identities and preserve decimals and timestamps without receipt costs', async () => {
    const f = await fixture('read-exact'), batch = await originalBatch(f), ship = await draft(f);
    const made = await post(f, ship, input(f, [await row(f, batch, '3.2501')], '3.2501')); expect(made.status, diagnostic(made.body)).toBe(201);
    const r = await request(application().app).get(postPath(ship)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
    expect(r.status, diagnostic(r.body)).toBe(200); expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ id: made.body.id, plannedQty: '3.2501', actualQty: null, updatedAt: made.body.updatedAt });
    expect(r.body.items[0].productionBatchAllocations).toEqual(made.body.productionBatchAllocations);
    expect(diagnostic(r.body)).not.toMatch(/receiptSnapshot|unitCost|commandSnapshot/);
    const order = await request(application().app).get(`/api/v1/shipping/allocations/by-order/${f.orderId}`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
    expect(order.status, diagnostic(order.body)).toBe(200); expect(order.body.items[0]).toMatchObject({ shipmentStatus: 'Draft', shipmentNumber: ship.shipmentNumber, plannedQty: '3.2501' });
  });
  it('SPA11 current read permission withdrawal and signed empty ceiling refuse native allocation reads without changing business facts', async () => {
    const f = await fixture('read-withdraw'), batch = await originalBatch(f), ship = await draft(f);
    expect((await post(f, ship, input(f, [await row(f, batch, '3')], '3'))).status).toBe(201); const before = await facts(f);
    const get = (actor = f.actor) => request(application().app).get(postPath(ship)).set('Authorization', `Bearer ${auth.signToken(actor)}`);
    expect((await get({ ...f.actor, permissionCeiling: [] })).status).toBe(403);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:read' }, data: { isActive: false } });
    expect((await get()).status).toBe(403); expect(await facts(f)).toEqual(before);
  });
  it.each([{ plannedQty: '2', actualQty: null }, { plannedQty: '0', actualQty: null }])('SPA12 legacy unknown or occupied association %j cannot be treated as zero by a new physical plan', async previous => {
    const f = await fixture('legacy-unresolved'), oldShip = await draft(f);
    const legacy = await post(f, oldShip, { orderId: f.orderId, orderLineId: f.lineId, ...previous, unit: 'm' }); expect(legacy.status, diagnostic(legacy.body)).toBe(201);
    const batch = await originalBatch(f), ship = await draft(f), before = await facts(f);
    const denied = await post(f, ship, input(f, [await row(f, batch, '3')], '3')); expect(denied.status, diagnostic(denied.body)).toBe(409);
    expect(await facts(f)).toEqual(before);
  });
  it('SPA13 explicit native PATCH binds the original legacy SOA to its real batch and preserves the original history before another ticket reserves', async () => {
    const f = await fixture('legacy-recovery'), oldShip = await draft(f);
    const legacy = await post(f, oldShip, { orderId: f.orderId, orderLineId: f.lineId, plannedQty: '2', actualQty: null, unit: 'm' }); expect(legacy.status, diagnostic(legacy.body)).toBe(201);
    const batch = await originalBatch(f), ship = await draft(f), body = input(f, [await row(f, batch, '3')], '3');
    expect((await post(f, ship, body)).status).toBe(409);
    const linked = await patchAllocation(f, oldShip, legacy.body.id, { expectedAllocationUpdatedAt: String(legacy.body.updatedAt), requestKey: randomUUID(), productionBatchAllocations: [await row(f, batch, '2')] });
    expect(linked.status, diagnostic(linked.body)).toBe(200); expect(linked.body.id).toBe(legacy.body.id); expect(linked.body.createdAt).toBe(String(legacy.body.createdAt));
    expect(linked.body.allocationVersion).toBe(1); expect((await post(f, ship, body)).status).toBe(201);
    expect(await db().auditLog.count({ where: { targetType: 'ShipmentOrderAllocation', targetId: legacy.body.id, action: 'ALLOCATION_CREATE' } })).toBe(1);
  });
  it('SPA14 only explicitly known double-zero old association may coexist with a native plan without guessing physical history', async () => {
    const f = await fixture('legacy-known-zero'), oldShip = await draft(f);
    expect((await post(f, oldShip, { orderId: f.orderId, orderLineId: f.lineId, plannedQty: '0', actualQty: '0', unit: 'm' })).status).toBe(201);
    const batch = await originalBatch(f), ship = await draft(f);
    const made = await post(f, ship, input(f, [await row(f, batch, '3')], '3')); expect(made.status, diagnostic(made.body)).toBe(201);
    expect((await facts(f)).physical).toHaveLength(1);
  });

  it('SPATR01 normal native Booked Sea shipment cannot bypass missing transport fields through a narrow database select', async () => {
    const f = await fixture('transport-missing'), ship = await draft(f), header = { Authorization: `Bearer ${auth.signToken(f.actor)}` };
    const booked = await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Booked' }); expect(booked.status, diagnostic(booked.body)).toBe(200);
    const r = await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Shipped' });
    expect(r.status, diagnostic(r.body)).toBe(400); expect(code(r)).toBe('SHIPMENT_FIELD_REQUIRED_MISSING');
    expect((await db().shipment.findUniqueOrThrow({ where: { id: ship.id } })).status).toBe('Booked');
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id } })).toBe(0);
  });
  it('SPATR02 same native PATCH can supply actual transport fields before shipping validation; it still cannot invent missing allocation facts', async () => {
    const f = await fixture('transport-complete-patch'), ship = await draft(f), header = { Authorization: `Bearer ${auth.signToken(f.actor)}` };
    const booked = await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Booked' }); expect(booked.status, diagnostic(booked.body)).toBe(200);
    const r = await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Shipped', shippingMethod: 'Sea', loadType: 'LCL',
      vesselOrFlight: 'SYNTH NO REAL VESSEL', voyageNumber: 'SYNTH000', portOfLoading: 'SYNTH LOADING', portOfDischarge: 'SYNTH DISCHARGE' });
    expect(r.status, diagnostic(r.body)).toBe(409); expect(code(r)).toBe('SHIPMENT_NO_ALLOCATION_DETAIL');
    expect((await db().shipment.findUniqueOrThrow({ where: { id: ship.id } })).status).toBe('Booked');
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id } })).toBe(0);
  });

  it('SPATR03 native Land transport fields use the existing exact plate/carrier record rather than an invented Shipment.vehicleNo column', async () => {
    const f = await fixture('transport-native-land'), ship = await draft(f), header = { Authorization: `Bearer ${auth.signToken(f.actor)}` };
    expect((await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Booked', shippingMethod: 'Land' })).status).toBe(200);
    const missing = await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Shipped' });
    expect(missing.status, diagnostic(missing.body)).toBe(400); expect(code(missing)).toBe('SHIPMENT_FIELD_REQUIRED_MISSING');
    const entered = await request(application().app).put(`/api/v1/shipping/${ship.id}/land-transport`).set(header).send({ plateNo: 'SYNTH NO REAL VEHICLE', carrierName: 'SYNTH NO REAL CARRIER' });
    expect(entered.status, diagnostic(entered.body)).toBe(200);
    const r = await request(application().app).patch(`/api/v1/shipping/${ship.id}`).set(header).send({ status: 'Shipped' });
    expect(r.status, diagnostic(r.body)).toBe(409); expect(code(r)).toBe('SHIPMENT_NO_ALLOCATION_DETAIL');
    expect((await db().shipment.findUniqueOrThrow({ where: { id: ship.id } })).status).toBe('Booked');
    expect((await db().shipmentLandTransport.findUniqueOrThrow({ where: { shipmentId: ship.id } })).plateNo).toBe('SYNTH NO REAL VEHICLE');
  });
});

// These controls use genuine native source, stock receipt, S/S progression,
// scoped Final completion and business decision. No approved row is seeded.
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
describe('Native physical dispatch and cancellation consumers', () => {
  it('SPAC01 uses two exact original warehouses, scoped Final and actual S/S; replay freezes original ACK; cancel restores each original Outbound once', async () => {
    const item = await consumerFixture('native-dispatch'), { f, ship } = item, body = await physicalCommand(f, ship, dispatchPatch);
    const before = await consumerFacts(item), shipped = await patchShip(f, ship, body);
    expect(shipped.status, diagnostic(shipped.body)).toBe(200); expect(shipped.body.status).toBe('Shipped');
    const after = await consumerFacts(item); expect(after.movements).toHaveLength(2);
    expect(after.movements.map(row => row.quantity.toString()).sort()).toEqual(['3.2501', '4.25']);
    expect(new Set(after.movements.map(row => row.warehouseId))).toEqual(new Set([item.first.warehouseId, item.second.warehouseId]));
    expect(after.inventory.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).toString()).toBe('2.4999');
    expect(after.physical.every(row => row.state === 'shipped')).toBe(true);
    const proof = after.audits.find(row => row.action === 'update_physical_shipment' && (row.detail as any)?.after?.ack?.shipmentAfter?.status === 'Shipped')!.detail as any;
    expect(proof.after.ack.releaseGate.orders[0].physicalBatches[0]).toMatchObject({ productionBatchId: item.batch.id, reportId: item.report.id, satisfied: true });
    const { acknowledgement, ...publicResult } = shipped.body;
    expect(acknowledgement).toEqual({ schemaVersion: 1,
      command: { requestKey: body.requestKey, expectedShipmentUpdatedAt: body.expectedShipmentUpdatedAt,
        expectedPhysicalAllocationFingerprint: body.expectedPhysicalAllocationFingerprint, patch: dispatchPatch,
        actorId: f.userId, shipmentId: ship.id },
      commandHash: proof.after.ack.commandHash, shipmentHash: qcReportSourceFingerprint(publicResult) });
    expect(JSON.stringify(acknowledgement)).not.toMatch(/unitCost|stockMovements|receiptCommandHash/);
    const replay = await patchShip(f, ship, body); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toEqual(shipped.body);
    expect(await consumerFacts(item)).toEqual(after);
    const cancelled = await patchShip(f, ship, await physicalCommand(f, ship, { status: 'Cancelled' }));
    expect(cancelled.status, diagnostic(cancelled.body)).toBe(200); expect(cancelled.body.status).toBe('Cancelled');
    const reversed = await consumerFacts(item); expect(reversed.movements).toHaveLength(4);
    expect(reversed.inventory.map(row => row.quantity.toString()).sort()).toEqual(before.inventory.map(row => row.quantity.toString()).sort());
    expect(reversed.physical.every(row => row.state === 'reversed')).toBe(true);
    expect(reversed.movements.filter(row => row.type === 'Outbound')).toEqual(after.movements);
  });
  it('SPAC02 real latest scoped failing Final cannot dispatch, even with genuine business approval and S/S', async () => {
    const item = await consumerFixture('failing-final', 'fail'), before = await consumerFacts(item);
    const blocked = await patchShip(item.f, item.ship, await physicalCommand(item.f, item.ship, dispatchPatch));
    expect(blocked.status, diagnostic(blocked.body)).toBe(409); expect(code(blocked)).toBe('GATE_BLOCKED');
    expect(await consumerFacts(item)).toEqual(before);
  });
  it('SPAC03 missing command and stale physical fingerprint cannot change stock or source; a revoked capability also rejects exact dispatch replay', async () => {
    const item = await consumerFixture('stale-command'), { f, ship } = item, before = await consumerFacts(item);
    const missing = await patchShip(f, ship, dispatchPatch); expect(missing.status, diagnostic(missing.body)).toBe(409);
    const command = await physicalCommand(f, ship, dispatchPatch);
    const stale = await patchShip(f, ship, { ...command, expectedPhysicalAllocationFingerprint: '0'.repeat(64) });
    expect(stale.status, diagnostic(stale.body)).toBe(409); expect(await consumerFacts(item)).toEqual(before);
    const success = await patchShip(f, ship, command); expect(success.status, diagnostic(success.body)).toBe(200);
    const after = await consumerFacts(item), denied = await patchShip(f, ship, command, application(), { ...f.actor, permissionCeiling: [] });
    expect(denied.status, diagnostic(denied.body)).toBe(403); expect(await consumerFacts(item)).toEqual(after);
  });
  it('SPAC04 mandatory frozen dispatch audit FK failure after actual Outbound rolls back shipment, SPA, stock and all ledger rows, then original key retries', async () => {
    const item = await consumerFixture('dispatch-audit-rollback'), { f, ship } = item, before = await consumerFacts(item), probe = { reached: false };
    const client = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return (work: any, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(transaction, delegate) {
        if (delegate === 'auditLog') return new Proxy(transaction.auditLog, { get(model, method) {
          if (method === 'create') return async (arg: any) => {
            if (arg.data.action === 'update_physical_shipment') {
              expect(await tx.stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id, type: 'Outbound' } })).toBe(2);
              probe.reached = true; return model.create({ ...arg, data: { ...arg.data, actorId: 'nonexistent-audit-actor' } });
            }
            return model.create(arg);
          };
          const value = (model as any)[method]; return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = (transaction as any)[delegate]; return typeof value === 'function' ? value.bind(transaction) : value;
      } })), options);
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const body = await physicalCommand(f, ship, dispatchPatch), failed = await patchShip(f, ship, body, application(client));
    expect(probe.reached).toBe(true); expect(failed.status, diagnostic(failed.body)).toBe(500); safeBody(failed);
    expect(await consumerFacts(item)).toEqual(before);
    const success = await patchShip(f, ship, body); expect(success.status, diagnostic(success.body)).toBe(200);
    expect((await consumerFacts(item)).movements).toHaveLength(2);
  });
  it('SPAC05 concurrent original dispatch and cancel replay each append only one original ledger set', async () => {
    const item = await consumerFixture('concurrent-replay'), { f, ship } = item;
    const dispatch = await physicalCommand(f, ship, dispatchPatch);
    const sent = await Promise.all([patchShip(f, ship, dispatch), patchShip(f, ship, dispatch)]);
    expect(sent.map(row => row.status)).toEqual([200, 200]); expect(sent[0].body).toEqual(sent[1].body);
    expect((await consumerFacts(item)).movements).toHaveLength(2);
    const cancel = await physicalCommand(f, ship, { status: 'Cancelled' });
    const reversed = await Promise.all([patchShip(f, ship, cancel), patchShip(f, ship, cancel)]);
    expect(reversed.map(row => row.status)).toEqual([200, 200]); expect(reversed[0].body).toEqual(reversed[1].body);
    const after = await consumerFacts(item); expect(after.movements).toHaveLength(4);
    expect(after.inventory.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).toString()).toBe('10');
    expect(after.physical.every(row => row.state === 'reversed')).toBe(true);
  });
  it('SPAC06 two distinct dispatch keys at the same version cannot deduct the original receipts twice', async () => {
    const item = await consumerFixture('concurrent-distinct'), { f, ship } = item;
    const dispatch = await physicalCommand(f, ship, dispatchPatch);
    const sent = await Promise.all([patchShip(f, ship, dispatch), patchShip(f, ship, { ...dispatch, requestKey: randomUUID() })]);
    expect(sent.map(row => row.status).sort()).toEqual([200, 409]);
    const after = await consumerFacts(item); expect(after.movements).toHaveLength(2);
    expect(after.inventory.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).toString()).toBe('2.4999');
    expect(after.physical.every(row => row.state === 'shipped')).toBe(true);
  });
  it('SPAC07 mandatory cancellation audit failure after real inbound reversals rolls back every balance and preserves original Outbounds', async () => {
    const item = await consumerFixture('cancel-audit-rollback'), { f, ship } = item;
    const sent = await patchShip(f, ship, await physicalCommand(f, ship, dispatchPatch));
    expect(sent.status, diagnostic(sent.body)).toBe(200);
    const before = await consumerFacts(item), probe = { reached: false };
    const client = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return (work: any, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(transaction, delegate) {
        if (delegate === 'auditLog') return new Proxy(transaction.auditLog, { get(model, method) {
          if (method === 'create') return async (arg: any) => {
            if (arg.data.action === 'update_physical_shipment') {
              expect(await tx.stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id, type: 'Inbound' } })).toBe(2);
              const inventory = await tx.inventoryItem.findMany({ where: { orderId: f.orderId } });
              expect(inventory.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.quantity), new Prisma.Decimal(0)).toString()).toBe('10');
              probe.reached = true; return model.create({ ...arg, data: { ...arg.data, actorId: 'nonexistent-cancel-audit-actor' } });
            }
            return model.create(arg);
          };
          const value = (model as any)[method]; return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = (transaction as any)[delegate]; return typeof value === 'function' ? value.bind(transaction) : value;
      } })), options);
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const command = await physicalCommand(f, ship, { status: 'Cancelled' });
    const failed = await patchShip(f, ship, command, application(client));
    expect(probe.reached).toBe(true); expect(failed.status, diagnostic(failed.body)).toBe(500); safeBody(failed);
    expect(await consumerFacts(item)).toEqual(before);
    const success = await patchShip(f, ship, command); expect(success.status, diagnostic(success.body)).toBe(200);
    const after = await consumerFacts(item); expect(after.movements).toHaveLength(4);
    expect(after.movements.filter(row => row.type === 'Outbound')).toEqual(before.movements);
  });

});

// These are genuine standalone native Shipment POSTs. Existing unapproved
// order/source fixtures only configure an actual account; no order is attached.
describe('standalone Shipment current native write authority', () => {
  const body = (number: string) => ({ notes: number, type: 'Export', shippingMethod: 'Sea', status: 'Draft' });
  async function rows(f: Fixture, number: string) {
    return { shipments: await db().shipment.findMany({ where: { notes: number } }),
      audits: await db().auditLog.findMany({ where: { actorId: f.userId }, orderBy: { id: 'asc' } }) };
  }
  it('SSA01 a current shipments-write-only actor can create a genuine standalone Draft without an unrelated orders-read requirement', async () => {
    const f = await fixture('standalone-write-only'), number = `SSA-${randomUUID()}`;
    await db().userPermissionOverrides.deleteMany({ where: { userId: f.userId, scope: 'orders:read' } });
    const app = application(), response = await request(app.app).post('/api/v1/shipping')
      .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send(body(number));
    expect(response.status, diagnostic(response.body)).toBe(201);
    expect(typeof response.body.id).toBe('string'); expect(response.body.shipmentNumber).toMatch(/^SH-\d{4}-\d+$/);
    const created = await db().shipment.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(created.notes).toBe(number);
    expect(created.orderId).toBeNull(); expect(created.status).toBe('Draft');
    const edited = await request(app.app).patch(`/api/v1/shipping/${created.id}`)
      .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ notes: 'Current standalone edit without Order scope' });
    expect(edited.status, diagnostic(edited.body)).toBe(200);
    expect((await db().shipment.findUniqueOrThrow({ where: { id: created.id } })).notes).toBe('Current standalone edit without Order scope');
    expect(await db().auditLog.count({ where: { actorId: f.userId, targetId: created.id, action: 'create_shipment' } })).toBe(1);
  });
  it('SSA02 actual grant withdrawn after the route snapshot refuses standalone creation and produces no business facts', async () => {
    const f = await fixture('standalone-prefilter-race'), number = `SSA-${randomUUID()}`, before = await rows(f, number);
    let entered = false;
    const client = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return async (work: any, options: any) => {
        entered = true; await db().userPermissionOverrides.deleteMany({ where: { userId: f.userId, scope: 'shipments:write' } });
        return target.$transaction(work, options);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = application(client), response = await request(app.app).post('/api/v1/shipping')
      .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send(body(number));
    expect(entered).toBe(true); expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN');
    safeBody(response); expect(await rows(f, number)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('SSA03 real signed empty capability ceiling cannot create a standalone shipment', async () => {
    const f = await fixture('standalone-empty-ceiling'), number = `SSA-${randomUUID()}`, before = await rows(f, number);
    const app = application(), response = await request(app.app).post('/api/v1/shipping')
      .set('Authorization', `Bearer ${auth.signToken({ ...f.actor, permissionCeiling: [] })}`).send(body(number));
    expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN');
    safeBody(response); expect(await rows(f, number)).toEqual(before); expect(app.changes).toEqual([]);
  });
  it('SSA04 actual permission withdrawn after native Shipment INSERT rolls back the original row, event and mandatory audit', async () => {
    const f = await fixture('standalone-late-revocation'), number = `SSA-${randomUUID()}`, before = await rows(f, number);
    let stagedId: string | undefined;
    const client = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return async (work: any, options: any) => target.$transaction(async (tx: any) => {
        const observed = new Proxy(tx, { get(storage, delegate) {
          if (delegate === 'shipment') return new Proxy(storage.shipment, { get(model, method) {
            if (method === 'create') return async (args: any) => {
              const created = await model.create(args); stagedId = created.id;
              expect(await tx.shipment.count({ where: { id: created.id } })).toBe(1);
              await db().userPermissionOverrides.deleteMany({ where: { userId: f.userId, scope: 'shipments:write' } });
              return created;
            };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(storage, delegate); return typeof value === 'function' ? value.bind(storage) : value;
        } });
        return work(observed);
      }, options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = application(client), response = await request(app.app).post('/api/v1/shipping')
      .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send(body(number));
    expect(stagedId).toBeTruthy(); expect(response.status, diagnostic(response.body)).toBe(403); expect(code(response)).toBe('FORBIDDEN');
    safeBody(response); expect(await rows(f, number)).toEqual(before); expect(app.changes).toEqual([]);
    expect(await db().shipmentEvent.count({ where: { shipmentId: stagedId! } })).toBe(0);
  });
  it('SSA05 withdrawal of the real shared customer range after native linked Shipment INSERT rolls the entire creation back', async () => {
    const f = await fixture('linked-late-l2-revocation', true), number = `SSA-${randomUUID()}`, before = await rows(f, number);
    let stagedId: string | undefined;
    const client = new Proxy(db(), { get(target, key) {
      if (key === '$transaction') return async (work: any, options: any) => target.$transaction(async (tx: any) => {
        const observed = new Proxy(tx, { get(storage, delegate) {
          if (delegate === 'shipment') return new Proxy(storage.shipment, { get(model, method) {
            if (method === 'create') return async (args: any) => {
              const created = await model.create(args); stagedId = created.id;
              expect(await tx.shipment.count({ where: { id: created.id } })).toBe(1);
              await db().teamDataGrant.delete({ where: { id: f.shareId } });
              return created;
            };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(storage, delegate); return typeof value === 'function' ? value.bind(storage) : value;
        } });
        return work(observed);
      }, options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const app = application(client), response = await request(app.app).post('/api/v1/shipping')
      .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ ...body(number), orderId: f.orderId });
    expect(stagedId).toBeTruthy(); expect(response.status, diagnostic(response.body)).toBe(404); expect(code(response)).toBe('ORDER_NOT_FOUND');
    safeBody(response); expect(await rows(f, number)).toEqual(before); expect(app.changes).toEqual([]);
    expect(await db().shipmentEvent.count({ where: { shipmentId: stagedId! } })).toBe(0);
    expect(await db().shipmentLine.count({ where: { shipmentId: stagedId! } })).toBe(0);
  });
});

// Packing v2 appendix. Append only after the complete pinned original module.
// Actual JWT/current grant/L2/source/SQL/FK producers execute in the original
// independently identified PG. Synthetic setup grants are not company role UAT.
const packingV2Actions = ['PACKING_LINES_REPLACE', 'PACKING_CARTONS_REPLACE', 'replace_shipment_packing', 'reject_shipment_packing'];
const packingV2Path = (ship: any) => '/api/v1/shipping/' + ship.id + '/packing';
const packingV2Put = (f: Fixture, ship: any, body: any, app = application(), actor = f.actor) =>
  request(app.app).put(packingV2Path(ship)).set('Authorization', 'Bearer ' + auth.signToken(actor)).send(body);
async function packingV2Read(f: Fixture, ship: any, app = application()) {
  const result = await request(app.app).get(packingV2Path(ship)).set('Authorization', 'Bearer ' + auth.signToken(f.actor));
  expect(result.status, diagnostic(result.body)).toBe(200);
  expect(result.body.shipment.id).toBe(ship.id); expect(result.body.context.kind).toBe('physical');
  expect(typeof result.body.context.updatedAt).toBe('string'); expect(result.body.context.allocationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  return result.body;
}
async function packingV2Fixture(label: string) {
  const f = await fixture('packing-v2-' + label), batch = await originalBatch(f);
  const receipt = await receive(f, batch, await receiptCommand(f, batch, '3.2501'));
  expect(receipt.status, diagnostic(receipt.body)).toBe(201);
  const ship = await draft(f), allocated = await post(f, ship,
    input(f, [await row(f, batch, '3.2501', '3.2501', receipt.body.receipt.id)], '3.2501', '3.2501'));
  expect(allocated.status, diagnostic(allocated.body)).toBe(201);
  const nativeReceipt = await db().productionStockReceipt.findUniqueOrThrow({ where: { id: receipt.body.receipt.id } });
  expect(nativeReceipt.productionBatchId).toBe(batch.id); expect(nativeReceipt.quantity.toString()).toBe('3.2501');
  return { f, batch, ship, receipt: nativeReceipt, allocated: allocated.body };
}
async function packingV2Body(item: Awaited<ReturnType<typeof packingV2Fixture>>, quantity = '3.2501', requestKey = randomUUID()) {
  const { f, ship } = item, snapshot = await packingV2Read(f, ship), source = snapshot.sources.find((row: any) => row.orderLineId === f.lineId);
  expect(source).toMatchObject({ orderLineId: f.lineId, orderId: f.orderId, unit: 'm', actualQty: '3.2501' });
  return { requestKey, expectedShipmentUpdatedAt: snapshot.context.updatedAt,
    expectedPhysicalAllocationFingerprint: snapshot.context.allocationFingerprint,
    lines: [{ clientLineKey: 'original-source-line', orderLineId: f.lineId, productCode: source.productCode, productName: 'Native exact source cloth',
      colorCode: 'SYNTHETIC-RED', quantity, unit: source.unit, cartons: 1, grossWeight: '1.234', netWeight: '1.001', volume: '0.001', hsCode: 'SYNTHETIC-HS', countryOfOrigin: 'CN' }],
    cartons: [{ cartonNo: 'ORIGINAL-BOX', description: 'Native original source packing', length: '10.01', width: '20', height: '30',
      grossWeight: '2.345', netWeight: '1.234', volume: '0.0001', items: [{ lineKey: 'original-source-line', quantity }] }] };
}
async function packingV2Facts(item: Awaited<ReturnType<typeof packingV2Fixture>>) {
  const { f, ship } = item;
  const inventory = await db().inventoryItem.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
  return { shipment: await db().shipment.findUniqueOrThrow({ where: { id: ship.id } }),
    lines: await db().shipmentLine.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    cartons: await db().shipmentCarton.findMany({ where: { shipmentId: ship.id }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    soa: await db().shipmentOrderAllocation.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    spa: await db().shipmentProductionAllocation.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    receipts: await db().productionStockReceipt.findMany({ where: { productionBatchId: item.batch.id }, orderBy: { id: 'asc' } }),
    inventory,
    movements: await db().stockMovement.findMany({ where: { OR: [{ itemId: { in: inventory.map(row => row.id) } }, { referenceType: 'Shipment', referenceId: ship.id }] }, orderBy: { id: 'asc' } }),
    events: await db().shipmentEvent.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    // Keep damaged target/actor records observable, rather than filtering them out.
    audits: await db().auditLog.findMany({ where: { actorId: { in: [f.userId, f.otherUserId] } }, orderBy: { id: 'asc' } }) };
}
async function packingV2KeyAudits(ship: any, requestKey: string) {
  const main = await db().auditLog.findFirst({ where: { action: 'replace_shipment_packing', targetType: 'Shipment', targetId: ship.id,
    detail: { path: ['after', 'command', 'requestKey'], equals: requestKey } } });
  expect(main).not.toBeNull(); expect(main!.transactionId).toMatch(/^packing_[a-f0-9]{64}$/);
  const rows = await db().auditLog.findMany({ where: { transactionId: { in: [main!.transactionId!, main!.transactionId! + ':lines', main!.transactionId! + ':cartons'] } } });
  expect(rows).toHaveLength(3); expect(rows.map(row => row.action).sort()).toEqual(packingV2Actions.slice(0, 3).sort());
  return { main: main!, rows };
}
async function packingV2Connection() {
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } }); connections.push(client);
  const identity = Prisma.sql`SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  expect(await client.$queryRaw(identity)).toEqual(await db().$queryRaw(identity));
  return client;
}
// This seam observes/faults the actual PG delegate. It never substitutes an
// authorization/source helper, transaction commit, business read or write.
function packingV2ObservedClient(client: PrismaClient, observer: (tx: any, delegate: PropertyKey, method: PropertyKey, args: any, invoke: () => Promise<any>) => Promise<any>, beforeWork?: (tx: any) => Promise<void>) {
  return new Proxy(client, { get(target, key) {
    if (key === '$transaction') return (work: any, options: any) => {
      if (typeof work !== 'function') throw Error('Packing observer requires the actual callback transaction');
      return target.$transaction(async (tx: any) => { await beforeWork?.(tx); return work(new Proxy(tx, { get(storage, delegate) {
        if (delegate === 'auditLog' || delegate === 'shipmentCartonItem') return new Proxy(Reflect.get(storage, delegate), { get(model, method) {
          if (method === 'create') return (args: any) => observer(tx, delegate, method, args, () => model.create(args));
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = Reflect.get(storage, delegate); return typeof value === 'function' ? value.bind(storage) : value;
      } })); }, options);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe.sequential('Packing v2 actual private PG HTTP aggregate and original receipt controls', () => {
  it('SPAP01 actual native line12,3/carton12,4 quantities and original source fields commit with three audits and a fact-bound replay', async () => {
    const item = await packingV2Fixture('exact-schema'), { f, ship } = item, body = await packingV2Body(item), before = await packingV2Facts(item);
    const invalid = await packingV2Put(f, ship, { ...body, lines: [{ ...body.lines[0], volume: '0.0001' }] });
    expect(invalid.status, diagnostic(invalid.body)).toBe(400); expect(code(invalid)).toBe('INVALID_INPUT'); safeBody(invalid);
    expect(await packingV2Facts(item)).toEqual(before);
    const saved = await packingV2Put(f, ship, body); expect(saved.status, diagnostic(saved.body)).toBe(200);
    expect(saved.body.replayed).toBe(false); expect(saved.body.lines[0]).toMatchObject({ orderLineId: f.lineId, quantity: '3.2501', unit: 'm',
      grossWeight: '1.234', netWeight: '1.001', volume: '0.001', colorCode: 'SYNTHETIC-RED', hsCode: 'SYNTHETIC-HS', countryOfOrigin: 'CN' });
    expect(saved.body.cartons[0]).toMatchObject({ volume: '0.0001', length: '10.01', grossWeight: '2.345' });
    expect(saved.body.cartons[0].items[0]).toMatchObject({ shipmentLineId: saved.body.lines[0].id, quantity: '3.2501' });
    const after = await packingV2Facts(item); expect(after.lines[0].volume!.toString()).toBe('0.001'); expect(after.cartons[0].volume!.toString()).toBe('0.0001');
    expect(after.shipment.updatedAt).toBeGreaterThan(BigInt(body.expectedShipmentUpdatedAt));
    expect(after.soa).toEqual(before.soa); expect(after.spa).toEqual(before.spa); expect(after.receipts).toEqual(before.receipts);
    expect(after.inventory).toEqual(before.inventory); expect(after.movements).toEqual(before.movements);
    const proof = await packingV2KeyAudits(ship, body.requestKey);
    expect(proof.main.detail).toMatchObject({ after: { acknowledgement: saved.body.acknowledgement } });
    const replay = await packingV2Put(f, ship, body); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.acknowledgement).toEqual(saved.body.acknowledgement); expect(await packingV2Facts(item)).toEqual(after);
  });
  it('SPAP02 actual second producer item FK and each mandatory audit actor FK failure roll back both collections/header/history, then the same original key retries', async () => {
    const item = await packingV2Fixture('fault-rollback'), { f, ship } = item;
    const seeded = await packingV2Put(f, ship, await packingV2Body(item)); expect(seeded.status, diagnostic(seeded.body)).toBe(200);
    const body = await packingV2Body(item, '2.0001'), before = await packingV2Facts(item);
    for (const fault of ['second-producer-item-fk', ...packingV2Actions.slice(0, 3)]) {
      let reached = false;
      const observed = packingV2ObservedClient(db(), async (tx, delegate, _method, args, invoke) => {
        if (fault === 'second-producer-item-fk' && delegate === 'shipmentCartonItem') {
          reached = true; expect(await tx.shipmentLine.count({ where: { shipmentId: ship.id } })).toBe(1);
          expect(await tx.shipmentCarton.count({ where: { id: args.data.cartonId, shipmentId: ship.id } })).toBe(1);
          expect(await tx.shipmentLine.count({ where: { id: before.lines[0].id } })).toBe(0);
          return tx.shipmentCartonItem.create({ ...args, data: { ...args.data, cartonId: prefix + '-actual-nonexistent-packing-carton' } });
        }
        if (delegate === 'auditLog' && args.data.action === fault) {
          reached = true; expect(await tx.shipmentLine.count({ where: { shipmentId: ship.id } })).toBe(1);
          expect(await tx.shipmentLine.count({ where: { id: before.lines[0].id } })).toBe(0);
          if (fault !== 'PACKING_LINES_REPLACE') expect(await tx.shipmentCartonItem.count({ where: { cartonId: { in: (await tx.shipmentCarton.findMany({ where: { shipmentId: ship.id }, select: { id: true } })).map((row: any) => row.id) } } })).toBe(1);
          return tx.auditLog.create({ ...args, data: { ...args.data, actorId: prefix + '-actual-nonexistent-audit-actor' } });
        }
        return invoke();
      });
      const app = application(observed), failed = await packingV2Put(f, ship, body, app);
      expect(reached, fault).toBe(true); expect(failed.status, diagnostic(failed.body)).toBe(500); expect(code(failed)).toBe('SAVE_FAILED'); safeBody(failed);
      expect(await packingV2Facts(item), fault).toEqual(before); expect(app.changes).toEqual([]);
    }
    const retried = await packingV2Put(f, ship, body); expect(retried.status, diagnostic(retried.body)).toBe(200);
    expect(retried.body.replayed).toBe(false); expect((await packingV2KeyAudits(ship, body.requestKey)).rows).toHaveLength(3);
  });
  it('SPAP03 same original command on two genuine PG connection transactions commits one line/box/item and three audits with an identical ACK', async () => {
    const item = await packingV2Fixture('same-key-concurrency'), body = await packingV2Body(item), clients = await Promise.all([packingV2Connection(), packingV2Connection()]);
    const pids: number[] = []; let release!: () => void;
    const bothEntered = new Promise<void>(resolve => { release = resolve; });
    const enter = async (tx: any) => {
      const [{ pid }] = await tx.$queryRaw(Prisma.sql`SELECT pg_backend_pid() AS pid`) as Array<{ pid: number }>; pids.push(pid);
      if (pids.length === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([bothEntered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('two actual packing transactions did not enter')), 3000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const results = await Promise.all(clients.map(client => packingV2Put(item.f, item.ship, body,
      application(packingV2ObservedClient(client, (_tx, _delegate, _method, _args, invoke) => invoke(), enter)))));
    expect(pids).toHaveLength(2); expect(new Set(pids).size).toBe(2);
    expect(results.map(result => result.status), diagnostic(results.map(result => result.body))).toEqual([200, 200]);
    expect(results.map(result => result.body.replayed).sort()).toEqual([false, true]);
    expect(results[0].body.acknowledgement).toEqual(results[1].body.acknowledgement); expect(results[0].body.lines).toEqual(results[1].body.lines);
    const actual = await packingV2Facts(item); expect(actual.lines).toHaveLength(1); expect(actual.cartons).toHaveLength(1); expect(actual.cartons[0].items).toHaveLength(1);
    expect(actual.audits.filter(row => packingV2Actions.includes(row.action))).toHaveLength(3);
    await packingV2KeyAudits(item.ship, body.requestKey);
  });
  it('SPAP04 later different-key native edit preserves the old original ACK and replay cannot overwrite the newer line/box/header', async () => {
    const item = await packingV2Fixture('later-edit'), firstBody = await packingV2Body(item, '3.0001'), first = await packingV2Put(item.f, item.ship, firstBody);
    expect(first.status, diagnostic(first.body)).toBe(200);
    const nextBody = await packingV2Body(item, '2.0001'), next = await packingV2Put(item.f, item.ship, nextBody); expect(next.status, diagnostic(next.body)).toBe(200);
    expect(next.body.lines[0].id).not.toBe(first.body.lines[0].id); expect(BigInt(next.body.shipment.updatedAt)).toBeGreaterThan(BigInt(first.body.shipment.updatedAt));
    const beforeReplay = await packingV2Facts(item), replay = await packingV2Put(item.f, item.ship, firstBody);
    expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true); expect(replay.body.acknowledgement).toEqual(first.body.acknowledgement);
    expect(replay.body.shipment.updatedAt).toBe(first.body.shipment.updatedAt); expect(replay.body.lines).toEqual(first.body.lines);
    expect(await packingV2Facts(item)).toEqual(beforeReplay); expect(beforeReplay.lines[0].quantity!.toString()).toBe('2.0001');
    expect(beforeReplay.audits.filter(row => packingV2Actions.includes(row.action))).toHaveLength(6);
  });
  it('SPAP05 deleting only synthetic main ACK with either/both original primitive audits retained keeps unknown and creates no refusal or replacement fact', async () => {
    for (const retained of ['lines', 'cartons', 'both']) {
      const item = await packingV2Fixture('orphan-' + retained), body = await packingV2Body(item), saved = await packingV2Put(item.f, item.ship, body);
      expect(saved.status, diagnostic(saved.body)).toBe(200); const proof = await packingV2KeyAudits(item.ship, body.requestKey);
      const removed = proof.rows.filter(row => row.id === proof.main.id || retained !== 'both' && row.action !== (retained === 'lines' ? 'PACKING_LINES_REPLACE' : 'PACKING_CARTONS_REPLACE'));
      expect((await db().auditLog.deleteMany({ where: { id: { in: removed.map(row => row.id) } } })).count).toBe(removed.length);
      const before = await packingV2Facts(item);
      for (const attempted of [body, { ...body, lines: [{ ...body.lines[0], quantity: '2.0001' }],
        cartons: [{ ...body.cartons[0], items: [{ ...body.cartons[0].items[0], quantity: '2.0001' }] }] }]) {
        const app = application(), refused = await packingV2Put(item.f, item.ship, attempted, app);
        expect(refused.status, diagnostic(refused.body)).toBe(409); expect(code(refused)).toBe('CONFLICT'); expect(refused.body.rejection).toBeUndefined(); safeBody(refused);
        expect(await packingV2Facts(item)).toEqual(before); expect(app.changes).toEqual([]);
        expect(await db().auditLog.count({ where: { actorId: item.f.userId, action: 'reject_shipment_packing' } })).toBe(0);
      }
    }
  });
  it('SPAP06 real PG JSON stable command anchor finds a moved main transactionId with wrong existing actor/target and no primitive audit, keeping unknown', async () => {
    const item = await packingV2Fixture('moved-main'), body = await packingV2Body(item), saved = await packingV2Put(item.f, item.ship, body);
    expect(saved.status, diagnostic(saved.body)).toBe(200); const proof = await packingV2KeyAudits(item.ship, body.requestKey);
    await db().auditLog.deleteMany({ where: { id: { in: proof.rows.filter(row => row.id !== proof.main.id).map(row => row.id) } } });
    await db().auditLog.update({ where: { id: proof.main.id }, data: { transactionId: 'synthetic-corrupt-' + randomUUID(), actorId: item.f.otherUserId,
      targetType: 'SyntheticWrongTarget', targetId: 'synthetic-corrupt-target-' + randomUUID() } });
    const before = await packingV2Facts(item);
    for (const attempted of [body, { ...body, lines: [{ ...body.lines[0], quantity: '2.0001' }],
      cartons: [{ ...body.cartons[0], items: [{ ...body.cartons[0].items[0], quantity: '2.0001' }] }] }]) {
      const app = application(), refused = await packingV2Put(item.f, item.ship, attempted, app);
      expect(refused.status, diagnostic(refused.body)).toBe(409); expect(code(refused)).toBe('CONFLICT'); expect(refused.body.rejection).toBeUndefined(); safeBody(refused);
      expect(await packingV2Facts(item)).toEqual(before); expect(app.changes).toEqual([]);
      expect(await db().auditLog.count({ where: { actorId: item.f.userId, action: 'reject_shipment_packing' } })).toBe(0);
    }
    expect((await db().auditLog.findUniqueOrThrow({ where: { id: proof.main.id } })).detail).toEqual(proof.main.detail);
  });
  it('SPAP07 signed empty ceiling and withdrawn actual current personal grant reject both new native commands and original replay without changing facts', async () => {
    const item = await packingV2Fixture('current-permission'), body = await packingV2Body(item), saved = await packingV2Put(item.f, item.ship, body);
    expect(saved.status, diagnostic(saved.body)).toBe(200); const next = await packingV2Body(item, '2.0001'), before = await packingV2Facts(item);
    for (const original of [body, next]) {
      const empty = await packingV2Put(item.f, item.ship, original, application(), { ...item.f.actor, permissionCeiling: [] });
      expect(empty.status, diagnostic(empty.body)).toBe(403); expect(code(empty)).toBe('FORBIDDEN'); safeBody(empty); expect(await packingV2Facts(item)).toEqual(before);
    }
    expect((await db().userPermissionOverrides.deleteMany({ where: { userId: item.f.userId, scope: 'shipments:write' } })).count).toBe(1);
    for (const original of [body, next]) {
      const revoked = await packingV2Put(item.f, item.ship, original);
      expect(revoked.status, diagnostic(revoked.body)).toBe(403); expect(code(revoked)).toBe('FORBIDDEN'); safeBody(revoked); expect(await packingV2Facts(item)).toEqual(before);
    }
  });
  it('SPAP08 actual grant withdrawal from a different PG backend after main ACK INSERT rolls back every staged packing fact/audit without waiting on held source rows', async () => {
    const item = await packingV2Fixture('late-grant'), { f, ship } = item;
    const seeded = await packingV2Put(f, ship, await packingV2Body(item)); expect(seeded.status, diagnostic(seeded.body)).toBe(200);
    const body = await packingV2Body(item, '2.0001'), before = await packingV2Facts(item), writer = await packingV2Connection(), revoker = await packingV2Connection();
    let stage!: (pid: number) => void, reached = false, stageTimer: ReturnType<typeof setTimeout> | undefined;
    const staged = new Promise<number>(resolve => { stage = resolve; });
    // This external transaction touches only a synthetic config grant row.
    // Current native authorization SELECTs do not row-lock that table. Bound
    // SQL lock/statement/transaction timeouts turn any unexpected block into a
    // failing control and release the observer; no source/Shipment lock is sought.
    const withdrawal = (async (): Promise<{ error?: unknown; writerPid?: number; revokerPid?: number; count?: number }> => {
      try {
        const writerPid = await Promise.race([staged, new Promise<never>((_resolve, reject) => { stageTimer = setTimeout(() => reject(Error('packing audit stage was not reached')), 3000); })]);
        if (stageTimer) clearTimeout(stageTimer);
        return await revoker.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'"); await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '1000ms'");
          const [{ pid: revokerPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          expect(revokerPid).not.toBe(writerPid);
          const deleted = await tx.userPermissionOverrides.deleteMany({ where: { userId: f.userId, scope: 'shipments:write' } });
          return { writerPid, revokerPid, count: deleted.count };
        }, { maxWait: 1000, timeout: 2000 });
      } catch (error) { return { error }; } finally { if (stageTimer) clearTimeout(stageTimer); }
    })();
    const observed = packingV2ObservedClient(writer, async (tx, delegate, _method, args, invoke) => {
      const actual = await invoke();
      if (delegate === 'auditLog' && args.data.action === 'replace_shipment_packing' && args.data.targetId === ship.id) {
        reached = true;
        expect(await tx.auditLog.count({ where: { id: actual.id } })).toBe(1);
        expect(await tx.shipmentLine.count({ where: { id: before.lines[0].id } })).toBe(0);
        expect(await tx.shipmentLine.count({ where: { shipmentId: ship.id } })).toBe(1);
        expect((await tx.shipment.findUniqueOrThrow({ where: { id: ship.id } })).updatedAt).toBeGreaterThan(before.shipment.updatedAt);
        const [{ pid }] = await tx.$queryRaw(Prisma.sql`SELECT pg_backend_pid() AS pid`) as Array<{ pid: number }>; stage(pid);
        const committed = await withdrawal; if (committed.error) throw committed.error; expect(committed.count).toBe(1);
      }
      return actual;
    });
    const app = application(observed), failed = await packingV2Put(f, ship, body, app), outside = await withdrawal;
    expect(reached).toBe(true); expect(outside.error).toBeUndefined(); expect(outside.writerPid).not.toBe(outside.revokerPid); expect(outside.count).toBe(1);
    expect(failed.status, diagnostic(failed.body)).toBe(403); expect(code(failed)).toBe('FORBIDDEN'); expect(failed.body.rejection).toBeUndefined(); safeBody(failed);
    expect(await packingV2Facts(item)).toEqual(before); expect(app.changes).toEqual([]);
    expect(await db().userPermissionOverrides.count({ where: { userId: f.userId, scope: 'shipments:write' } })).toBe(0);
  });
});
