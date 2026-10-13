import { issueShipmentInvoiceDrafts } from '../src/events/linkages/L3IssueInvoice';
import { qcReportSourceFingerprint } from '../src/qc/qcReportAuthority';
import { createQcRouter } from '../src/qc/qcRoute';
import { createSample, advanceSampleStage } from '../src/samples/sampleManageService';
/** Actual isolated PG financial handoff RED controls. Initial accounts, exact
 * personal grants, configured warehouses and unapproved Orders/Lines are
 * technical fixtures. Fabric standards, actual stock receipts, scoped Final,
 * S/S, dispatch, invoices, Receipt and reconciliation are native producers.
 * No SQL creates approval, received stock, shipping or financial facts.
 * The financial amount remains an explicit business amount, never inferred
 * from physical quantity. This suite is not whole-V1 or default-role/browser UAT.
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
import { createFinanceRouter } from '../src/finance/route';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-shipment-financial-${randomUUID()}`;
const auth = createAuthService();
let prisma: PrismaClient | undefined, sequence = 0;
function db(): PrismaClient { if (!prisma) throw Error('Private financial handoff PG identity not verified'); return prisma; }
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
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string, shared = false, totalQuantity = '10', initialLegacyHeaderQuantity = 10) {
  const id = `${prefix}-${++sequence}-${label}`, now = BigInt(Date.now()), userId = `${id}-user`,
    customerId = `${id}-customer`, supplierId = `${id}-factory`, caseId = `${id}-case`,
    orderId = `${id}-order`, lineId = `${id}-line`, otherUserId = `${id}-other-user`, teamId = `${id}-team`, shareId = `${id}-share`;
  await db().$transaction(async tx => {
    for (const uid of [userId, otherUserId]) await tx.userAccount.create({ data: { id: uid, displayName: 'Synthetic current account', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'manager' } });
    await tx.userPermissionOverrides.createMany({ data: [
      'orders:read', 'orders:write', 'products:read', 'products:write', 'production:read', 'inventory:read', 'inventory:write', 'shipments:read', 'shipments:write', 'invoices:read', 'invoices:write', 'invoices:reconcile', 'vouchers:read', 'vouchers:write',
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
  app.use('/api/v1/finance', createFinanceRouter({ prisma: client, requireAuth: true, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
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

async function draft(f: Fixture) {
  const r = await request(application().app).post('/api/v1/shipping').set('Authorization', `Bearer ${auth.signToken(f.actor)}`)
    .send({ type: 'Export', shippingMethod: 'Sea', status: 'Draft', customerRelationId: f.customerId, customerName: f.customerId, notes: 'Synthetic draft only; no factory/shipment/QC fact' });
  expect(r.status, diagnostic(r.body)).toBe(201); expect(r.body.status).toBe('Draft'); return r.body;
}
const postPath = (ship: any) => `/api/v1/shipping/${ship.id}/allocations`;
const post = (f: Fixture, ship: any, body: any, app = application(), actor = f.actor) => request(app.app).post(postPath(ship)).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function row(f: Fixture, batch: any, plannedQty: string | null, actualQty: string | null = null, stockReceiptId: string | null = null) {
  const current = await request(application().app).get(receiptPath(batch.id)).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200);
  return { productionBatchId: batch.id, expectedRevision: batch.revision, expectedScopeFingerprint: current.body.scopeFingerprint, stockReceiptId, plannedQty, actualQty, unit: 'm' };
}
const input = (f: Fixture, rows: any[], plannedQty: string | null, actualQty: string | null = null) => ({ orderId: f.orderId, orderLineId: f.lineId,
  plannedQty, actualQty, unit: 'm', requestKey: randomUUID(), productionBatchAllocations: rows });

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
async function consumerFixture(label: string, booked = true, beforeNative?: (f: Fixture, ship: any) => Promise<void>) {
  const f = await fixture(label), earlyShip = beforeNative ? await draft(f) : null;
  if (beforeNative) await beforeNative(f, earlyShip);
  const batch = await originalBatch(f);
  const firstCommand = await receiptCommand(f, batch, '3.2501'), first = await receive(f, batch, firstCommand);
  expect(first.status, diagnostic(first.body)).toBe(201);
  const now = BigInt(Date.now()), secondWarehouseId = `${f.id}-WH2`;
  await db().warehouse.create({ data: { id: secondWarehouseId, code: secondWarehouseId, name: 'Configured second synthetic warehouse', type: 'Other', isActive: true, createdAt: now, updatedAt: now } });
  const secondCommand = { ...await receiptCommand(f, batch, '6.7499'), warehouseId: secondWarehouseId }, second = await receive(f, batch, secondCommand);
  expect(second.status, diagnostic(second.body)).toBe(201);
  const ship = earlyShip ?? await draft(f), rows = [await row(f, batch, '3.2501', '3.2501', first.body.receipt.id),
    await row(f, batch, '4.25', '4.25', second.body.receipt.id)];
  const allocated = await post(f, ship, input(f, rows, '7.5001', '7.5001'));
  expect(allocated.status, diagnostic(allocated.body)).toBe(201);
  const packing = await request(application().app).post(`/api/v1/shipping/${ship.id}/lines/pull-from-order`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(packing.status, diagnostic(packing.body)).toBe(200); expect(packing.body.lines[0].quantity).toBe('7.5001');
  const report = await qualifiedFinal(f, batch), sample = await confirmedShipSample(f);
  // Preserve the real state machine: this control must use native booking
  // before it reaches dispatch, not weaken Draft -> Shipped to reach the gate.
  if (booked) await book(f, ship);
  return { f, batch, first: first.body.receipt, second: second.body.receipt, ship, allocated: allocated.body, report, sample };
}

async function book(f: Fixture, ship: any) {
  const result = await patchShip(f, ship, await physicalCommand(f, ship, { status: 'Booked' }));
  expect(result.status, diagnostic(result.body)).toBe(200); expect(result.body.status).toBe('Booked');
}
type Consumer = Awaited<ReturnType<typeof consumerFixture>>;
async function dispatch(item: Consumer) {
  const { f, ship, first, second } = item;
  const result = await patchShip(f, ship, await physicalCommand(f, ship, dispatchPatch));
  expect(result.status, diagnostic(result.body)).toBe(200); expect(result.body.status).toBe('Shipped');
  const movements = await db().stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: ship.id }, orderBy: { id: 'asc' } });
  expect(movements).toHaveLength(2); expect(movements.every(m => m.type === 'Outbound')).toBe(true);
  expect(movements.map(m => m.quantity.toString()).sort()).toEqual(['3.2501', '4.25']);
  expect(new Set(movements.map(m => m.warehouseId))).toEqual(new Set([first.warehouseId, second.warehouseId]));
  const stock = await db().inventoryItem.findMany({ where: { orderId: f.orderId } });
  expect(stock.reduce((sum, r) => sum.plus(r.quantity), new Prisma.Decimal(0)).toString()).toBe('2.4999');
  return result;
}
async function financialBatch(f: Fixture, amount = '10', overrides: Record<string, unknown> = {}) {
  // No inferred financial amount or fabricated receipts. Explicit false is
  // supported by the native plan validator and prevents automatic final-batch
  // designation; separate final-gate controls below retain the default gate.
  const made = await request(application().app).post('/api/v1/shipping/order-batches').set('Authorization', `Bearer ${auth.signToken(f.actor)}`)
    .send({ orderId: f.orderId, amount, currency: 'USD', plannedQty: '7.5001', unit: 'm', isFinalBatch: false,
      notes: 'Explicit synthetic financial plan amount; no physical proportional split', ...overrides });
  expect(made.status, diagnostic(made.body)).toBe(201); expect(made.body.ok).toBe(true);
  const saved = await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: made.body.batch.id } });
  expect(saved).toMatchObject({ orderId: f.orderId, status: 'planned', shipmentId: null, isFinalBatch: overrides.isFinalBatch === true });
  expect(saved.amount?.toString()).toBe(new Prisma.Decimal(amount).toString()); return saved;
}
async function markCommand(f: Fixture, batch: any, ship: any) {
  const currentBatch = await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: batch.id } });
  const current = await request(application().app).get(`/api/v1/shipping/${ship.id}/physical-context`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`);
  expect(current.status, diagnostic(current.body)).toBe(200); expect(current.body.kind).toBe('physical');
  expect(typeof current.body.updatedAt).toBe('string'); expect(current.body.allocationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  return { shipmentId: ship.id, shippedAt: '1790899200000', requestKey: randomUUID(),
    expectedBatchUpdatedAt: currentBatch.updatedAt.toString(), expectedShipmentUpdatedAt: current.body.updatedAt,
    expectedPhysicalAllocationFingerprint: current.body.allocationFingerprint };
}
const mark = (f: Fixture, batch: any, body: any, app = application(), actor = f.actor) => request(app.app)
  .post(`/api/v1/shipping/order-batches/${batch.id}/mark-shipped`).set('Authorization', `Bearer ${auth.signToken(actor)}`).send(body);
async function financialRecords(f: Fixture) {
  const invoices = await db().invoice.findMany({ where: { customerRelationId: f.customerId }, orderBy: { id: 'asc' } });
  const vouchers = await db().paymentVoucher.findMany({ where: { customerRelationId: f.customerId }, orderBy: { id: 'asc' } });
  return { batches: await db().orderShipmentBatch.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }), invoices, vouchers,
    orderAllocations: await db().invoiceOrderAllocation.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    settlements: await db().invoiceAllocation.findMany({ where: { OR: [{ invoiceId: { in: invoices.map(r => r.id) } }, { voucherId: { in: vouchers.map(r => r.id) } }] }, orderBy: { id: 'asc' } }) };
}
async function allFacts(f: Fixture, ship: any) {
  return { ...await financialRecords(f), shipment: await db().shipment.findUniqueOrThrow({ where: { id: ship.id } }),
    physical: await (db() as PrismaClient & { shipmentProductionAllocation: { findMany(input: unknown): Promise<unknown[]> } }).shipmentProductionAllocation.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    allocations: await db().shipmentOrderAllocation.findMany({ where: { shipmentId: ship.id }, orderBy: { id: 'asc' } }),
    inventory: await db().inventoryItem.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    movements: await db().stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: ship.id }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.userId }, orderBy: { id: 'asc' } }) };
}
const markAudits = (batchId: string) => db().auditLog.findMany({ where: { targetType: 'OrderShipmentBatch', targetId: batchId,
  action: 'mark_batch_shipped' }, orderBy: { id: 'asc' } });
const financePost = (f: Fixture, suffix: string, body: any, app = application()) => request(app.app)
  .post(`/api/v1/finance${suffix}`).set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send(body);
function invoiceInput(f: Fixture, batchId: string | null, amount = '10', label: string = randomUUID()) {
  return { invoiceNumber: `${f.id}-invoice-${label}`, type: 'Receivable', status: 'Draft', amount, currency: 'USD', issueDate: '2026-10-02',
    orderId: f.orderId, customerRelationId: f.customerId, customerName: f.customerId,
    orderAllocations: [{ orderId: f.orderId, batchId, allocatedAmount: amount, note: 'Explicit software acceptance allocation amount' }] };
}
async function invoice(f: Fixture, batchId: string | null, amount = '10', label: string = randomUUID()) {
  const made = await financePost(f, '', invoiceInput(f, batchId, amount, label));
  expect(made.status, diagnostic(made.body)).toBe(201);
  const saved = await db().invoice.findUniqueOrThrow({ where: { id: made.body.id } });
  expect(saved).toMatchObject({ status: 'Draft', type: 'Receivable' });
  expect(saved.amount.toString()).toBe(new Prisma.Decimal(amount).toString());
  const allocation = await db().invoiceOrderAllocation.findFirstOrThrow({ where: { invoiceId: saved.id, orderId: f.orderId, deletedAt: null } });
  expect(allocation.batchId).toBe(batchId); expect(allocation.allocatedAmount?.toString()).toBe(new Prisma.Decimal(amount).toString());
  return saved;
}
async function settlePartially(f: Fixture, originalInvoice: any, amount = '3.0001') {
  const issued = await request(application().app).patch(`/api/v1/finance/${originalInvoice.id}`)
    .set('Authorization', `Bearer ${auth.signToken(f.actor)}`).send({ status: 'Issued' });
  expect(issued.status, diagnostic(issued.body)).toBe(200); expect(issued.body.status).toBe('Issued');
  const receipt = await financePost(f, '/vouchers', { type: 'Receipt', amount, currency: 'USD', customerRelationId: f.customerId,
    customerName: f.customerId, paymentDate: '2026-10-02', paymentMethod: 'TT',
    attachments: { paymentReference: `${f.id}-synthetic-receipt` }, notes: 'Synthetic native financial receipt; no external bank transfer' });
  expect(receipt.status, diagnostic(receipt.body)).toBe(201);
  expect(await db().paymentVoucher.findUniqueOrThrow({ where: { id: receipt.body.id } })).toMatchObject({ type: 'Receipt', status: 'unreconciled' });
  const applied = await financePost(f, '/allocations', { invoiceId: originalInvoice.id, voucherId: receipt.body.id, appliedAmount: amount, appliedDate: '2026-10-02' });
  expect(applied.status, diagnostic(applied.body)).toBe(201);
  const settlement = await db().invoiceAllocation.findUniqueOrThrow({ where: { id: applied.body.allocation.id } });
  expect(settlement.appliedAmount.toString()).toBe(amount);
  expect(await db().invoice.findUniqueOrThrow({ where: { id: originalInvoice.id } })).toMatchObject({ status: 'PartiallyPaid' });
  return { settlement, voucherId: receipt.body.id };
}
async function anotherUnapprovedOrder(f: Fixture, label: string) {
  const orderId = `${f.id}-${label}-order`, lineId = `${f.id}-${label}-line`, now = BigInt(Date.now());
  // Technical unapproved origin only. No native source, stock, shipping,
  // permission or financial state is invented here.
  await db().$transaction(async tx => {
    await tx.order.create({ data: { id: orderId, poNumber: orderId, customer: f.customerId, customerRelationId: f.customerId,
      product: 'Synthetic separate fabric order', type: 'fabric', quantity: 10, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 10,
      ownerId: f.userId, millRelationId: f.supplierId, sourceCaseId: f.caseId, importedAt: now, updatedAt: now } });
    await tx.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0020', quantity: '10', unit: 'm', description: 'Explicit synthetic other order',
      tolerancePercent: '25', toleranceSource: 'line_override' } });
  });
  return { ...f, orderId, lineId };
}

// This first independent native scope freezes denial/replay/cancellation
// controls. Original 29 physical shipment controls remain untouched.
describe('Actual native shipment to financial handoff', () => {
  it('SF01 Draft and Booked have genuine reserved stock but cannot mark an OSB shipped or mutate any settlement snapshot', async () => {
    const item = await consumerFixture('draft-booked', false), { f, ship } = item, batch = await financialBatch(f);
    for (const state of ['Draft', 'Booked']) {
      if (state === 'Booked') await book(f, ship);
      expect((await db().shipment.findUniqueOrThrow({ where: { id: ship.id } })).status).toBe(state);
      const before = await allFacts(f, ship), result = await mark(f, batch, await markCommand(f, batch, ship));
      expect(result.status, diagnostic(result.body)).toBe(409); expect(code(result)).toBe('CONFLICT');
      expect(await allFacts(f, ship)).toEqual(before); expect(await markAudits(batch.id)).toHaveLength(0);
    }
  });
  it('SF02 a genuine dispatched ticket for another visible order cannot lend its actual stock to this financial order', async () => {
    const item = await consumerFixture('cross-order'), { f, ship } = item; await dispatch(item);
    const other = await anotherUnapprovedOrder(f, 'other'), batch = await financialBatch(other), before = await allFacts(other, ship);
    const result = await mark(other, batch, await markCommand(other, batch, ship));
    expect(result.status, diagnostic(result.body)).toBe(409); expect(code(result)).toBe('CONFLICT');
    expect(await allFacts(other, ship)).toEqual(before); expect(await markAudits(batch.id)).toHaveLength(0);
  });
  it('SF03 an explicit same-ticket double-zero order association is preserved but cannot borrow another order positive actual quantity', async () => {
    let other!: Fixture, linked: any;
    // The real legacy producer accepts this zero association before any native
    // production batch exists. Once a batch exists the same endpoint correctly
    // refuses a legacy fallback, so establish history in its actual chronology.
    const item = await consumerFixture('zero-actual', true, async (f, ship) => {
      other = await anotherUnapprovedOrder(f, 'zero');
      linked = await post(other, ship, { orderId: other.orderId, orderLineId: other.lineId, plannedQty: '0', actualQty: '0', unit: 'm' });
    }), { f, ship } = item;
    expect(linked.status, diagnostic(linked.body)).toBe(201);
    expect(await db().shipmentOrderAllocation.findUniqueOrThrow({ where: { id: linked.body.id } })).toMatchObject({ orderId: other.orderId });
    await dispatch(item);
    const batch = await financialBatch(other), before = await allFacts(other, ship);
    const result = await mark(other, batch, await markCommand(other, batch, ship));
    expect(result.status, diagnostic(result.body)).toBe(409); expect(code(result)).toBe('CONFLICT');
    expect(await allFacts(other, ship)).toEqual(before); expect(await markAudits(batch.id)).toHaveLength(0);
  });
  it('SF04 modern mark requires the full original request and exact string versions; missing, numeric and stale proofs do not recalculate or write', async () => {
    const item = await consumerFixture('complete-command'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), original = await markCommand(f, batch, ship), before = await allFacts(f, ship);
    for (const field of ['requestKey', 'expectedBatchUpdatedAt', 'expectedShipmentUpdatedAt', 'expectedPhysicalAllocationFingerprint']) {
      const incomplete: any = { ...original }; delete incomplete[field];
      const result = await mark(f, batch, incomplete); expect(result.status, diagnostic(result.body)).toBe(400);
      expect(await allFacts(f, ship)).toEqual(before);
    }
    for (const field of ['expectedBatchUpdatedAt', 'expectedShipmentUpdatedAt'] as const) {
      const numeric = await mark(f, batch, { ...original, [field]: Number(original[field]) });
      expect(numeric.status, diagnostic(numeric.body)).toBe(400); expect(await allFacts(f, ship)).toEqual(before);
      const stale = await mark(f, batch, { ...original, [field]: (BigInt(original[field]) - 1n).toString() });
      expect(stale.status, diagnostic(stale.body)).toBe(409); expect(await allFacts(f, ship)).toEqual(before);
    }
    const staleFingerprint = await mark(f, batch, { ...original, expectedPhysicalAllocationFingerprint: 'a'.repeat(64) });
    expect(staleFingerprint.status, diagnostic(staleFingerprint.body)).toBe(409); expect(await allFacts(f, ship)).toEqual(before);
  });
  it('SF05 genuine two-warehouse dispatch permits a manual OSB mark; complete original replay returns one original ACK and exactly one mandatory audit', async () => {
    const item = await consumerFixture('positive-replay'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), original = await markCommand(f, batch, ship), made = await mark(f, batch, original);
    expect(made.status, diagnostic(made.body)).toBe(200); expect(made.body.ok).toBe(true);
    expect(await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({ status: 'shipped', shipmentId: ship.id, shippedAt: BigInt(original.shippedAt) });
    const after = await allFacts(f, ship), audits = await markAudits(batch.id);
    expect(audits).toHaveLength(1); expect((audits[0].detail as any)?.source).toBe('route:order-shipment-batch:mark-shipped');
    const replay = await mark(f, batch, original); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toEqual(made.body);
    expect(await allFacts(f, ship)).toEqual(after);
    const changed = await mark(f, batch, { ...original, shippedAt: (BigInt(original.shippedAt) + 1n).toString() });
    expect(changed.status, diagnostic(changed.body)).toBe(409); expect(code(changed)).toBe('CONFLICT');
    expect(await allFacts(f, ship)).toEqual(after); expect(await markAudits(batch.id)).toHaveLength(1);
  });
  it('SF06 planned pre-invoices and null batch remain valid; two manual financial amounts can use the same genuine ticket/order without physical proportional inference', async () => {
    const item = await consumerFixture('planned-invoice'), { f, ship } = item;
    const firstBatch = await financialBatch(f, '2.0001'), secondBatch = await financialBatch(f, '7.9999');
    const firstInvoice = await invoice(f, firstBatch.id, '2.0001', 'first'), secondInvoice = await invoice(f, secondBatch.id, '7.9999', 'second');
    const unbatched = await invoice(f, null, '1.0001', 'unbatched');
    expect((await db().orderShipmentBatch.findMany({ where: { orderId: f.orderId } })).every(b => b.status === 'planned' && b.shipmentId === null)).toBe(true);
    await dispatch(item);
    for (const batch of [firstBatch, secondBatch]) {
      const marked = await mark(f, batch, await markCommand(f, batch, ship)); expect(marked.status, diagnostic(marked.body)).toBe(200);
      expect(await markAudits(batch.id)).toHaveLength(1);
    }
    for (const [original, batchId, amount] of [[firstInvoice, firstBatch.id, '2.0001'], [secondInvoice, secondBatch.id, '7.9999'], [unbatched, null, '1.0001']] as const) {
      expect(await db().invoice.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
      const allocation = await db().invoiceOrderAllocation.findFirstOrThrow({ where: { invoiceId: original.id, orderId: f.orderId, deletedAt: null } });
      expect(allocation.batchId).toBe(batchId); expect(allocation.allocatedAmount?.toString()).toBe(amount);
    }
    const saved = await db().orderShipmentBatch.findMany({ where: { orderId: f.orderId }, orderBy: { batchNo: 'asc' } });
    expect(saved.map(b => b.amount?.toString())).toEqual(['2.0001', '7.9999']); expect(saved.every(b => b.status === 'shipped' && b.shipmentId === ship.id)).toBe(true);
  });
  it('SF07 native cancellation revokes new invoice-source eligibility while retaining the original Invoice, IOA, actual reconciliation and OSB verbatim', async () => {
    const item = await consumerFixture('cancel-preserves-finance'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), marked = await mark(f, batch, await markCommand(f, batch, ship));
    expect(marked.status, diagnostic(marked.body)).toBe(200);
    const originalInvoice = await invoice(f, batch.id), settled = await settlePartially(f, originalInvoice), originals = await financialRecords(f);
    expect(originals.settlements).toHaveLength(1); expect(originals.settlements[0].id).toBe(settled.settlement.id);
    const cancelled = await patchShip(f, ship, await physicalCommand(f, ship, { status: 'Cancelled' }));
    expect(cancelled.status, diagnostic(cancelled.body)).toBe(200); expect(cancelled.body.status).toBe('Cancelled');
    expect(await financialRecords(f)).toEqual(originals);
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id } })).toBe(4);
    const stock = await db().inventoryItem.findMany({ where: { orderId: f.orderId } });
    expect(stock.reduce((sum, r) => sum.plus(r.quantity), new Prisma.Decimal(0)).toString()).toBe('10');
    const before = await allFacts(f, ship), fresh = await financePost(f, '', invoiceInput(f, batch.id, '1.0001', 'refused-after-cancel'));
    expect(fresh.status, diagnostic(fresh.body)).toBe(409); expect(code(fresh)).toBe('CONFLICT'); safeBody(fresh);
    expect(await allFacts(f, ship)).toEqual(before);
    expect(await db().auditLog.count({ where: { targetType: 'OrderShipmentBatch', targetId: batch.id, action: 'invalidate_financial_shipment_source' } })).toBe(1);
    const plain = await invoice(f, null, '1.0001', 'order-only-after-cancel');
    expect(plain.status).toBe('Draft'); expect((await db().orderShipmentBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('shipped');
  });
  it('SF08 current personal withdrawal, signed empty ceiling and an unrelated customer account reject mark and original replay with zero writes', async () => {
    const item = await consumerFixture('current-authority'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), original = await markCommand(f, batch, ship), app = application(), before = await allFacts(f, ship);
    const ceiling = await mark(f, batch, original, app, { ...f.actor, permissionCeiling: [] });
    expect(ceiling.status, diagnostic(ceiling.body)).toBe(403); expect(await allFacts(f, ship)).toEqual(before);
    // This current synthetic account has real scopes but no followed/shared
    // customer. It must not borrow the operator's L2 customer ownership.
    await db().userPermissionOverrides.createMany({ data: ['shipments:read', 'shipments:write'].map(scope => ({ id: `${f.id}-outsider-${scope}`,
      userId: f.otherUserId, scope, isActive: true, grantedBy: f.userId, reason: 'Exact unrelated-customer technical control' })), skipDuplicates: true });
    const outsider = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.otherUserId));
    const external = await mark(f, batch, original, app, outsider);
    expect(external.status, diagnostic(external.body)).toBe(404); expect(code(external)).toBe('ORDER_NOT_FOUND');
    expect(await allFacts(f, ship)).toEqual(before);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: false } });
    const revoked = await mark(f, batch, original, app); expect(revoked.status, diagnostic(revoked.body)).toBe(403);
    expect(await allFacts(f, ship)).toEqual(before);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: true } });
    const saved = await mark(f, batch, original, app); expect(saved.status, diagnostic(saved.body)).toBe(200);
    const after = await allFacts(f, ship);
    expect((await mark(f, batch, original, app, { ...f.actor, permissionCeiling: [] })).status).toBe(403);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'shipments:write' }, data: { isActive: false } });
    expect((await mark(f, batch, original, app)).status).toBe(403); expect(await allFacts(f, ship)).toEqual(after);
    expect(await markAudits(batch.id)).toHaveLength(1);
  });
});

// Additional transaction controls. The original SF01-SF08 above are retained
// verbatim, including the historical beforeNative fixture in SF03. These use
// actual native writers and actual PG failures/locks; no confirmed fact is seeded.
const financialCommandAudits = (batchId: string) => db().auditLog.findMany({ where: {
  targetType: 'OrderShipmentBatch', targetId: batchId, action: 'mark_physical_financial_batch',
}, orderBy: { id: 'asc' } });
type FinancialAuditInspection = (tx: any, arg: any) => Promise<string | void>;
function inspectFinancialTransaction(tx: any, inspect?: FinancialAuditInspection) {
  if (!inspect) return tx;
  return new Proxy(tx, { get(transaction, delegate) {
    if (delegate === 'auditLog') return new Proxy(transaction.auditLog, { get(model, method) {
      if (method === 'create') return async (arg: any) => {
        const invalidActorId = await inspect(tx, arg);
        // The only injected fault is a real AuditLog.actorId FK violation. All
        // source, money, settlement and ledger mutations are the native writer.
        return model.create(invalidActorId ? { ...arg, data: { ...arg.data, actorId: invalidActorId } } : arg);
      };
      const value = model[method]; return typeof value === 'function' ? value.bind(model) : value;
    } });
    const value = transaction[delegate]; return typeof value === 'function' ? value.bind(transaction) : value;
  } });
}
function financialAuditFailureClient(inspect: FinancialAuditInspection): PrismaClient {
  return new Proxy(db(), { get(client, key) {
    if (key === '$transaction') return (work: any, options: any) => client.$transaction(
      (tx: any) => work(inspectFinancialTransaction(tx, inspect)), options);
    const value = (client as any)[key]; return typeof value === 'function' ? value.bind(client) : value;
  } });
}
async function assertFinancialMarkRollback(label: string, faultAction: 'mark_batch_shipped' | 'mark_physical_financial_batch') {
  const item = await consumerFixture(label), { f, ship } = item; await dispatch(item);
  const batch = await financialBatch(f); await invoice(f, batch.id, '1.0001', 'existing-plan');
  const body = await markCommand(f, batch, ship), before = await allFacts(f, ship);
  const absentActorId = `${f.id}-nonexistent-audit-actor`;
  expect(await db().userAccount.count({ where: { id: absentActorId } })).toBe(0);
  let reached = false;
  const client = financialAuditFailureClient(async (tx, arg) => {
    if (arg.data.targetId !== batch.id || arg.data.action !== faultAction) return;
    const pending = await tx.orderShipmentBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(pending).toMatchObject({ status: 'shipped', shipmentId: ship.id, shippedAt: BigInt(body.shippedAt) });
    expect(await tx.auditLog.count({ where: { targetType: 'OrderShipmentBatch', targetId: batch.id, action: 'mark_batch_shipped' } }))
      .toBe(faultAction === 'mark_batch_shipped' ? 0 : 1);
    if (faultAction === 'mark_physical_financial_batch') {
      expect(arg.data.detail.source).toBe('route:order-shipment-batch:physical-command');
      expect(arg.data.detail.after.ack.command).toMatchObject({ actorId: f.userId, batchId: batch.id, shipmentId: ship.id, input: body });
      expect(arg.data.detail.after.ack.dispatchCommandHash).toMatch(/^[a-f0-9]{64}$/);
    }
    reached = true; return absentActorId;
  });
  const failed = await mark(f, batch, body, application(client));
  expect(reached, 'real mandatory audit point reached after native mark and settlement refresh').toBe(true);
  expect(failed.status, diagnostic(failed.body)).toBe(500); safeBody(failed);
  expect(await allFacts(f, ship)).toEqual(before);
  expect(await markAudits(batch.id)).toHaveLength(0); expect(await financialCommandAudits(batch.id)).toHaveLength(0);
  const saved = await mark(f, batch, body); expect(saved.status, diagnostic(saved.body)).toBe(200);
  expect(await markAudits(batch.id)).toHaveLength(1); expect(await financialCommandAudits(batch.id)).toHaveLength(1);
  const after = await allFacts(f, ship), replay = await mark(f, batch, body);
  expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toEqual(saved.body);
  expect(await allFacts(f, ship)).toEqual(after);
}

const financialConcurrentConnections: PrismaClient[] = [];
afterAll(async () => { await Promise.all(financialConcurrentConnections.map(client => client.$disconnect())); });
function concurrentFinancialApps(inspections: [FinancialAuditInspection?, FinancialAuditInspection?] = []) {
  // db() succeeds only after the actual private PG identity guard. Both clients
  // use that same verified private URL and rendezvous inside actual transactions.
  db(); let entered = 0, releaseBoth!: () => void;
  const bothEntered = new Promise<void>(resolve => { releaseBoth = resolve; });
  const apps = [0, 1].map(index => {
    const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    financialConcurrentConnections.push(client);
    const concurrent = new Proxy(client, { get(target, key) {
      if (key === '$transaction') return (work: any, options: any) => target.$transaction(async (tx: any) => {
        entered += 1; if (entered >= 2) releaseBoth(); await bothEntered;
        return work(inspectFinancialTransaction(tx, inspections[index]));
      }, options);
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    return application(concurrent);
  });
  return { apps, entered: () => entered };
}
function assertUnchangedPhysicalFacts(before: Awaited<ReturnType<typeof allFacts>>, after: Awaited<ReturnType<typeof allFacts>>) {
  for (const field of ['shipment', 'physical', 'allocations', 'inventory', 'movements'] as const) expect(after[field]).toEqual(before[field]);
}

// Five additional actual-native controls; no new financial proportional rule.
describe('Native financial mark atomicity and source-consumer concurrency', () => {
  it('SF09 original mark mandatory audit FK failure after actual status change rolls back every financial and physical fact; original key retries', async () => {
    await assertFinancialMarkRollback('original-mark-audit-rollback', 'mark_batch_shipped');
  });
  it('SF10 command ACK audit FK failure also removes the original mark audit and all pending settlement/status changes; original request remains retryable', async () => {
    await assertFinancialMarkRollback('financial-command-audit-rollback', 'mark_physical_financial_batch');
  });
  it('SF11 two actual transactions for the same original mark key produce one financial fact and one ACK; only explicit storage conflict may retry the original key', async () => {
    const item = await consumerFixture('financial-same-key'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), body = await markCommand(f, batch, ship), before = await allFacts(f, ship), parallel = concurrentFinancialApps();
    const results = await Promise.all(parallel.apps.map(app => mark(f, batch, body, app)));
    expect(parallel.entered()).toBe(2); expect(results.some(result => result.status === 200)).toBe(true);
    const originalAck = results.find(result => result.status === 200)!.body;
    for (const result of results) {
      if (result.status === 200) expect(result.body).toEqual(originalAck);
      else {
        expect(result.status, diagnostic(result.body)).toBe(409); expect(code(result)).toBe('CONFLICT');
        expect(result.body.error.message).toBe('来源正在由另一操作处理，请保留原请求重试。'); safeBody(result);
      }
    }
    const after = await allFacts(f, ship); expect(after.batches).toHaveLength(1);
    expect(after.batches[0]).toMatchObject({ status: 'shipped', shipmentId: ship.id, shippedAt: BigInt(body.shippedAt) });
    expect(after.batches[0].amount?.toString()).toBe('10'); assertUnchangedPhysicalFacts(before, after);
    expect(after.audits).toHaveLength(before.audits.length + 2);
    expect(await markAudits(batch.id)).toHaveLength(1); expect(await financialCommandAudits(batch.id)).toHaveLength(1);
    // Never replace the request key, expected versions, source fingerprint or
    // original amount to hide a storage conflict or turn a replay into a write.
    for (const result of results) {
      const replay = await mark(f, batch, body); expect(replay.status, diagnostic(replay.body)).toBe(200);
      expect(replay.body).toEqual(originalAck); expect(await allFacts(f, ship)).toEqual(after);
      if (result.status === 409) expect(result.body.error.code).toBe('CONFLICT');
    }
  });
  it('SF12 two different keys at the same exact source/version cannot mark twice or append two financial command ACKs', async () => {
    const item = await consumerFixture('financial-distinct-keys'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), body = await markCommand(f, batch, ship), other = { ...body, requestKey: randomUUID() },
      before = await allFacts(f, ship), parallel = concurrentFinancialApps();
    const results = await Promise.all([mark(f, batch, body, parallel.apps[0]), mark(f, batch, other, parallel.apps[1])]);
    expect(parallel.entered()).toBe(2); expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? 0 : 1, loser = 1 - winner;
    expect(code(results[loser])).toBe('CONFLICT'); safeBody(results[loser]);
    const after = await allFacts(f, ship); expect(after.batches).toHaveLength(1);
    assertUnchangedPhysicalFacts(before, after); expect(after.audits).toHaveLength(before.audits.length + 2);
    expect(await markAudits(batch.id)).toHaveLength(1); expect(await financialCommandAudits(batch.id)).toHaveLength(1);
    const winningReplay = await mark(f, batch, winner === 0 ? body : other);
    expect(winningReplay.status, diagnostic(winningReplay.body)).toBe(200); expect(winningReplay.body).toEqual(results[winner].body);
    const losingRetry = await mark(f, batch, loser === 0 ? body : other);
    expect(losingRetry.status, diagnostic(losingRetry.body)).toBe(409); expect(code(losingRetry)).toBe('CONFLICT');
    expect(await allFacts(f, ship)).toEqual(after);
  });
  it('SF13 actual cancellation and new native batch-invoice source consumption serialize; original Outbound, invoice, IOA, reconciliation and OSB history survive', async () => {
    const item = await consumerFixture('cancel-invoice-source-race'), { f, ship } = item; await dispatch(item);
    const batch = await financialBatch(f), marked = await mark(f, batch, await markCommand(f, batch, ship));
    expect(marked.status, diagnostic(marked.body)).toBe(200);
    const priorInvoice = await invoice(f, batch.id, '8.9999', 'original-history'); await settlePartially(f, priorInvoice);
    const originals = await financialRecords(f), before = await allFacts(f, ship), cancelBody = await physicalCommand(f, ship, { status: 'Cancelled' });
    const racingId = `${f.id}-racing-native-invoice`, invoiceBody = { ...invoiceInput(f, batch.id, '1.0001', 'concurrent-source-consumer'), id: racingId };
    let invoiceAuditReached = false, cancellationAuditReached = false, invoiceVisibleAtCancellation = false;
    const parallel = concurrentFinancialApps([
      async (tx, arg) => {
        if (arg.data.action !== 'create_invoice' || arg.data.targetId !== racingId) return;
        expect((await tx.shipment.findUniqueOrThrow({ where: { id: ship.id } })).status).toBe('Shipped');
        const pendingLedger = await tx.stockMovement.findMany({ where: { referenceType: 'Shipment', referenceId: ship.id }, orderBy: { id: 'asc' } });
        expect(pendingLedger).toEqual(before.movements); invoiceAuditReached = true;
      },
      async (tx, arg) => {
        if (arg.data.action !== 'invalidate_financial_shipment_source' || arg.data.targetId !== batch.id) return;
        invoiceVisibleAtCancellation = !!await tx.invoice.findUnique({ where: { id: racingId } }); cancellationAuditReached = true;
      },
    ]);
    const [created, cancelled] = await Promise.all([financePost(f, '', invoiceBody, parallel.apps[0]), patchShip(f, ship, cancelBody, parallel.apps[1])]);
    expect(parallel.entered()).toBe(2); expect(cancelled.status, diagnostic(cancelled.body)).toBe(200); expect(cancelled.body.status).toBe('Cancelled');
    expect([201, 409], diagnostic(created.body)).toContain(created.status); expect(cancellationAuditReached).toBe(true);
    const after = await allFacts(f, ship); expect(after.shipment.status).toBe('Cancelled');
    expect(after.movements).toHaveLength(4); expect(after.movements.filter(row => row.type === 'Outbound')).toEqual(before.movements);
    const reversed = after.movements.filter(row => row.type === 'Inbound'); expect(reversed).toHaveLength(2);
    expect(reversed.map(row => row.quantity.toString()).sort()).toEqual(['3.2501', '4.25']);
    expect(new Set(reversed.map(row => row.warehouseId))).toEqual(new Set([item.first.warehouseId, item.second.warehouseId]));
    expect(after.inventory.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).toString()).toBe('10');
    expect((after.physical as any[]).every(row => row.state === 'reversed')).toBe(true);
    for (const oldInvoice of originals.invoices) expect(after.invoices.find(row => row.id === oldInvoice.id)).toEqual(oldInvoice);
    for (const oldAllocation of originals.orderAllocations) expect(after.orderAllocations.find(row => row.id === oldAllocation.id)).toEqual(oldAllocation);
    expect(after.vouchers).toEqual(originals.vouchers); expect(after.settlements).toEqual(originals.settlements);
    // New legitimate invoicing can update derived settlement snapshots. It
    // cannot rewrite the original financial batch identity or shipment history.
    const currentBatch = after.batches.find(row => row.id === batch.id)!;
    for (const field of ['id', 'orderId', 'shipmentId', 'batchNo', 'plannedRatio', 'plannedQty', 'unit', 'amount', 'currency',
      'status', 'shippedAt', 'isFinalBatch', 'finalPaymentDueDays', 'finalPaymentDueDate', 'createdAt', 'deletedAt'] as const)
      expect(currentBatch[field]).toEqual(originals.batches[0][field]);
    if (created.status === 201) {
      expect(invoiceAuditReached).toBe(true); expect(invoiceVisibleAtCancellation).toBe(true); expect(created.body.id).toBe(racingId);
      const saved = after.invoices.find(row => row.id === racingId)!; expect(saved.status).toBe('Draft'); expect(saved.amount.toString()).toBe('1.0001');
      const allocation = after.orderAllocations.find(row => row.invoiceId === racingId)!;
      expect(allocation).toMatchObject({ orderId: f.orderId, batchId: batch.id, deletedAt: null }); expect(allocation.allocatedAmount?.toString()).toBe('1.0001');
      expect(after.invoices).toHaveLength(originals.invoices.length + 1); expect(after.orderAllocations).toHaveLength(originals.orderAllocations.length + 1);
      expect(await db().auditLog.count({ where: { targetType: 'Invoice', targetId: racingId, action: 'create_invoice' } })).toBe(1);
    } else {
      expect(code(created)).toBe('CONFLICT'); safeBody(created); expect(invoiceAuditReached).toBe(false); expect(invoiceVisibleAtCancellation).toBe(false);
      expect(after.invoices).toEqual(originals.invoices); expect(after.orderAllocations).toEqual(originals.orderAllocations);
      expect(await db().auditLog.count({ where: { targetType: 'Invoice', targetId: racingId, action: 'create_invoice' } })).toBe(0);
    }
    expect(await markAudits(batch.id)).toHaveLength(1); expect(await financialCommandAudits(batch.id)).toHaveLength(1);
    expect(await db().auditLog.count({ where: { targetType: 'OrderShipmentBatch', targetId: batch.id, action: 'invalidate_financial_shipment_source' } })).toBe(1);
    const afterRace = await allFacts(f, ship), postCancel = await financePost(f, '', { ...invoiceInput(f, batch.id, '1.0001', 'after-race-refused'), id: `${f.id}-after-race-refused` });
    expect(postCancel.status, diagnostic(postCancel.body)).toBe(409); expect(code(postCancel)).toBe('CONFLICT');
    expect(await allFacts(f, ship)).toEqual(afterRace);
  });
});

// Native L3 uses the existing automatic Draft policy. Events, confirmation,
// stock and money facts below are emitted only by their actual native producers.
async function advanceDelivered(item: Consumer, statuses = ['Arrived', 'Cleared', 'Delivered']) {
  for (const status of statuses) {
    const result = await patchShip(item.f, item.ship, await physicalCommand(item.f, item.ship, { status }));
    expect(result.status, diagnostic(result.body)).toBe(200); expect(result.body.status).toBe(status);
  }
}
async function deliveryJobs(shipId: string) {
  return db().agentJob.findMany({ where: { jobType: 'bev:ShipmentCompleted',
    payload: { path: ['sourceEntityId'], equals: shipId } }, orderBy: { id: 'asc' } });
}
async function originalDeliveryEvent(item: Consumer) {
  const jobs = await deliveryJobs(item.ship.id);
  expect(jobs).toHaveLength(1);
  const event = jobs[0].payload as any;
  expect(event).toMatchObject({ id: jobs[0].id, type: 'ShipmentCompleted', sourceEntityType: 'Shipment',
    sourceEntityId: item.ship.id, actorId: item.f.userId });
  const audit = await db().auditLog.findUniqueOrThrow({ where: { id: event.transactionId } });
  expect(audit).toMatchObject({ action: 'update_shipment', targetType: 'Shipment', targetId: item.ship.id, actorId: item.f.userId,
    detail: { before: { status: 'Cleared' }, after: { status: 'Delivered' } } });
  return jobs[0];
}
async function markedNativePlan(item: Consumer, amount = '10.0002') {
  const batch = await financialBatch(item.f, amount);
  const result = await mark(item.f, batch, await markCommand(item.f, batch, item.ship));
  expect(result.status, diagnostic(result.body)).toBe(200);
  return batch;
}
function concurrentAutomationClients() {
  db(); let entered = 0, release!: () => void;
  const bothEntered = new Promise<void>(resolve => { release = resolve; });
  const clients = [0, 1].map(() => {
    const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    financialConcurrentConnections.push(client);
    return new Proxy(client, { get(target, key) {
      if (key === '$transaction') return (work: any, options: any) => target.$transaction(async tx => {
        entered++; if (entered >= 2) release(); await bothEntered; return work(tx);
      }, options);
      const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  return { clients, entered: () => entered };
}

describe('Native delivered source to durable automatic Invoice Draft', () => {
  it('SF14 delivery persists its own event atomically and a shipper without a Finance grant still produces only the exact uninvoiced manual-batch Draft', async () => {
    const item = await consumerFixture('native-l3-current-source'), { f, ship } = item; await dispatch(item);
    const batch = await markedNativePlan(item);
    const prior = await invoice(f, batch.id, '1.0001', 'prior-manual-plan');
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'invoices:write' }, data: { isActive: false } });
    const current = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), f.userId));
    expect(current.permissions).not.toContain('invoices:write'); expect(current.permissions).toContain('shipments:write');
    await advanceDelivered(item);
    const job = await originalDeliveryEvent(item), before = await allFacts(f, ship);
    const result = await issueShipmentInvoiceDrafts(db(), job.id); expect(result.ok, diagnostic(result)).toBe(true);
    const after = await allFacts(f, ship); assertUnchangedPhysicalFacts(before, after);
    const created = after.invoices.filter(row => row.id !== prior.id); expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: 'Receivable', status: 'Draft', ownerId: 'system', orderId: f.orderId, customerRelationId: f.customerId });
    expect(created[0].amount.toString()).toBe('9.0001');
    expect(after.invoices.find(row => row.id === prior.id)).toEqual(prior);
    const allocation = after.orderAllocations.find(row => row.invoiceId === created[0].id)!;
    expect(allocation).toMatchObject({ orderId: f.orderId, batchId: batch.id, deletedAt: null }); expect(allocation.allocatedAmount?.toString()).toBe('9.0001');
    expect(after.orderAllocations.reduce((sum, row) => sum.plus(row.allocatedAmount!), new Prisma.Decimal(0)).toString()).toBe('10.0002');
    expect(await db().auditLog.count({ where: { action: 'create_shipment_invoice_draft', targetId: created[0].id, transactionId: job.id, actorId: 'system' } })).toBe(1);
    const replay = await issueShipmentInvoiceDrafts(db(), job.id); expect(replay).toMatchObject({ ok: true, created: null });
    expect(await allFacts(f, ship)).toEqual(after);
  });
  it('SF15 a missing persisted delivery selector cannot create Invoice, IOA, number or physical facts despite an actual Delivered shipment', async () => {
    const item = await consumerFixture('native-l3-missing-selector'), { f, ship } = item; await dispatch(item); await markedNativePlan(item); await advanceDelivered(item);
    await originalDeliveryEvent(item);
    const before = await allFacts(f, ship), sequences = await db().businessSequence.findMany({ orderBy: { id: 'asc' } });
    const result = await issueShipmentInvoiceDrafts(db(), `${f.id}-no-such-durable-event`);
    expect(result.ok).toBe(false); expect(diagnostic(result)).not.toMatch(/P20|Foreign key|constraint|SELECT|INSERT/);
    expect(await allFacts(f, ship)).toEqual(before); expect(await db().businessSequence.findMany({ orderBy: { id: 'asc' } })).toEqual(sequences);
  });
  it('SF16 mandatory automation audit real FK failure after canonical Invoice, IOA and credit writes rolls back every fact; the original event then retries once', async () => {
    const item = await consumerFixture('native-l3-audit-rollback'), { f, ship } = item; await dispatch(item); const batch = await markedNativePlan(item); await advanceDelivered(item);
    const job = await originalDeliveryEvent(item), before = await allFacts(f, ship), sequences = await db().businessSequence.findMany({ orderBy: { id: 'asc' } }),
      relation = await db().relation.findUniqueOrThrow({ where: { id: f.customerId } });
    const missingActorId = `${f.id}-nonexistent-audit-actor`; expect(await db().userAccount.count({ where: { id: missingActorId } })).toBe(0);
    let reached = false;
    const failure = financialAuditFailureClient(async (tx, arg) => {
      if (arg.data.action !== 'create_shipment_invoice_draft' || arg.data.transactionId !== job.id) return;
      reached = true; const created = await tx.invoice.findUniqueOrThrow({ where: { id: arg.data.targetId } });
      expect(created).toMatchObject({ status: 'Draft', ownerId: 'system', orderId: f.orderId });
      expect(created.amount.toString()).toBe('10.0002');
      expect(await tx.invoiceOrderAllocation.count({ where: { invoiceId: created.id, batchId: batch.id, deletedAt: null } })).toBe(1);
      expect(await tx.auditLog.count({ where: { targetId: created.id, action: 'create_invoice' } })).toBe(1);
      return missingActorId;
    });
    const result = await issueShipmentInvoiceDrafts(failure, job.id); expect(result.ok).toBe(false); expect(reached).toBe(true);
    expect(diagnostic(result)).not.toMatch(/P2003|23503|Foreign key|nonexistent-audit-actor|constraint/);
    expect(await allFacts(f, ship)).toEqual(before); expect(await db().relation.findUniqueOrThrow({ where: { id: f.customerId } })).toEqual(relation);
    expect(await db().businessSequence.findMany({ orderBy: { id: 'asc' } })).toEqual(sequences);
    expect(await db().auditLog.count({ where: { action: 'create_shipment_invoice_draft', transactionId: job.id } })).toBe(0);
    const retry = await issueShipmentInvoiceDrafts(db(), job.id); expect(retry.ok, diagnostic(retry)).toBe(true);
    expect(await db().invoice.count({ where: { orderId: f.orderId, deletedAt: null } })).toBe(1);
    expect(await db().auditLog.count({ where: { action: 'create_shipment_invoice_draft', transactionId: job.id } })).toBe(1);
    expect(await issueShipmentInvoiceDrafts(db(), job.id)).toMatchObject({ ok: true, created: null });
  });
  it('SF17 two actual private-PG transactions consume the same delivered event into only one original Draft and IOA', async () => {
    const item = await consumerFixture('native-l3-two-transactions'), { f, ship } = item; await dispatch(item); const batch = await markedNativePlan(item); await advanceDelivered(item);
    const job = await originalDeliveryEvent(item), before = await allFacts(f, ship), concurrent = concurrentAutomationClients();
    const results = await Promise.all(concurrent.clients.map(client => issueShipmentInvoiceDrafts(client, job.id)));
    expect(concurrent.entered()).toBe(2); expect(results.every(result => result.ok), diagnostic(results)).toBe(true);
    expect(results.filter(result => result.created != null)).toHaveLength(1); expect(results.filter(result => result.created === null)).toHaveLength(1);
    const after = await allFacts(f, ship); assertUnchangedPhysicalFacts(before, after); expect(after.invoices).toHaveLength(1); expect(after.orderAllocations).toHaveLength(1);
    expect(after.invoices[0].amount.toString()).toBe('10.0002'); expect(after.orderAllocations[0].batchId).toBe(batch.id);
    expect(after.orderAllocations[0].allocatedAmount?.toString()).toBe('10.0002');
    expect(await db().auditLog.count({ where: { action: 'create_shipment_invoice_draft', transactionId: job.id } })).toBe(1);
  });
  it('SF18 real outbox duplicate failure rolls the Delivery and command ACK back; the exact original request safely retries with one durable event', async () => {
    const item = await consumerFixture('native-delivery-outbox-rollback'), { f, ship } = item; await dispatch(item); await advanceDelivered(item, ['Arrived', 'Cleared']);
    const probe = `${f.id}-outbox-collision`;
    await db().agentJob.create({ data: { id: probe, jobType: 'acceptance:outbox-failure-probe', status: 'completed', payload: {} } });
    const body = await physicalCommand(f, ship, { status: 'Delivered' }), before = await allFacts(f, ship); let reached = false;
    const failure = new Proxy(db(), { get(client, key) {
      if (key === '$transaction') return (work: any, options: any) => client.$transaction((tx: any) => work(new Proxy(tx, { get(target, delegate) {
        if (delegate === 'agentJob') return new Proxy(target.agentJob, { get(model, method) {
          if (method === 'create') return (arg: any) => { reached = true; return model.create({ ...arg, data: { ...arg.data, id: probe } }); };
          const value = model[method]; return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = target[delegate]; return typeof value === 'function' ? value.bind(target) : value;
      } })), options);
      const value = (client as any)[key]; return typeof value === 'function' ? value.bind(client) : value;
    } });
    const rejected = await patchShip(f, ship, body, application(failure)); expect(rejected.status).toBe(500); expect(code(rejected)).toBe('UPDATE_FAILED'); expect(reached).toBe(true); safeBody(rejected);
    expect(await allFacts(f, ship)).toEqual(before); expect(await deliveryJobs(ship.id)).toHaveLength(0);
    const retried = await patchShip(f, ship, body); expect(retried.status, diagnostic(retried.body)).toBe(200); expect(retried.body.status).toBe('Delivered');
    const job = await originalDeliveryEvent(item); expect(job.id).not.toBe(probe);
    const replay = await patchShip(f, ship, body); expect(replay.status, diagnostic(replay.body)).toBe(200);
    expect(await deliveryJobs(ship.id)).toHaveLength(1);
  });
  it('SF19 native delivery and cancellation race admits one legal source outcome, never a draft from a cancelled physical dispatch', async () => {
    const item = await consumerFixture('native-l3-delivery-cancellation'), { f, ship } = item; await dispatch(item); await markedNativePlan(item); await advanceDelivered(item, ['Arrived', 'Cleared']);
    const delivery = await physicalCommand(f, ship, { status: 'Delivered' }), cancellation = await physicalCommand(f, ship, { status: 'Cancelled' }), concurrent = concurrentFinancialApps();
    const [delivered, cancelled] = await Promise.all([patchShip(f, ship, delivery, concurrent.apps[0]), patchShip(f, ship, cancellation, concurrent.apps[1])]);
    expect(concurrent.entered()).toBe(2); expect([delivered.status, cancelled.status].sort()).toEqual([200, 409]);
    const final = await db().shipment.findUniqueOrThrow({ where: { id: ship.id } });
    if (final.status === 'Delivered') {
      expect(delivered.status).toBe(200); expect(cancelled.status).toBe(409);
      const job = await originalDeliveryEvent(item); expect((await issueShipmentInvoiceDrafts(db(), job.id)).ok).toBe(true);
      expect(await db().invoice.count({ where: { orderId: f.orderId, status: 'Draft', deletedAt: null } })).toBe(1);
      expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id, type: 'Inbound' } })).toBe(0);
    } else {
      expect(final.status).toBe('Cancelled'); expect(cancelled.status).toBe(200); expect(delivered.status).toBe(409);
      expect(await deliveryJobs(ship.id)).toHaveLength(0); expect(await db().invoice.count({ where: { orderId: f.orderId, deletedAt: null } })).toBe(0);
      expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: ship.id, type: 'Inbound' } })).toBe(2);
    }
  });
});
