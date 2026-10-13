/** Exact index.ts Number hooks over actual native HTTP + isolated PG.
 * Initial accounts/customer/warehouse/unapproved Order/Line are synthetic.
 * Every controlled sample, seal, line version, batch, receipt, movement and
 * allocation is established by its real producer. No index startup/seed/job
 * or shared company database is run. The copied source fixture below is
 * deliberately independent of existing tests, which remain byte-identical. */
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exactJsonValue } from '../src/lib/exactJsonValue';
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

const prefix = `acceptance-physical-index-json-${randomUUID()}`;
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
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', quantity: totalQuantity, unit: 'PC',
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
  return { batchCode: `${f.id}-${label}`, quantity, unit: 'PC', expectedLineFingerprint: (await listing(f)).body.lineFingerprint, requestKey: randomUUID() };
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
    warehouseId: f.warehouseId, quantity, unit: 'PC', movementDate: '2099-10-02',
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
  return { productionBatchId: batch.id, expectedRevision: batch.revision, expectedScopeFingerprint: current.body.scopeFingerprint, stockReceiptId, plannedQty, actualQty, unit: 'PC' };
}
const input = (f: Fixture, rows: any[], plannedQty: string | null, actualQty: string | null = null) => ({ orderId: f.orderId, orderLineId: f.lineId,
  plannedQty, actualQty, unit: 'PC', requestKey: randomUUID(), productionBatchAllocations: rows });
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

const bigintPrototype = BigInt.prototype as unknown as { toJSON?: () => unknown };
const decimalPrototype = Prisma.Decimal.prototype as unknown as { toJSON?: () => unknown };
const initialBigintDescriptor = Object.getOwnPropertyDescriptor(bigintPrototype, 'toJSON');
const initialDecimalDescriptor = Object.getOwnPropertyDescriptor(decimalPrototype, 'toJSON');
function restoreDescriptor(target: object, key: string, prior?: PropertyDescriptor) {
  if (prior) Object.defineProperty(target, key, prior); else delete (target as any)[key];
}
async function withIndexNumberHooks<T>(work: () => Promise<T>): Promise<T> {
  const bigint = Object.getOwnPropertyDescriptor(bigintPrototype, 'toJSON');
  const decimal = Object.getOwnPropertyDescriptor(decimalPrototype, 'toJSON');
  // Faithful index.ts:438-450, without invoking seeds, scheduler, or listener.
  bigintPrototype.toJSON = function (this: bigint) { return Number(this); };
  decimalPrototype.toJSON = function decimalToNumberJSON(this: Prisma.Decimal) { return Number(this); };
  try {
    expect(JSON.stringify({ bigint: BigInt(100), decimal: new Prisma.Decimal('3.2501') }))
      .toBe('{"bigint":100,"decimal":3.2501}');
    expect(decimalPrototype.toJSON!.name).toBe('decimalToNumberJSON');
    return await work();
  } finally {
    restoreDescriptor(bigintPrototype, 'toJSON', bigint);
    restoreDescriptor(decimalPrototype, 'toJSON', decimal);
  }
}
afterEach(() => {
  expect(Object.getOwnPropertyDescriptor(bigintPrototype, 'toJSON')).toEqual(initialBigintDescriptor);
  expect(Object.getOwnPropertyDescriptor(decimalPrototype, 'toJSON')).toEqual(initialDecimalDescriptor);
});
const exact = (value: unknown) => JSON.parse(JSON.stringify(exactJsonValue(value)));
async function sourceFacts(f: Fixture) {
  const receipts = await db().productionStockReceipt.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
  const items = await db().inventoryItem.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } });
  return exact({ receipts, items,
    movements: await db().stockMovement.findMany({ where: { itemId: { in: items.map(x => x.id) } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { action: 'receive_production_batch_stock', targetId: { in: receipts.map(x => x.id) } }, orderBy: { id: 'asc' } }),
    reports: await db().inspectionReport.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    stages: await db().productionStage.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
  });
}
async function completeFacts(f: Fixture, ship: any) {
  return exact({ source: await sourceFacts(f), ...await facts(f), shipment: await db().shipment.findUniqueOrThrow({ where: { id: ship.id } }),
    lines: await db().shipmentLine.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    cartons: await db().shipmentCarton.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }) });
}
async function prepared(label: string, qty = '100') {
  const f = await fixture('index-' + label, false, qty, qty === '100' ? 100 : 1);
  const batch = await originalBatch(f, qty), ship = await draft(f), receiveBody = await receiptCommand(f, batch, qty);
  return { f, batch, ship, receiveBody };
}
async function received(label: string, qty = '100') {
  const item = await prepared(label, qty), receipt = await receive(item.f, item.batch, item.receiveBody);
  expect(receipt.status, diagnostic(receipt.body)).toBe(201);
  const allocationBody = input(item.f, [await row(item.f, item.batch, qty, qty, receipt.body.receipt.id)], qty, qty);
  return { ...item, receipt, allocationBody };
}
function allocationAckAudit(audit: any, ack: any) {
  const { acknowledgement, ...canonicalAck } = ack;
  expect(acknowledgement).toEqual({ schemaVersion: 1, allocationHash: qcReportSourceFingerprint({ ...canonicalAck, replayed: false }) });
  expect(audit.detail.after.ack).toEqual(canonicalAck);
  expect(audit.detail).toMatchObject({ source: 'route:shipping:physical-allocation', after: {
    schemaVersion: 1, allocationId: ack.id, requestKey: ack.requestKey, commandHash: ack.commandHash,
    ack: canonicalAck, ackHash: qcReportSourceFingerprint(canonicalAck),
  } });
  expect(typeof audit.detail.after.ack.createdAt).toBe('string');
  expect(typeof audit.detail.after.ack.updatedAt).toBe('string');
  expect(audit.detail.after.ack.productionBatchAllocations[0]).toMatchObject({ plannedQty: ack.plannedQty, actualQty: ack.actualQty });
}

