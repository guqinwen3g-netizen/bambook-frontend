import { issueShipmentInvoiceDrafts } from '../src/events/linkages/L3IssueInvoice';
import { qcReportSourceFingerprint } from '../src/qc/qcReportAuthority';
import { createQcRouter } from '../src/qc/qcRoute';
import { createSample, advanceSampleStage } from '../src/samples/sampleManageService';
/** Actual isolated PG bulk read navigation controls using original native source/writers.
 * Source fixture helpers are copied byte-preserving from the original handoff suite; no core/auth mocks.
 * This reader does not prevent concurrent first invoices. Separate actual React DOM controls verify the Finance leaf.
 * Original source-gate native control infrastructure follows. Initial accounts, exact
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
import { createSceneInvoiceRouter } from '../src/finance/sceneInvoiceRoute';
import { createDashboardRouter } from '../src/dashboard/route';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-bulk-handoff-${randomUUID()}`;
const auth = createAuthService();
let prisma: PrismaClient | undefined, sequence = 0, writes = 0, nativeQueries = 0;
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
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } },log:[{emit:'event',level:'query'}] });
  (prisma as any).$on('query',(event:{query:string})=>{nativeQueries++;if(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(event.query))writes++;});
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
  app.use((req,res,next)=>{const start=performance.now(),initial=nativeQueries,writeStart=writes;res.once('finish',()=>{if(req.method==='GET'&&(req.originalUrl.includes('bulk-sources')||req.originalUrl.includes('dashboard/workbench')))console.log('BULK_READ_METRIC '+JSON.stringify({path:req.originalUrl.split('?')[0],query:req.originalUrl.split('?')[1]??'',status:res.statusCode,queries:nativeQueries-initial,writes:writes-writeStart,elapsedMs:performance.now()-start}));});next();});
  app.use(express.json()); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/production-batches', createProductionBatchRouter({ prisma: client, requireAuth, apiKeys: new Set(), onDataChange: e => changes.push(e) }));
  app.use('/api/v1/qc', createQcRouter({ prisma: client, requireAuth: true, apiKeys: new Set() }));
  app.use('/api/v1/shipping', createShippingRouter({ prisma: client, requireAuth, apiKeys: new Set(), exceptionChecker: null, onDataChange: e => changes.push(e) }));
  app.use('/api/v1/finance/scene-invoice', createSceneInvoiceRouter({ prisma: client, requireAuth: true, apiKeys: new Set() }));
  app.use('/api/v1/dashboard', createDashboardRouter({ prisma: client, requireAuth: true, apiKeys: new Set() }));
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

const sourcePath=(f:Fixture,b:any)=>`/api/v1/finance/scene-invoice/bulk-sources/${b.id}?orderId=${f.orderId}`;
const getSource=(f:Fixture,b:any,client:PrismaClient=db(),actor:TokenPayload=f.actor)=>request(application(client).app).get(sourcePath(f,b)).set('Authorization',`Bearer ${auth.signToken(actor)}`);
const getList=(f:Fixture)=>request(application().app).get(`/api/v1/finance/scene-invoice/bulk-sources?orderId=${f.orderId}`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`);
const dashboardSource=(f:Fixture,client:PrismaClient=db())=>request(application(client).app).get('/api/v1/dashboard/workbench?group=finance-handoffs').set('Authorization',`Bearer ${auth.signToken(f.actor)}`);
function transactionTransition(work:()=>Promise<void>):PrismaClient{let n=0;return new Proxy(db(),{get(target,key){if(key==='$transaction')return async(fn:any,options:any)=>{const result=await target.$transaction(fn,options);if(++n===1)await work();return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}
function delegateFault(name:string,method:string,fault:any):PrismaClient{return new Proxy(db(),{get(target,key){if(key==='$transaction')return (fn:any,options:any)=>target.$transaction((tx:any)=>fn(new Proxy(tx,{get(raw,k){const d=Reflect.get(raw,k);if(k!==name)return typeof d==='function'?d.bind(raw):d;return new Proxy(d,{get(model,m){return m===method?async()=>{throw fault;}:Reflect.get(model,m);}});}})),options);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});}
async function zeroRead(f:Fixture,b:any,execute=()=>getSource(f,b)){const before=await financialRecords(f);const initialWrites=writes;const result=await execute();expect(writes-initialWrites).toBe(0);expect(await financialRecords(f)).toEqual(before);return result;}
describe('Real PG bulk invoice read projection and current authority',()=>{
 it('BHR01 genuine native planned batch has null actual and exact plan, no CostRecord/task/debt writes, same Dashboard source and original thirteen keys',async()=>{const f=await fixture('planned'),b=await financialBatch(f,'2500.0001');const r=await zeroRead(f,b);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source).toMatchObject({order:{id:f.orderId,customer:f.customerId},batch:{id:b.id,orderId:f.orderId,plannedAmount:'2500.0001',status:'planned'},actual:{evidence:'planned',quantity:null,unit:null},disposition:'first-invoice-review',canStartInvoice:true,invoices:[]});expect(r.body.source.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);const list=await getList(f);expect(list.status,diagnostic(list.body)).toBe(200);expect(list.body.items.map((v:any)=>v.batch.id)).toEqual([b.id]);const dash=await dashboardSource(f);expect(dash.status,diagnostic(dash.body)).toBe(200);const item=dash.body.groups[0].items.find((v:any)=>v.source.id===b.id);expect(item).toMatchObject({source:{type:'OrderShipmentBatch',id:b.id},responsibility:{kind:'scope-visible',userId:null},target:{kind:'bulk-invoice-source',orderId:f.orderId,batchId:b.id,tab:'invoices'}});expect(await db().workAssignment.count({where:{userId:f.userId}})).toBe(0);expect(await db().costRecord.count({where:{sourceId:f.orderId}})).toBe(0);expect(await db().invoice.count({where:{customerRelationId:f.customerId}})).toBe(0);const all=await request(application().app).get('/api/v1/dashboard/workbench').set('Authorization',`Bearer ${auth.signToken(f.actor)}`);expect(all.body.groups.map((v:any)=>v.key)).toEqual(['development-expenses','finance-handoffs','qc','workflow','approvals','development','samples','quotations','orders','shipments','inventory','invoices','claims']);});
 it('BHR02 real dispatched physical source remains exact, plan is not actual, all original goods/QC/receipts/stock/audits remain byte equivalent',async()=>{const c=await consumerFixture('shipped');await dispatch(c);const b=await financialBatch(c.f,'2500');const marked=await mark(c.f,b,await markCommand(c.f,b,c.ship));expect(marked.status,diagnostic(marked.body)).toBe(200);const before=await allFacts(c.f,c.ship),initial=writes;const r=await getSource(c.f,b);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source).toMatchObject({batch:{status:'shipped',plannedAmount:'2500'},shipment:{id:c.ship.id,status:'Shipped'},actual:{evidence:'confirmed',quantity:'7.5001',unit:'m'},disposition:'first-invoice-review'});expect(writes-initial).toBe(0);expect(await allFacts(c.f,c.ship)).toEqual(before);});
 it('BHR03 native original Draft continues its exact invoice; issued unpaid is never first even when batch snapshot is unsettled',async()=>{const f=await fixture('draft-issued'),b=await financialBatch(f,'2500'),inv=await invoice(f,b.id,'2500');let r=await zeroRead(f,b);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source).toMatchObject({disposition:'existing-invoices',canStartInvoice:false,invoices:[{invoiceId:inv.id,status:'Draft',target:{kind:'invoice',invoiceId:inv.id,tab:'invoices'}}]});const issued=await request(application().app).patch(`/api/v1/finance/${inv.id}`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`).send({status:'Issued'});expect(issued.status,diagnostic(issued.body)).toBe(200);r=await zeroRead(f,b);expect(r.body.source.invoices[0]).toMatchObject({invoiceId:inv.id,status:'Issued'});expect(r.body.source.disposition).toBe('existing-invoices');expect(r.body.source.canStartInvoice).toBe(false);const dash=await dashboardSource(f);expect(dash.body.groups[0].items.some((v:any)=>v.source.id===b.id)).toBe(false);const invoiceGroup=await request(application().app).get('/api/v1/dashboard/workbench?group=invoices').set('Authorization',`Bearer ${auth.signToken(f.actor)}`);expect(invoiceGroup.body.groups[0].items.some((v:any)=>v.target?.invoiceId===inv.id)).toBe(true);});
 it('BHR04 current revoke, empty signed ceiling and forged query roles cannot authorize the exact source',async()=>{const f=await fixture('revoked'),b=await financialBatch(f);expect((await getSource(f,b,db(),{...f.actor,permissionCeiling:[]})).status).toBe(403);await db().userPermissionOverrides.updateMany({where:{userId:f.userId,scope:'invoices:read'},data:{isActive:false}});const initial=writes;const r=await request(application().app).get(sourcePath(f,b)+'&roles=owner&actorId='+f.userId).set('Authorization',`Bearer ${auth.signToken(f.actor)}`);expect(r.status).toBe(403);expect(writes-initial).toBe(0);});
 it('BHR05 wrong parent is 404 and foreign Order never yields source data',async()=>{const f=await fixture('wrong-parent'),b=await financialBatch(f);const r=await request(application().app).get(`/api/v1/finance/scene-invoice/bulk-sources/${b.id}?orderId=missing`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`);expect(r.status).toBe(404);expect(r.body.source).toBeUndefined();const foreign=await fixture('foreign-parent',true),fb=await financialBatch(foreign);await db().teamDataGrant.deleteMany({where:{id:foreign.shareId}});expect((await getSource(foreign,fb)).status).toBe(404);});
 it('BHR06 historical removed IOA and direct whole-order ambiguity cannot become a new first invoice',async()=>{const f=await fixture('history'),b=await financialBatch(f),inv=await invoice(f,b.id);const removed=await request(application().app).patch(`/api/v1/finance/${inv.id}`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`).send({orderAllocations:[]});expect(removed.status,diagnostic(removed.body)).toBe(200);const r=await zeroRead(f,b);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source.disposition).toBe('review-required');expect(r.body.source.canStartInvoice).toBe(false);expect(await db().invoiceOrderAllocation.count({where:{invoiceId:inv.id,deletedAt:{not:null}}})).toBe(1);});
 it('BHR07 storage query faults carrying fake business code remain unavailable, Dashboard failed/null, no leaked SQL and no writes',async()=>{const f=await fixture('fault'),b=await financialBatch(f);const client=delegateFault('invoiceOrderAllocation','findMany',Object.assign(Error('SQL-secret-native-probe'),{code:'CONFLICT',statusCode:409}));const r=await zeroRead(f,b,()=>getSource(f,b,client));expect(r.status).toBe(503);safeBody(r);expect(diagnostic(r.body)).not.toContain('SQL-secret');const dash=await dashboardSource(f,client);expect(dash.status).toBe(200);expect(dash.body.groups[0]).toMatchObject({status:'failed',items:null,total:null});});
 it('BHR08 late authority revocation after first real observation cannot publish the source',async()=>{const f=await fixture('late-revoke'),b=await financialBatch(f);const client=transactionTransition(async()=>{await db().userPermissionOverrides.updateMany({where:{userId:f.userId,scope:'invoices:read'},data:{isActive:false}});});const r=await getSource(f,b,client);expect(r.status).toBe(403);expect(r.body.source).toBeUndefined();});
 it('BHR09 complete native financial-source change between independent observations rejects rather than emitting the old first mode',async()=>{const f=await fixture('late-plan'),b=await financialBatch(f);const client=transactionTransition(async()=>{await db().orderShipmentBatch.update({where:{id:b.id},data:{notes:'Actual source changed'}});});const r=await getSource(f,b,client);expect(r.status).toBe(409);expect(r.body.source).toBeUndefined();});
 it('BHR10 read-only ceiling preserves source but disables manual invoice start',async()=>{const f=await fixture('readonly'),b=await financialBatch(f);const r=await zeroRead(f,b,()=>getSource(f,b,db(),{...f.actor,permissionCeiling:['orders:read','shipments:read','invoices:read']}));expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source.canStartInvoice).toBe(false);expect(r.body.source.disposition).toBe('first-invoice-review');});
 it('BHR11 confirmed null PO and explicit actual unknown retain native nulls rather than inventing facts',async()=>{const f=await fixture('null-po'),b=await financialBatch(f);await db().order.update({where:{id:f.orderId},data:{poNumber:null}});const r=await zeroRead(f,b);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source.order.poNumber).toBeNull();expect(r.body.source.actual.quantity).toBeNull();});
 it('BHR12 two first reads do not claim atomic duplicate prevention: unchanged original canonical writer still permits two explicit manual invoice intents',async()=>{const f=await fixture('concurrency-boundary'),b=await financialBatch(f);const reads=await Promise.all([getSource(f,b),getSource(f,b)]);expect(reads.map(r=>r.status)).toEqual([200,200]);expect(reads.every(r=>r.body.source.disposition==='first-invoice-review')).toBe(true);const results=await Promise.all([financePost(f,'',invoiceInput(f,b.id,'5','intent-A')),financePost(f,'',invoiceInput(f,b.id,'5','intent-B'))]);expect(results.map(r=>r.status)).toEqual([201,201]);expect(await db().invoiceOrderAllocation.count({where:{batchId:b.id,deletedAt:null}})).toBe(2);expect(await db().invoice.count({where:{customerRelationId:f.customerId}})).toBe(2);});
 it('BHR13 actual native cancelled planned batch stays historical and cannot reappear as first invoice or Dashboard handoff',async()=>{const f=await fixture('cancelled-plan'),b=await financialBatch(f);const cancel=await request(application().app).put(`/api/v1/shipping/order-batches/${b.id}`).set('Authorization',`Bearer ${auth.signToken(f.actor)}`).send({status:'cancelled'});expect(cancel.status,diagnostic(cancel.body)).toBe(200);const r=await zeroRead(f,b);expect(r.status,diagnostic(r.body)).toBe(200);expect(r.body.source).toMatchObject({batch:{status:'cancelled'},disposition:'review-required',canStartInvoice:false,invoices:[]});const dash=await dashboardSource(f);expect(dash.body.groups[0].items.some((row:any)=>row.source.id===b.id)).toBe(false);expect(await db().orderShipmentBatch.count({where:{id:b.id}})).toBe(1);expect(await db().invoiceOrderAllocation.count({where:{batchId:b.id}})).toBe(0);});
});
