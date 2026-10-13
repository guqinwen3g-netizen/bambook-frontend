/** V1 physical receipt contract, actual isolated PG only. All initial accounts,
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
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { resolveCurrentProductionBatchFacts } from '../src/production/productionBatchService';
import {
  createSampleBatch, advanceSampleBatchStage, createSealSample,
  sealSampleConfirm, convertToFabricAsset,
} from '../src/development/fabricDevelopmentService';

const prefix = `acceptance-production-receipt-${randomUUID()}`;
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
      'orders:read', 'orders:write', 'products:read', 'products:write', 'production:read', 'inventory:read', 'inventory:write',
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
async function physicalSnapshot(f: Fixture) {
  return { items: await db().inventoryItem.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    movements: await db().stockMovement.findMany({ where: { referenceType: 'ProductionBatch', referenceId: { startsWith: 'PB_' }, item: { orderId: f.orderId } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.userId, action: { in: ['receive_production_batch_stock', 'stock_movement_inbound', 'stock_movement_outbound'] } }, orderBy: { id: 'asc' } }),
    reports: await db().inspectionReport.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    stages: await db().productionStage.findMany({ where: { orderId: f.orderId }, orderBy: { id: 'asc' } }),
    approvals: await db().ppSampleRelease.findMany({ where: { scopeId: { in: (await db().releaseScope.findMany({ where: { orderId: f.orderId }, select: { id: true } })).map(x => x.id) } }, orderBy: { id: 'asc' } }),
  };
}
function failingReceiptAudit(probe: { reached: boolean }) {
  return new Proxy(db(), { get(target, key) {
    if (key === '$transaction') return (work: any, options: any) => target.$transaction((tx: any) => work(new Proxy(tx, { get(transaction, delegate) {
      if (delegate === 'auditLog') return new Proxy(transaction.auditLog, { get(model, method) {
        if (method === 'create') return (input: any) => {
          if (input.data.action === 'receive_production_batch_stock') { probe.reached = true; return model.create({ ...input, data: { ...input.data, actorId: prefix + '-actual-nonexistent-audit-actor' } }); }
          return model.create(input);
        };
        const v = Reflect.get(model, method); return typeof v === 'function' ? v.bind(model) : v;
      } });
      const v = Reflect.get(transaction, delegate); return typeof v === 'function' ? v.bind(transaction) : v;
    } })), options);
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
  } });
}
describe.sequential('physical production receipts through signed native HTTP, independent PG', () => {
  it('PSR01 actual neutral range alone has no stock; explicit receipt creates one exact stock item, Inbound and immutable receipt without QC/PP/stage facts', async () => {
    const f = await fixture('native-receipt'), batch = await originalBatch(f), before = await physicalSnapshot(f);
    expect(before.items).toEqual([]); expect(before.movements).toEqual([]);
    const body = await receiptCommand(f, batch), result = await receive(f, batch, body);
    expect(result.status, diagnostic(result.body)).toBe(201); expect(result.body.replayed).toBe(false);
    const receipt = await (db() as any).productionStockReceipt.findUniqueOrThrow({ where: { id: result.body.receipt.id } });
    const item = await db().inventoryItem.findUniqueOrThrow({ where: { id: receipt.inventoryItemId } });
    const movement = await db().stockMovement.findUniqueOrThrow({ where: { id: receipt.stockMovementId } });
    expect(receipt.productionBatchId).toBe(batch.id); expect(receipt.productionBatchRevision).toBe(batch.revision);
    expect(receipt.orderLineId).toBe(f.lineId); expect(receipt.scopeFingerprint).toBe(body.expectedScopeFingerprint);
    expect(receipt.quantity.toString()).toBe('3.2501'); expect(item.quantity.toString()).toBe('3.2501');
    expect(item.unitCost).toBeNull(); expect(item.currency).toBe('USD'); expect(item.ownership).toBe('Owned');
    expect(item.orderId).toBe(f.orderId); expect(movement.referenceType).toBe('ProductionBatch'); expect(movement.referenceId).toBe(batch.id);
    expect(movement.type).toBe('Inbound'); expect(movement.balanceBefore.toString()).toBe('0'); expect(movement.balanceAfter.toString()).toBe('3.2501');
    expect(movement.operator).toBe(f.userId); expect(receipt.createdBy).toBe(f.userId);
    const after = await physicalSnapshot(f); expect(after.items).toHaveLength(1); expect(after.movements).toHaveLength(1);
    expect(after.reports).toEqual(before.reports); expect(after.stages).toEqual(before.stages); expect(after.approvals).toEqual(before.approvals);
    expect(after.audits.filter(row => row.action === 'receive_production_batch_stock')).toHaveLength(1);
  });
  it('PSR02 the full Decimal18_4 boundary reaches stock and ledger without Number rounding; explicit zero cost stays zero', async () => {
    // INITIAL legacy Order.quantity is Int and remains a separate display field.
    // The actual Line/Batch/receipt/ledger quantity retains the full Decimal18_4 boundary.
    const qty = '99999999999999.9999', f = await fixture('exact-boundary', false, qty, 1), batch = await originalBatch(f, qty);
    const body = { ...await receiptCommand(f, batch, qty), unitCost: '0' }, result = await receive(f, batch, body);
    expect(result.status, diagnostic(result.body)).toBe(201);
    const item = await db().inventoryItem.findUniqueOrThrow({ where: { id: result.body.receipt.inventoryItemId } });
    const movement = await db().stockMovement.findUniqueOrThrow({ where: { id: result.body.receipt.stockMovementId } });
    expect(item.quantity.toString()).toBe(qty); expect(movement.quantity.toString()).toBe(qty); expect(movement.balanceAfter.toString()).toBe(qty); expect(item.unitCost!.toString()).toBe('0');
  });
  it.each([['blank', { quantity: '' }], ['numeric', { quantity: 3.25 }], ['null', { quantity: null }], ['exponent', { quantity: '3e0' }], ['rounding', { quantity: '3.25001' }], ['unknown-cost', { unitCost: '' }], ['unknown-currency', { currency: '' }], ['unknown-ownership', { ownership: '' }], ['foreign-fields', { inventoryItemId: 'unrelated-stock' }]] as const)('PSR03-%s invalid/unknown quantity, cost or source fields cause 400 and zero stock or audit writes', async (_label, patch) => {
    const f = await fixture('invalid-' + _label), batch = await originalBatch(f), body = { ...await receiptCommand(f, batch), ...patch }, before = await physicalSnapshot(f);
    const result = await receive(f, batch, body); expect(result.status, diagnostic(result.body)).toBe(400); safeBody(result); expect(await physicalSnapshot(f)).toEqual(before);
  });
  it('PSR04 current exact scope or batch revision conflict cannot create stock or borrow a new source', async () => {
    const f = await fixture('stale-range'), batch = await originalBatch(f), body = await receiptCommand(f, batch), before = await physicalSnapshot(f);
    for (const patch of [{ expectedBatchRevision: batch.revision + 1 }, { expectedScopeFingerprint: 'a'.repeat(64) }]) {
      const result = await receive(f, batch, { ...body, ...patch }); expect(result.status, diagnostic(result.body)).toBe(409); expect(await physicalSnapshot(f)).toEqual(before);
    }
  });
  it('PSR05 original request replay returns the frozen native receipt; a different command under that key conflicts without duplicate stock', async () => {
    const f = await fixture('immutable-key'), batch = await originalBatch(f), body = await receiptCommand(f, batch), first = await receive(f, batch, body);
    expect(first.status, diagnostic(first.body)).toBe(201); const before = await physicalSnapshot(f);
    const replay = await receive(f, batch, body); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true); expect(replay.body.receipt).toEqual(first.body.receipt);
    const conflict = await receive(f, batch, { ...body, quantity: '2' }); expect(conflict.status, diagnostic(conflict.body)).toBe(409); expect(await physicalSnapshot(f)).toEqual(before);
  });
  it('PSR06 real current inventory permission withdrawal and signed empty ceiling prevent both new receipt and original replay', async () => {
    const f = await fixture('current-authority'), batch = await originalBatch(f), body = await receiptCommand(f, batch), first = await receive(f, batch, body);
    expect(first.status, diagnostic(first.body)).toBe(201); const before = await physicalSnapshot(f);
    const capped = await receive(f, batch, { ...body, requestKey: randomUUID() }, application(), { ...f.actor, permissionCeiling: [] }); expect(capped.status, diagnostic(capped.body)).toBe(403);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'inventory:write' }, data: { isActive: false } });
    const revoked = await receive(f, batch, body); expect(revoked.status, diagnostic(revoked.body)).toBe(403); expect(await physicalSnapshot(f)).toEqual(before);
  });
  it('PSR07 concurrent receipts reserve the same physical range under a real batch lock; exactly one6m receipt commits and the other409', async () => {
    const f = await fixture('concurrent-range'), batch = await originalBatch(f), body = await receiptCommand(f, batch, '6');
    const results = await Promise.all([receive(f, batch, body), receive(f, batch, { ...body, requestKey: randomUUID() })]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]); const snapshot = await physicalSnapshot(f);
    expect(snapshot.items).toHaveLength(1); expect(snapshot.movements).toHaveLength(1); expect(snapshot.items[0].quantity.toString()).toBe('6');
  });
  it('PSR08 an actual receipt audit FK failure rolls back item, stock movement and receipt; the same original command can retry legally', async () => {
    const f = await fixture('audit-rollback'), batch = await originalBatch(f), body = await receiptCommand(f, batch), before = await physicalSnapshot(f), probe = { reached: false };
    const failed = await receive(f, batch, body, application(failingReceiptAudit(probe))); expect(failed.status, diagnostic(failed.body)).toBe(500); expect(probe.reached).toBe(true); safeBody(failed); expect(await physicalSnapshot(f)).toEqual(before);
    expect(await (db() as any).productionStockReceipt.count({ where: { productionBatchId: batch.id } })).toBe(0);
    const retry = await receive(f, batch, body); expect(retry.status, diagnostic(retry.body)).toBe(201); expect(await (db() as any).productionStockReceipt.count({ where: { productionBatchId: batch.id } })).toBe(1);
  });
  it('PSR09 physical receipt is retained; a neutral split cannot rename received goods or erase their original range', async () => {
    const f = await fixture('no-receipt-resurrection'), batch = await originalBatch(f), body = await receiptCommand(f, batch), received = await receive(f, batch, body);
    expect(received.status, diagnostic(received.body)).toBe(201); const before = await physicalSnapshot(f);
    const result = await split(f, batch.id, await splitCommand(f, batch, ['5', '5'])); expect(result.status, diagnostic(result.body)).toBe(409); expect(await physicalSnapshot(f)).toEqual(before);
    expect((await batches().findUniqueOrThrow({ where: { id: batch.id } })).state).toBe('active');
  });
});

/** Native bootstrap uses number toJSON globally. This isolated override
 * reproduces it without starting index/seed/scheduler or changing stored facts. */