describe.sequential('actual native shipment consumes frozen production receipt under exact index Number hooks', () => {
  it('INDEXSPA01 original100PC receipt reserves100PC exactly; original stock, Inbound and audit stay immutable, and both original keys replay without duplicates', async () => {
    await withIndexNumberHooks(async () => {
      const item = await received('one-hundred'), { f, batch, ship, receipt, allocationBody } = item;
      const before = await sourceFacts(f);
      expect(receipt.body.receipt.quantity).toBe('100'); expect(receipt.body.movement.quantity).toBe('100');
      const made = await post(f, ship, allocationBody);
      expect(made.status, diagnostic(made.body)).toBe(201);
      expect(made.body).toMatchObject({ plannedQty: '100', actualQty: '100', unit: 'PC', replayed: false, allocationVersion: 1 });
      expect(made.body.productionBatchAllocations).toHaveLength(1);
      expect(made.body.productionBatchAllocations[0]).toMatchObject({ productionBatchId: batch.id, plannedQty: '100', actualQty: '100', unit: 'PC', state: 'reserved' });
      expect((made.body.productionBatchAllocations[0].scopeSnapshot.receiptAllocations)).toMatchObject([{
        stockReceiptId: receipt.body.receipt.id, inventoryItemId: receipt.body.inventoryItem.id, warehouseId: f.warehouseId,
        plannedQty: '100', actualQty: '100', unit: 'PC',
      }]);
      const created = await facts(f); expect(created.allocations).toHaveLength(1); expect(created.physical).toHaveLength(1); expect(created.audits).toHaveLength(1);
      allocationAckAudit(created.audits[0], made.body);
      const frozen = await completeFacts(f, ship);
      const originalReceipt = await receive(f, batch, item.receiveBody);
      expect(originalReceipt.status, diagnostic(originalReceipt.body)).toBe(200); expect(originalReceipt.body).toEqual({ ...receipt.body, replayed: true });
      const originalAllocation = await post(f, ship, allocationBody);
      expect(originalAllocation.status, diagnostic(originalAllocation.body)).toBe(200); expect(originalAllocation.body).toEqual({ ...made.body, replayed: true });
      expect(await completeFacts(f, ship)).toEqual(frozen); expect(await sourceFacts(f)).toEqual(before);
      expect(before.receipts).toHaveLength(1); expect(before.items).toHaveLength(1); expect(before.movements).toHaveLength(1);
      expect(before.movements[0]).toMatchObject({ type: 'Inbound', quantity: '100', balanceBefore: '0', balanceAfter: '100' });
      expect(before.reports).toEqual([]); expect(before.stages).toEqual([]);
    });
  });
  it('INDEXSPA02 native note PATCH validates latest history and freezes exact before/after; real packing consumer revalidates receipt without touching inventory', async () => {
    await withIndexNumberHooks(async () => {
      const { f, ship, allocationBody } = await received('latest-history'), beforeSource = await sourceFacts(f);
      const made = await post(f, ship, allocationBody); expect(made.status, diagnostic(made.body)).toBe(201);
      const update = { batchOrCartonNote: 'Explicit original reservation note', expectedAllocationUpdatedAt: made.body.updatedAt, requestKey: randomUUID() };
      const changed = await patchAllocation(f, ship, made.body.id, update);
      expect(changed.status, diagnostic(changed.body)).toBe(200); expect(changed.body.allocationVersion).toBe(2);
      const audits = (await facts(f)).audits, second = audits.find(a => a.action === 'update_physical_shipment_allocation')!;
      allocationAckAudit(second, changed.body);
      expect(second.detail).toMatchObject({ before: { allocation: { plannedQty: '100', actualQty: '100', createdAt: made.body.createdAt, updatedAt: made.body.updatedAt },
        productionBatchAllocations: made.body.productionBatchAllocations, allocationVersion: 1 } });
      const packingPath = `/api/v1/shipping/${ship.id}/packing`;
      const context = await request(application().app).get(packingPath).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
      expect(context.status, diagnostic(context.body)).toBe(200);
      expect(context.body.context.kind).toBe('physical'); expect(context.body.sources).toMatchObject([{ orderLineId: f.lineId, orderId: f.orderId, unit: 'PC', actualQty: '100' }]);
      const packBody = { requestKey: randomUUID(), expectedShipmentUpdatedAt: context.body.context.updatedAt,
        expectedPhysicalAllocationFingerprint: context.body.context.allocationFingerprint, lines: [], cartons: [] };
      const packed = await request(application().app).put(packingPath).set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send(packBody);
      expect(packed.status, diagnostic(packed.body)).toBe(200);
      expect(packed.body.lines).toEqual([]); expect(packed.body.cartons).toEqual([]);
      const replay = await patchAllocation(f, ship, made.body.id, update);
      expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toEqual({ ...changed.body, replayed: true });
      expect(await sourceFacts(f)).toEqual(beforeSource);
    });
  });
  it('INDEXSPA03 maximumDecimal18_4 and unsafe-integer native stamps remain exact strings through receipt, allocation, latest history and original replay', async () => {
    await withIndexNumberHooks(async () => {
      const qty = '99999999999999.9999', item = await prepared('decimal-stamp-boundary', qty), { f, batch, ship } = item;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(9007199254740992);
      try {
        const receipt = await receive(f, batch, item.receiveBody); expect(receipt.status, diagnostic(receipt.body)).toBe(201);
        expect(receipt.body.receipt).toMatchObject({ quantity: qty, createdAt: '9007199254740992' });
        expect(receipt.body.movement).toMatchObject({ quantity: qty, balanceAfter: qty });
        const sourceBefore = await sourceFacts(f), body = input(f, [await row(f, batch, qty, qty, receipt.body.receipt.id)], qty, qty);
        const made = await post(f, ship, body); expect(made.status, diagnostic(made.body)).toBe(201);
        expect(made.body).toMatchObject({ plannedQty: qty, actualQty: qty, createdAt: '9007199254740992', updatedAt: '9007199254740992' });
        const update = { batchOrCartonNote: 'Native BigInt increment beyond Number safe range', expectedAllocationUpdatedAt: made.body.updatedAt, requestKey: randomUUID() };
        const changed = await patchAllocation(f, ship, made.body.id, update); expect(changed.status, diagnostic(changed.body)).toBe(200);
        expect(changed.body.updatedAt).toBe('9007199254740993'); expect(changed.body.productionBatchAllocations[0].updatedAt).toBe('9007199254740993');
        const reread = await request(application().app).get(postPath(ship)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
        expect(reread.status, diagnostic(reread.body)).toBe(200);
        expect(reread.body.items[0]).toMatchObject({ plannedQty: qty, actualQty: qty, updatedAt: '9007199254740993' });
        const audit = (await facts(f)).audits.find(a => a.action === 'update_physical_shipment_allocation')!; allocationAckAudit(audit, changed.body);
        const replay = await patchAllocation(f, ship, made.body.id, update); expect(replay.status).toBe(200); expect(replay.body).toEqual({ ...changed.body, replayed: true });
        expect(await sourceFacts(f)).toEqual(sourceBefore);
      } finally { clock.mockRestore(); }
    });
  });
  it.each(['receipt', 'receipt-audit', 'inbound'] as const)('INDEXSPA04-%s tampering still refuses native actual allocation and leaves every other original fact intact', async kind => {
    await withIndexNumberHooks(async () => {
      const { f, ship, receipt, allocationBody } = await received('tamper-' + kind), receiptId = receipt.body.receipt.id;
      if (kind === 'receipt') {
        const stored = await db().productionStockReceipt.findUniqueOrThrow({ where: { id: receiptId } });
        await db().productionStockReceipt.update({ where: { id: receiptId }, data: { createdAt: stored.createdAt + BigInt(1) } });
      } else if (kind === 'receipt-audit') {
        const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'receive_production_batch_stock', targetId: receiptId } }), detail = exact(audit.detail);
        detail.after.receipt.receipt.quantity = '99'; await db().auditLog.update({ where: { id: audit.id }, data: { detail } });
      } else {
        await db().stockMovement.update({ where: { id: receipt.body.movement.id }, data: { reason: 'Synthetic tampered original Inbound description' } });
      }
      const before = await completeFacts(f, ship), refused = await post(f, ship, allocationBody);
      expect(refused.status, diagnostic(refused.body)).toBe(409); expect(code(refused)).toBe('CONFLICT'); safeBody(refused);
      expect(await completeFacts(f, ship)).toEqual(before); expect((await facts(f)).allocations).toEqual([]); expect((await facts(f)).physical).toEqual([]);
    });
  });
  it('INDEXSPA05 real mandatory allocation audit FK failure rolls back native reservation and original facts under Number hooks, then same key retries once', async () => {
    await withIndexNumberHooks(async () => {
      const { f, ship, allocationBody } = await received('mandatory-rollback'), before = await completeFacts(f, ship), probe = { reached: false };
      const rejected = await post(f, ship, allocationBody, application(auditFailure(probe)));
      expect(probe.reached).toBe(true); expect(rejected.status, diagnostic(rejected.body)).toBe(500); safeBody(rejected);
      expect(await completeFacts(f, ship)).toEqual(before);
      const made = await post(f, ship, allocationBody); expect(made.status, diagnostic(made.body)).toBe(201);
      const replay = await post(f, ship, allocationBody); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toEqual({ ...made.body, replayed: true });
      expect((await facts(f)).allocations).toHaveLength(1); expect((await facts(f)).physical).toHaveLength(1); expect((await facts(f)).audits).toHaveLength(1);
      expect(await sourceFacts(f)).toEqual(before.source);
    });
  });
  it('INDEXSPA06 current revoke and signed empty ceiling still refuse original allocation replay as well as fresh commands, without any stock or allocation write', async () => {
    await withIndexNumberHooks(async () => {
      const { f, ship, allocationBody } = await received('current-authority'), made = await post(f, ship, allocationBody);
      expect(made.status, diagnostic(made.body)).toBe(201); const before = await completeFacts(f, ship);
      expect((await post(f, ship, allocationBody, application(), { ...f.actor, permissionCeiling: [] })).status).toBe(403);
      await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: false } });
      expect((await post(f, ship, allocationBody)).status).toBe(403);
      expect((await post(f, ship, { ...allocationBody, requestKey: randomUUID() })).status).toBe(403);
      expect(await completeFacts(f, ship)).toEqual(before);
    });
  });
  it('INDEXSPA07 successful and throwing native hook scopes restore both complete global descriptors', async () => {
    const sentinel = new Error('Synthetic hook-body failure');
    await expect(withIndexNumberHooks(async () => { throw sentinel; })).rejects.toBe(sentinel);
    expect(Object.getOwnPropertyDescriptor(bigintPrototype, 'toJSON')).toEqual(initialBigintDescriptor);
    expect(Object.getOwnPropertyDescriptor(decimalPrototype, 'toJSON')).toEqual(initialDecimalDescriptor);
    await withIndexNumberHooks(async () => { expect(exact({ quantity: new Prisma.Decimal('99999999999999.9999'), stamp: BigInt('9007199254740993') }))
      .toEqual({ quantity: '99999999999999.9999', stamp: '9007199254740993' }); });
  });
});
