/**
 * Real claim/approval/shipping HTTP + current DB authorization + isolated PG.
 * 9/17 B1/A7: an approval label or amount is not a decision; actual assigned
 * general-leader decisions authorize the exact server-owned disposition.
 * Physical repair/replacement release consumes received batches, latest actual
 * QC and explicit stock/ownership facts, with mandatory ledger/audit atomicity.
 * Synthetic combined operator scopes prove API/storage contracts, not company
 * role UAT, rendered UI, ordinary sales-order release or cancellation policy.
 * No seed, application bootstrap, scheduler, shared DB or destructive cleanup.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createClaimRouter } from '../src/claims/claimRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createShippingRouter } from '../src/shipping/route';
import { createInventoryService } from '../src/inventory/inventoryService';

const prefix = `acceptance-claim-release-${randomUUID()}`;
const scopes = ['aftersales:read', 'aftersales:write', 'inventory:read', 'inventory:write', 'production:write', 'qc:write', 'shipments:read', 'shipments:write'];
const auth = createAuthService();
let prisma: PrismaClient | undefined;
const db = () => { if (!prisma) throw Error('Independent claim release PG not initialized'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

function app(database: PrismaClient = db(), notify = vi.fn(), entered?: (url: string) => void) {
  const result = express(); result.use(express.json());
  result.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  result.use((req, _res, next) => { entered?.(req.originalUrl); next(); });
  result.use(createAccountStatusGuard(db()));
  result.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  result.use('/api/v1', createClaimRouter({ prisma: database, requireAuth: true }));
  result.use('/api/v1/approvals', createApprovalRouter({ prisma: database, requireAuth: true }));
  result.use('/api/v1/shipping', createShippingRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), onDataChange: notify }));
  return result;
}
async function fixture(key: string, kind: 'Repair' | 'Replace') {
  const id = `${prefix}-${key}`, operatorId = `${id}-operator`, leaderId = `${id}-leader`, departmentId = `${id}-department`;
  const now = BigInt(Date.now());
  await db().userAccount.create({ data: { id: leaderId, displayName: 'Synthetic assigned general leader', status: 'active' } });
  await db().department.create({ data: { id: departmentId, name: 'Synthetic claim release department', headId: leaderId } });
  await db().userAccount.update({ where: { id: leaderId }, data: { primaryDeptId: departmentId } });
  await db().userAccount.create({ data: { id: operatorId, displayName: 'Synthetic combined execution operator', status: 'active', primaryDeptId: departmentId } });
  for (const [userId, canonicalId] of [[leaderId, 'role-admin'], [operatorId, 'role-sales']]) {
    const configured = `${userId}-configured-role`;
    await db().role.upsert({ where: { id: canonicalId }, update: {}, create: { id: canonicalId, name: `Synthetic canonical ${canonicalId}`, isSystem: true } });
    await db().role.create({ data: { id: configured, name: 'Synthetic explicit release scopes', isSystem: false } });
    await db().userRole.create({ data: { id: `${userId}-canonical`, userId, roleId: canonicalId, departmentId } });
    await db().userRole.create({ data: { id: `${userId}-configured`, userId, roleId: configured, departmentId } });
    for (const scope of scopes) {
      const p = await db().permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-permission-${scope}`, scope } });
      await db().rolePermission.create({ data: { id: `${userId}-${scope}`, roleId: configured, permissionId: p.id } });
    }
  }
  const token = async (userId: string) => {
    const current = await createPermissionService({ prisma: db() }).getUserPermissionContext(userId);
    expect(current).not.toBeNull(); expect(current!.scopes).toEqual(expect.arrayContaining(scopes));
    return auth.signToken({ userId, roles: current!.legacyRoleCodes, roleIds: current!.roleIds,
      departmentIds: current!.departmentIds, permissions: current!.scopes, authorizationLoaded: true });
  };
  const operatorToken = await token(operatorId), leaderToken = await token(leaderId);
  const customer = await db().relation.create({ data: { id: `${id}-customer`, name: 'Synthetic claim customer', category: 'Customer', type: 'Company',
    isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now, salesRepIds: [operatorId] } });
  await db().claimCase.create({ data: { id, caseNumber: id, customerRelationId: customer.id, customerName: customer.name,
    problemDesc: 'Independent physical repair/replacement acceptance', reportedAt: '2026-10-01', reportedBy: operatorId, createdAt: now, updatedAt: now } });
  const warehouse = await db().warehouse.create({ data: { id: `${id}-warehouse`, code: `${id}-WH`, name: 'Synthetic release warehouse', type: 'Main', createdAt: now, updatedAt: now } });
  const station = await db().workStation.create({ data: { id: `${id}-station`, code: `${id}-ST`, name: 'Synthetic repair station', type: 'Other', createdAt: now, updatedAt: now } });
  const materialCode = `${id}-SKU`, notify = vi.fn(), application = app(db(), notify);
  const added = await request(application).post(`/api/v1/claims/${id}/dispositions`).set('Authorization', `Bearer ${operatorToken}`)
    .send({ kind, materialCode, quantity: '2.5', unit: 'M', returnDisposition: kind === 'Repair' ? 'Repair' : 'Scrap' });
  expect(added.status, diagnostic(added.body)).toBe(201);
  const dispositionId = added.body.disposition.id as string, approvalId = added.body.approvalRequestId as string;
  expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: 'pending', requesterId: operatorId,
    reviewerId: leaderId, actionType: 'aftersales:claim-disposition', targetType: 'ClaimDisposition', targetId: dispositionId });
  const decision = await request(application).post(`/api/v1/approvals/${approvalId}/decide`).set('Authorization', `Bearer ${leaderToken}`)
    .send({ status: 'approved', decisionNote: 'Actual synthetic assigned general-leader decision' });
  expect(decision.status, diagnostic(decision.body)).toBe(200);
  const decisionFact = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  expect(decisionFact.status).toBe('approved'); expect(decisionFact.decidedAt).toBeInstanceOf(Date);
  const decisionAudits = await db().auditLog.findMany({ where: { targetId: approvalId, action: 'approve_business_request' } });
  expect(decisionAudits).toHaveLength(1); expect(decisionAudits[0].actorId).toBe(leaderId);
  const advanced = await request(application).post(`/api/v1/claims/dispositions/${dispositionId}/approve`).set('Authorization', `Bearer ${leaderToken}`).send({});
  expect(advanced.status, diagnostic(advanced.body)).toBe(200);
  expect(await db().claimDisposition.findUniqueOrThrow({ where: { id: dispositionId } })).toMatchObject({ status: 'Approved', approverId: leaderId });
  const executed = await request(application).post(`/api/v1/claims/dispositions/${dispositionId}/execute`).set('Authorization', `Bearer ${operatorToken}`)
    .send({ clientRequestId: `${key}-execute`, warehouseId: warehouse.id, ...(kind === 'Repair' ? { workStationId: station.id } : {}) });
  expect(executed.status, diagnostic(executed.body)).toBe(200);
  const d = await db().claimDisposition.findUniqueOrThrow({ where: { id: dispositionId } }); expect(d.status).toBe('Executed');
  const line = await db().returnReceiptLine.findFirstOrThrow({ where: { claimDispositionId: dispositionId } });
  expect(line.expectedQuantity.toString()).toBe('2.5'); expect(line.receivedQuantity.toString()).toBe('0');
  const returnedItem = await db().inventoryItem.create({ data: { id: `${id}-returned-batch`, warehouseId: warehouse.id, materialCode, description: 'Actual isolated returned batch',
    batchNumber: `${id}-RETURN`, unit: 'M', quantity: 0, lockedQuantity: 0, ownership: 'Owned', createdAt: now, updatedAt: now } });
  return { id, kind, operatorId, leaderId, operatorToken, leaderToken, customer, warehouse, station, materialCode, dispositionId, approvalId,
    returnLineId: line.id, receiptId: line.returnReceiptId, workOrderId: d.repairWorkOrderId, shipmentId: d.replacementShipmentId,
    returnedItem, notify, app: application, receivedEventId: '' };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function post(f: Fixture, path: string, payload: any, token = f.operatorToken, application = f.app) {
  return request(application).post(`/api/v1/${path}`).set('Authorization', `Bearer ${token}`).send(payload);
}
async function receive(f: Fixture) {
  const response = await post(f, `return-receipt-lines/${f.returnLineId}/receive`, { clientRequestId: `${f.id}-receive`, itemId: f.returnedItem.id, quantity: '2.5', unit: 'M' });
  expect(response.status, diagnostic(response.body)).toBe(200); f.receivedEventId = response.body.receivedEventId;
  expect(f.receivedEventId).toEqual(expect.any(String));
  const item = await db().inventoryItem.findUniqueOrThrow({ where: { id: f.returnedItem.id } });
  expect(item.quantity.toString()).toBe('2.5'); expect(item.lockedQuantity.toString()).toBe('2.5');
}
const startBody = { clientRequestId: 'actual-start', notes: 'Actual batch started' };
const completeBody = { clientRequestId: 'actual-complete', completedQuantity: '2.5', unit: 'M' };
const passBody = (key = 'actual-pass') => ({ clientRequestId: key, inspectedQuantity: '2.5', passedQuantity: '2.5', unit: 'M', result: 'pass' });
async function repair(f: Fixture, action: string, body: any, token = f.operatorToken) { return post(f, `repair-work-orders/${f.workOrderId}/${action}`, body, token); }
async function completed(f: Fixture) {
  await receive(f);
  const started = await repair(f, 'start', startBody); expect(started.status, diagnostic(started.body)).toBe(200);
  const done = await repair(f, 'complete', completeBody); expect(done.status, diagnostic(done.body)).toBe(200);
  expect(await db().repairWorkOrder.findUniqueOrThrow({ where: { id: f.workOrderId! } })).toMatchObject({ status: 'Completed', needsReinspection: true });
}
async function passed(f: Fixture) { await completed(f); const qc = await repair(f, 'inspections', passBody()); expect(qc.status, diagnostic(qc.body)).toBe(201); return qc; }
async function returnDraft(f: Fixture) {
  const response = await repair(f, 'return-shipment', { clientRequestId: 'actual-return-draft', shippingMethod: 'Pickup' });
  expect(response.status, diagnostic(response.body)).toBe(201); f.shipmentId = response.body.shipment.id; return response;
}
async function patch(f: Fixture, payload: any, application = f.app) {
  return request(application).patch(`/api/v1/shipping/${f.shipmentId}`).set('Authorization', `Bearer ${f.operatorToken}`).send(payload);
}
async function book(f: Fixture) { const r = await patch(f, { status: 'Booked', shippingMethod: 'Pickup' }); expect(r.status, diagnostic(r.body)).toBe(200); f.notify.mockClear(); }
async function stock(f: Fixture, label: string, quantity = '5', ownership = 'Owned', orderId: string | null = null) {
  const now = BigInt(Date.now());
  return db().inventoryItem.create({ data: { id: `${f.id}-${label}`, warehouseId: f.warehouse.id, materialCode: f.materialCode, description: 'Synthetic selected exact physical stock',
    batchNumber: `${f.id}-${label}-batch`, quantity, unit: 'M', lockedQuantity: 0, ownership, orderId, createdAt: now, updatedAt: now } });
}
async function bind(f: Fixture, itemId: string, overrides: any = {}) {
  return post(f, `claim-shipments/${f.shipmentId}/stock`, { clientRequestId: 'actual-selection', expectedRevision: 0, items: [{ itemId, quantity: '2.5', unit: 'M' }], ...overrides });
}
async function state(f: Fixture) {
  const repairs = await db().repairWorkOrder.findMany({ where: { claimCaseId: f.id }, orderBy: { id: 'asc' } });
  const d = await db().claimDisposition.findUniqueOrThrow({ where: { id: f.dispositionId } });
  const shipmentIds = [d.replacementShipmentId, ...repairs.map(row => row.reshipmentId)].filter((id): id is string => Boolean(id));
  const items = await db().inventoryItem.findMany({ where: { warehouseId: f.warehouse.id }, orderBy: { id: 'asc' } });
  const ids = [f.id, f.dispositionId, f.approvalId, f.returnLineId, f.receiptId, ...repairs.map(row => row.id), ...shipmentIds];
  return { disposition: d, claim: await db().claimCase.findUniqueOrThrow({ where: { id: f.id } }), repairs, items,
    receipt: await db().returnReceipt.findUniqueOrThrow({ where: { id: f.receiptId } }),
    returnLines: await db().returnReceiptLine.findMany({ where: { returnReceiptId: f.receiptId }, orderBy: { id: 'asc' } }),
    inspections: await db().repairInspection.findMany({ where: { repairWorkOrderId: { in: repairs.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    shipments: await db().shipment.findMany({ where: { id: { in: shipmentIds } }, orderBy: { id: 'asc' } }),
    packing: await db().shipmentLine.findMany({ where: { shipmentId: { in: shipmentIds } }, orderBy: { id: 'asc' } }),
    cartons: await db().shipmentCarton.findMany({ where: { shipmentId: { in: shipmentIds } }, orderBy: { id: 'asc' } }),
    events: await db().shipmentEvent.findMany({ where: { shipmentId: { in: shipmentIds } }, orderBy: { id: 'asc' } }),
    movements: await db().stockMovement.findMany({ where: { itemId: { in: items.map(row => row.id) } }, orderBy: { id: 'asc' } }),
    // Mandatory domain facts and shipping mutation logs; exclude optional legacy
    // fire-and-forget claim-route logs from no-write assertions.
    audits: await db().auditLog.findMany({ where: { targetId: { in: ids }, OR: [{ action: { startsWith: 'CLAIM_' } },
      { action: { in: ['execute', 'approve_business_request', 'create_shipment', 'update_shipment', 'PACKING_LINES_REPLACE'] } }] }, orderBy: { id: 'asc' } }),
    references: await db().entityReference.findMany({ where: { OR: [{ ownerId: { in: ids } }, { targetId: { in: ids } }] }, orderBy: { id: 'asc' } }),
    links: await db().entityLink.findMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] }, orderBy: { id: 'asc' } }),
  };
}
async function deniedShip(f: Fixture) {
  const before = await state(f); f.notify.mockClear(); const response = await patch(f, { status: 'Shipped' });
  console.log(diagnostic({ probe: 'claim-shipment-release-denied', variant: f.id, http: response.status, error: response.body }));
  expect(response.status, diagnostic(response.body)).toBe(409); expect(await state(f)).toEqual(before); expect(f.notify).not.toHaveBeenCalled();
}
async function sourceOrder(f: Fixture, label: string, customerRelationId: string) {
  return db().order.create({ data: { id: `${f.id}-${label}`, customer: f.customer.name, customerRelationId,
    product: f.materialCode, type: 'Fabric', quantity: 5, status: 'Closed', dueDate: '2026-10-01', quoteAmount: 0, currency: 'CNY' } });
}
/** Only substitute the audit FK input, and let actual SQL throw P2003. */
function sqlFault(f: Fixture) {
  const observed: { injections: number; code?: string; quantity?: string; locked?: string; movements?: number } = { injections: 0 };
  const database = new Proxy(db(), { get(target, property) {
    if (property === '$transaction') return (callback: any, options?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
      if (field === 'auditLog') return new Proxy(client.auditLog, { get(delegate, method) {
        if (method === 'create') return async (args: any) => {
          if (args.data.action !== 'CLAIM_SHIPMENT_RELEASED') return delegate.create(args);
          observed.injections++;
          const item = await client.inventoryItem.findUniqueOrThrow({ where: { id: f.returnedItem.id } });
          observed.quantity = item.quantity.toString(); observed.locked = item.lockedQuantity.toString();
          observed.movements = await client.stockMovement.count({ where: { referenceType: 'Shipment', referenceId: f.shipmentId! } });
          try { return await delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-missing-actor` } }); }
          catch (error: any) { observed.code = error.code; throw error; }
        };
        const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
    } })), options);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database, observed };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} not reached`)), 15000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

describe.sequential('actual claim repair and precise replacement shipment release in real PG', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
      directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe(`/${name}`);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(url.port).toBe(port); expect(Boolean(directory)).toBe(true);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify actual PG identity BEFORE any fixture write').toEqual([{ name, directory, port: Number(port) }]);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('CRS01 actual receive/start/complete/QC and immutable same-request retries; missing receipt, partial completion and altered retry refuse', async () => {
    const f = await fixture('repair-progress', 'Repair'); const beforeReceive = await state(f);
    expect((await repair(f, 'start', startBody)).status).toBe(409); expect(await state(f)).toEqual(beforeReceive);
    await receive(f); const beforeStart = await state(f);
    expect((await repair(f, 'complete', completeBody)).status).toBe(409); expect(await state(f)).toEqual(beforeStart);
    const started = await repair(f, 'start', startBody); expect(started.status, diagnostic(started.body)).toBe(200);
    const startedState = await state(f); const startRetry = await repair(f, 'start', startBody);
    expect(startRetry.status).toBe(200); expect(startRetry.body.replayed).toBe(true); expect(startRetry.body.repairEventId).toBe(started.body.repairEventId); expect(await state(f)).toEqual(startedState);
    for (const change of [{ completedQuantity: '2.4' }, { unit: 'YD' }]) {
      expect((await repair(f, 'complete', { ...completeBody, ...change })).status).toBe(409); expect(await state(f)).toEqual(startedState);
    }
    const done = await repair(f, 'complete', completeBody); expect(done.status, diagnostic(done.body)).toBe(200);
    const completedState = await state(f), completeRetry = await repair(f, 'complete', completeBody);
    expect(completeRetry.status).toBe(200); expect(completeRetry.body.replayed).toBe(true); expect(await state(f)).toEqual(completedState);
    const qc = await repair(f, 'inspections', passBody()); expect(qc.status, diagnostic(qc.body)).toBe(201);
    const inspected = await state(f); const retry = await repair(f, 'inspections', passBody());
    expect(retry.status).toBe(201); expect(retry.body.inspection.id).toBe(qc.body.inspection.id); expect(retry.body.replayed).toBe(true); expect(await state(f)).toEqual(inspected);
    for (const [token, changed] of [[f.leaderToken, passBody()], [f.operatorToken, { ...passBody(), result: 'fail', passedQuantity: '0' }]] as const) {
      expect((await repair(f, 'inspections', changed, token)).status).toBe(409); expect(await state(f)).toEqual(inspected);
    }
    expect(inspected.repairs[0]).toMatchObject({ status: 'Completed', needsReinspection: true });
    expect(inspected.audits.filter(row => row.action === 'CLAIM_REPAIR_STARTED')).toHaveLength(1);
    expect(inspected.audits.filter(row => row.action === 'CLAIM_REPAIR_COMPLETED')).toHaveLength(1);
    expect(inspected.audits.filter(row => row.action === 'CLAIM_REPAIR_INSPECTED')).toHaveLength(1);
    expect(inspected.inspections[0]).toMatchObject({ result: 'pass', inspectedBy: f.operatorId });
  }, 60000);

  it('CRS02 a later real failed QC blocks an existing return draft; replaying old pass does not release it; new actual pass permits retry', async () => {
    const f = await fixture('latest-quality', 'Repair'); const old = await passed(f); await returnDraft(f); await book(f);
    const failed = await repair(f, 'inspections', { clientRequestId: 'later-fail', inspectedQuantity: '2.5', passedQuantity: '0', unit: 'M', result: 'fail' });
    expect(failed.status, diagnostic(failed.body)).toBe(201); expect(failed.body.inspection.id).not.toBe(old.body.inspection.id); await deniedShip(f);
    const beforeReplay = await state(f), replay = await repair(f, 'inspections', passBody());
    expect(replay.status).toBe(201); expect(replay.body.inspection.id).toBe(old.body.inspection.id); expect(await state(f)).toEqual(beforeReplay); await deniedShip(f);
    const latest = await repair(f, 'inspections', passBody('actual-pass-after-fail')); expect(latest.status, diagnostic(latest.body)).toBe(201);
    const shipped = await patch(f, { status: 'Shipped' }); expect(shipped.status, diagnostic(shipped.body)).toBe(200);
    const release = (await state(f)).audits.find(row => row.action === 'CLAIM_SHIPMENT_RELEASED');
    expect((release?.detail as any).claimShipment.repairFact.inspectionId).toBe(latest.body.inspection.id);
  }, 60000);

  it('CRS03 actual return draft retries keep one ticket; Shipped unlocks and ships the exact received batch and completes projections once', async () => {
    const f = await fixture('repair-return', 'Repair'); const qc = await passed(f); const draft = await returnDraft(f), afterDraft = await state(f);
    expect((await returnDraft(f)).body.returnShipmentEventId).toBe(draft.body.returnShipmentEventId); expect(await state(f)).toEqual(afterDraft);
    const wrongRetry = await repair(f, 'return-shipment', { clientRequestId: 'actual-return-draft', shippingMethod: 'Courier' });
    expect(wrongRetry.status).toBe(409); expect(await state(f)).toEqual(afterDraft);
    await book(f); const shipped = await patch(f, { status: 'Shipped' }); expect(shipped.status, diagnostic(shipped.body)).toBe(200);
    const after = await state(f), item = after.items.find(row => row.id === f.returnedItem.id)!;
    expect(after.shipments).toHaveLength(1); expect(after.shipments[0].status).toBe('Shipped'); expect(after.repairs[0].status).toBe('Shipped');
    expect(after.returnLines[0].status).toBe('Dispositioned'); expect(after.receipt.status).toBe('Dispositioned');
    expect(item.quantity.toString()).toBe('0'); expect(item.lockedQuantity.toString()).toBe('0'); expect(item.ownership).toBe('Owned');
    const shippedMovements = after.movements.filter(row => row.referenceType === 'Shipment' && row.referenceId === f.shipmentId);
    expect(shippedMovements).toHaveLength(2); expect(shippedMovements.map(row => row.type).sort()).toEqual(['Outbound', 'Unlock']);
    for (const row of shippedMovements) { expect(row.itemId).toBe(f.returnedItem.id); expect(row.quantity.toString()).toBe('2.5'); expect(row.unit).toBe('M'); expect(row.operator).toBe(f.operatorId); }
    const disposed = after.audits.find(row => row.action === 'CLAIM_RETURN_DISPOSED')!;
    expect((disposed.detail as any).claimReturn).toMatchObject({ outcome: 'RepairedReturned', parameters: { receivedEventId: f.receivedEventId },
      shipmentId: f.shipmentId, inspectionId: qc.body.inspection.id, repairWorkOrderId: f.workOrderId });
    expect(after.audits.filter(row => row.action === 'CLAIM_SHIPMENT_RELEASED')).toHaveLength(1);
    expect(after.audits.filter(row => row.action === 'CLAIM_REPAIR_RETURNED')).toHaveLength(1); expect(f.notify).toHaveBeenCalledTimes(1);
    // Same-status transport PATCH may add its normal update audit, but never a
    // second domain release, stock deduction, returned fact or node event.
    const repeated = await patch(f, { status: 'Shipped' }); expect(repeated.status, diagnostic(repeated.body)).toBe(200); const again = await state(f);
    expect(again.items).toEqual(after.items); expect(again.movements).toEqual(after.movements); expect(again.events).toEqual(after.events);
    expect(again.audits.filter(row => row.action.startsWith('CLAIM_'))).toEqual(after.audits.filter(row => row.action.startsWith('CLAIM_')));
  }, 60000);

  it('CRS04 Replace binds explicit Owned stock, keeps selection history immutable and ships only the selected physical batch', async () => {
    const f = await fixture('owned-replacement', 'Replace'); await receive(f);
    const selected = await stock(f, 'selected'), unselected = await stock(f, 'unselected');
    const bound = await bind(f, selected.id); expect(bound.status, diagnostic(bound.body)).toBe(200); expect(bound.body).toMatchObject({ revision: 1, replayed: false });
    const beforeReplay = await state(f); const replay = await bind(f, selected.id); expect(replay.status).toBe(200); expect(replay.body).toMatchObject({ revision: 1, replayed: true }); expect(await state(f)).toEqual(beforeReplay);
    const changed = await bind(f, unselected.id); expect(changed.status).toBe(409); expect(await state(f)).toEqual(beforeReplay);
    await book(f); const before = await state(f), shipped = await patch(f, { status: 'Shipped' }); expect(shipped.status, diagnostic(shipped.body)).toBe(200); const after = await state(f);
    expect(after.items.find(row => row.id === selected.id)?.quantity.toString()).toBe('2.5');
    expect(after.items.find(row => row.id === unselected.id)).toEqual(before.items.find(row => row.id === unselected.id));
    expect(after.items.find(row => row.id === f.returnedItem.id)).toEqual(before.items.find(row => row.id === f.returnedItem.id));
    const outbound = after.movements.filter(row => row.referenceId === f.shipmentId); expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ type: 'Outbound', itemId: selected.id, unit: 'M', operator: f.operatorId }); expect(outbound[0].quantity.toString()).toBe('2.5');
    expect(after.shipments[0]).toMatchObject({ status: 'Shipped', orderId: null, customerRelationId: f.customer.id });
    expect((after.audits.find(row => row.action === 'CLAIM_SHIPMENT_RELEASED')!.detail as any).claimShipment).toMatchObject({ stockRevision: 1, stockBindingAuditId: bound.body.stockBindingEventId });
  }, 60000);

  it('CRS05 Transferred stock requires its real source Order customer, rechecked at shipping; matching stock keeps transferred ownership', async () => {
    const f = await fixture('transferred-entitlement', 'Replace'); await receive(f);
    const now = BigInt(Date.now()); const other = await db().relation.create({ data: { id: `${f.id}-other-customer`, name: f.customer.name,
      category: 'Customer', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
    const order = await sourceOrder(f, 'actual-source-order', other.id); const selected = await stock(f, 'customer-owned', '5', 'Transferred', order.id);
    const beforeWrong = await state(f); expect((await bind(f, selected.id)).status).toBe(409); expect(await state(f)).toEqual(beforeWrong);
    // Independent entitlement mutation in this isolated fixture: same display
    // name was insufficient; only the actual customerRelationId is authoritative.
    await db().order.update({ where: { id: order.id }, data: { customerRelationId: f.customer.id } });
    const bound = await bind(f, selected.id); expect(bound.status, diagnostic(bound.body)).toBe(200);
    expect(bound.body.items[0].entitlement).toEqual({ orderId: order.id, customerRelationId: f.customer.id });
    await book(f); await db().order.update({ where: { id: order.id }, data: { customerRelationId: other.id } }); await deniedShip(f);
    await db().order.update({ where: { id: order.id }, data: { customerRelationId: f.customer.id } });
    const shipped = await patch(f, { status: 'Shipped' }); expect(shipped.status, diagnostic(shipped.body)).toBe(200);
    const item = await db().inventoryItem.findUniqueOrThrow({ where: { id: selected.id } }); expect(item.quantity.toString()).toBe('2.5'); expect(item.ownership).toBe('Transferred'); expect(item.orderId).toBe(order.id);
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: f.shipmentId!, itemId: selected.id, type: 'Outbound' } })).toBe(1);
  }, 60000);

  it('CRS06 exact quantity/unit must bind; a real intervening stock movement causes shortage refusal with zero release writes and retry after replenishment', async () => {
    const f = await fixture('stock-shortage', 'Replace'); await receive(f); const selected = await stock(f, 'selected');
    const before = await state(f);
    for (const item of [{ itemId: selected.id, quantity: '2.4', unit: 'M' }, { itemId: selected.id, quantity: '2.5', unit: 'KG' }]) {
      expect((await bind(f, selected.id, { items: [item] })).status).toBe(409); expect(await state(f)).toEqual(before);
    }
    const bound = await bind(f, selected.id); expect(bound.status, diagnostic(bound.body)).toBe(200); await book(f);
    // Actual inventory domain writes, rather than a fake thrown shortage or a
    // manually planted shipping ledger. This is not the warehouse HTTP UI path.
    const inventory = createInventoryService(db()); await inventory.createStockMovement({ itemId: selected.id, type: 'Outbound', quantity: 3, unit: 'M',
      referenceType: 'AcceptanceInterveningMovement', referenceId: f.id, reason: 'Independent existing balance consumed elsewhere' }, f.operatorId);
    await deniedShip(f);
    await inventory.createStockMovement({ itemId: selected.id, type: 'Inbound', quantity: 3, unit: 'M', referenceType: 'AcceptanceReplenishment', referenceId: f.id }, f.operatorId);
    const shipped = await patch(f, { status: 'Shipped' }); expect(shipped.status, diagnostic(shipped.body)).toBe(200);
    expect((await db().inventoryItem.findUniqueOrThrow({ where: { id: selected.id } })).quantity.toString()).toBe('2.5');
    expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: f.shipmentId!, type: 'Outbound' } })).toBe(1);
  }, 60000);

  it('CRS07 mandatory real audit SQL P2003 after unlock/outbound rolls back stocks, facts, shipment and projections; actual retry commits once', async () => {
    const f = await fixture('release-audit-rollback', 'Repair'); await passed(f); await returnDraft(f); await book(f);
    const before = await state(f), fault = sqlFault(f), refused = await patch(f, { status: 'Shipped' }, app(fault.database, f.notify));
    console.log(diagnostic({ probe: 'claim-shipment-audit-sql-rollback', http: refused.status, observed: fault.observed, response: refused.body }));
    expect(fault.observed).toEqual({ injections: 1, code: 'P2003', quantity: '0', locked: '0', movements: 2 });
    expect(refused.status, diagnostic(refused.body)).toBe(500); expect(await state(f)).toEqual(before); expect(f.notify).not.toHaveBeenCalled();
    const retry = await patch(f, { status: 'Shipped' }); expect(retry.status, diagnostic(retry.body)).toBe(200);
    const after = await state(f); expect(after.repairs[0].status).toBe('Shipped'); expect(after.receipt.status).toBe('Dispositioned');
    expect(after.audits.filter(row => row.action === 'CLAIM_SHIPMENT_RELEASED')).toHaveLength(1);
    expect(after.movements.filter(row => row.referenceType === 'Shipment' && row.type === 'Outbound')).toHaveLength(1); expect(f.notify).toHaveBeenCalledTimes(1);
  }, 60000);

  it('CRS08 a packing edit started while actual Shipped transaction holds locks rechecks committed status and refuses; parallel later edits cannot mutate it', async () => {
    const f = await fixture('packing-release-race', 'Replace'); await receive(f); const selected = await stock(f, 'selected');
    const bound = await bind(f, selected.id); expect(bound.status, diagnostic(bound.body)).toBe(200); await book(f);
    const updated = deferred(), releaseCommit = deferred(), editEntered = deferred(), editLockAttempt = deferred(); let held = 0, lockAttempts = 0;
    const database = new Proxy(db(), { get(target, property) {
      if (property === '$transaction') return (callback: any, options?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
        if (field === 'shipment') return new Proxy(client.shipment, { get(delegate, method) {
          if (method === 'update') return async (args: any) => {
            const row = await delegate.update(args);
            if (args.where.id === f.shipmentId && args.data.status === 'Shipped') { held++; updated.resolve(); await releaseCommit.promise; }
            return row;
          };
          const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
        // This test deliberately holds a real row lock; expand only the harness
        // transaction deadline, without changing production transaction policy.
      } })), { ...options, timeout: 30000 });
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const packingDatabase = new Proxy(db(), { get(target, property) {
      if (property === '$transaction') return (callback: any, options?: any) => target.$transaction(tx => callback(new Proxy(tx, { get(client, field) {
        if (field === '$queryRawUnsafe') return (...args: any[]) => {
          // Start the real Prisma SQL promise; no fake row or mocked lock result.
          const queued = (client.$queryRawUnsafe as any)(...args).then((value: any) => value);
          if (String(args[0]).includes('"ClaimCase"') && args[1] === f.id) { lockAttempts++; editLockAttempt.resolve(); }
          return queued;
        };
        const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
      } })), options);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const shipping = patch(f, { status: 'Shipped' }, app(database, f.notify)); let editing: Promise<any> | undefined;
    try {
      await bounded(updated.promise, 'actual uncommitted Shipped SQL write');
      editing = request(app(packingDatabase, f.notify, url => { if (url === `/api/v1/shipping/${f.shipmentId}/lines`) editEntered.resolve(); }))
        .put(`/api/v1/shipping/${f.shipmentId}/lines`).set('Authorization', `Bearer ${f.operatorToken}`)
        .send({ lines: [{ productCode: f.materialCode, quantity: '99', unit: 'M' }] }).then(response => response);
      await bounded(editEntered.promise, 'concurrent actual packing HTTP request');
      await bounded(editLockAttempt.promise, 'concurrent packing actual claim row-lock SQL attempt');
    } finally { releaseCommit.resolve(); }
    const shipped = await shipping, blocked = await editing!;
    expect(held).toBe(1); expect(lockAttempts).toBe(1); expect(shipped.status, diagnostic(shipped.body)).toBe(200); expect(blocked.status, diagnostic(blocked.body)).toBe(409);
    expect(blocked.body.error.code).toBe('INVALID_CURRENT_STATUS');
    const after = await state(f); expect(after.packing).toHaveLength(1); expect(after.packing[0].quantity?.toString()).toBe('2.5');
    expect(after.items.find(row => row.id === selected.id)?.quantity.toString()).toBe('2.5'); expect(f.notify).toHaveBeenCalledTimes(1);
    const edits = await Promise.all([[], [{ productCode: f.materialCode, quantity: '100', unit: 'M' }]].map(lines =>
      request(f.app).put(`/api/v1/shipping/${f.shipmentId}/lines`).set('Authorization', `Bearer ${f.operatorToken}`).send({ lines })));
    expect(edits.map(response => response.status)).toEqual([409, 409]); expect(await state(f)).toEqual(after); expect(f.notify).toHaveBeenCalledTimes(1);
  }, 60000);
});