async function withNativeNumberSerialization<T>(work: () => Promise<T>): Promise<T> {
  const decimal = Prisma.Decimal.prototype as unknown as { toJSON: () => unknown }, priorDecimal = decimal.toJSON;
  const bigint = BigInt.prototype as unknown as { toJSON?: () => unknown }, priorBigint = Object.getOwnPropertyDescriptor(bigint, 'toJSON');
  decimal.toJSON = function (this: Prisma.Decimal) { return Number(this); };
  Object.defineProperty(bigint, 'toJSON', { configurable: true, writable: true, value: function (this: bigint) { return Number(this); } });
  try { return await work(); } finally { decimal.toJSON = priorDecimal; if (priorBigint) Object.defineProperty(bigint, 'toJSON', priorBigint); else delete bigint.toJSON; }
}

describe('Physical stock native Decimal wire contract', () => {
  it('native original receipt and current read preserve exact quantities, costs and ledger strings under bootstrap hooks', async () => {
    const f = await fixture('number-wire-stock'), batch = await originalBatch(f), body = { ...await receiptCommand(f, batch, '3.2501'), unitCost: '1.2501' };
    await withNativeNumberSerialization(async () => {
      const result = await receive(f, batch, body); expect(result.status, diagnostic(result.body)).toBe(201);
      expect(result.body.receipt.quantity).toBe('3.2501'); expect(result.body.inventoryItem.quantity).toBe('3.2501'); expect(result.body.inventoryItem.unitCost).toBe('1.2501');
      expect(result.body.movement.quantity).toBe('3.2501'); expect(result.body.movement.balanceBefore).toBe('0'); expect(result.body.movement.balanceAfter).toBe('3.2501');
      const replay = await receive(f, batch, body); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.replayed).toBe(true);
      expect(replay.body.receipt).toEqual(result.body.receipt); expect(replay.body.inventoryItem).toEqual(result.body.inventoryItem);
      const account = await request(application().app).get(receiptPath(batch.id)).set('Authorization', 'Bearer ' + auth.signToken(f.actor)); expect(account.status).toBe(200); expect(account.body.receipts[0].receipt.quantity).toBe('3.2501');
      expect(account.body.batch.quantity).toBe(batch.quantity.toString());
      const after = await physicalSnapshot(f); expect(await db().productionStockReceipt.count({ where: { orderId: f.orderId } })).toBe(1); expect(after.movements).toHaveLength(1);
    });
  });
  it('the Decimal18_4 maximum stays a string in real HTTP ACK and replay, never the rounded native Number', async () => {
    const qty = '99999999999999.9999', f = await fixture('number-wire-max', false, qty, 1), batch = await originalBatch(f, qty), body = { ...await receiptCommand(f, batch, qty), unitCost: '0' };
    await withNativeNumberSerialization(async () => {
      const result = await receive(f, batch, body); expect(result.status, diagnostic(result.body)).toBe(201);
      expect(result.body.receipt.quantity).toBe(qty); expect(result.body.inventoryItem.quantity).toBe(qty); expect(result.body.inventoryItem.unitCost).toBe('0');
      expect(result.body.movement.quantity).toBe(qty); expect(result.body.movement.balanceAfter).toBe(qty);
      const replay = await receive(f, batch, body); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body.receipt.quantity).toBe(qty);
      expect((await db().inventoryItem.findUniqueOrThrow({ where: { id: result.body.receipt.inventoryItemId } })).quantity.toString()).toBe(qty);
    });
  });
});
