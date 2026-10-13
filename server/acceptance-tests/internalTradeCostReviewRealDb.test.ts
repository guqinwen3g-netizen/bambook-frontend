/**
 * Opt-in native DR005/006/033 PG closure. No shared DB, seed, scheduler or
 * hand-written approved ApprovalRequest/Review/receipt facts.
 * Synthetic commercial orders/invoice originals and QC/customer observations
 * bound the input layer; actual domain services register QC/S/S and physical
 * shipments, actual HTTP creates/decides/confirms internal trade and both cost
 * reviews. This does not prove commercial document issuance or human UAT.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { createPermissionService } from '../src/auth/permissionService';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createInternalTradeRouter } from '../src/internalTrade/internalTradeRoute';
import { decodeInternalTransferPayload } from '../src/internalTrade/internalTransferService';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createApprovalKernelRouter } from '../src/approvals/approvalKernelRoute';
import { createOrderCostReviewRouter } from '../src/pricing/orderCostReviewRoute';
import { createOrderCostReviewFiles, readCurrentOrderCostReview } from '../src/pricing/orderCostReviewService';
import { COST_CATEGORIES } from '../src/pricing/orderCostReviewSource';
import { createProfitSheetService } from '../src/pricing/profitSheetService';
import { getConsolidatedProfitReport } from '../src/finance/reportService';
import { createProcurementService } from '../src/procurement/procurementService';
import { createShipment, updateShipment } from '../src/shipping/shipmentMutationService';
import { createAllocationService } from '../src/shipping/allocationService';
import { replaceShipmentLinesTx } from '../src/shipping/shipmentPackingService';
import { createQcRouter } from '../src/qc/qcRoute';
import { createSample, advanceSampleStage } from '../src/samples/sampleManageService';
import { PRIVATE_FILES_DIR } from '../src/lib/privateFiles';
import { createApprovalCreateService } from '../src/approvals/approvalCreateService';
import { createApprovalRoutingService } from '../src/approvals/approvalRoutingService';
import { __clearTeamShareCacheForTests, createTeamShareService } from '../src/teams/teamShareService';
import { buildInternalTradeCreateDraft, buildInternalTradeConfirmDraft, registerInternalTradeFlowTools } from '../src/agent/internalTradeFlow';
import { dispatchFromRegistry } from '../src/agent/toolDispatchRegistry';
import type { ActorContext } from '../src/agent/types';

const prefix = `acceptance-native-internal-${randomUUID()}`, auth = createAuthService();
const tradePath = '/api/v1/internal-trade', costPath = '/api/v1/pricing/order-cost-reviews';
const scopes = ['orders:read','order:internal_trade:write','pricing:read','sensitive:cost','invoices:read','invoices:write','invoices:reconcile'];
let prisma: PrismaClient | undefined, serial = 0;
let files: ReturnType<typeof createOrderCostReviewFiles>;
const db = (): any => { if (!prisma) throw Error('isolated internal trade DB has not been verified'); return prisma; };
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
async function actor(label: string, configured = scopes, canonical?: string, ceiling?: string[]) {
  const id = `${prefix}-${++serial}-${label}`, roleId = `${id}-custom-role`;
  await db().userAccount.create({ data: { id, displayName: 'Synthetic native operator', status: 'active' } });
  await db().role.create({ data: { id: roleId, name: 'Synthetic explicitly configured role', isSystem: false } });
  await db().userRole.create({ data: { id: `${id}-role`, userId: id, roleId } });
  for (const scope of configured) {
    const permission = await db().permission.upsert({ where: { scope }, update: {}, create: { id: `${prefix}-${scope}`, scope } });
    await db().rolePermission.create({ data: { id: `${id}-${scope}`, roleId, permissionId: permission.id } });
  }
  if (canonical) { await db().role.upsert({ where: { id: canonical }, update: {}, create: { id: canonical, name: 'Synthetic canonical identity', isSystem: true } }); await db().userRole.create({ data: { id: `${id}-canonical`, userId: id, roleId: canonical } }); }
  const context = await createPermissionService({ prisma: db() }).getUserPermissionContext(id); expect(context).not.toBeNull();
  return { id, roleId, token: auth.signToken({ userId: id, roles: context!.legacyRoleCodes, roleIds: context!.roleIds, permissions: context!.scopes, departmentIds: context!.departmentIds, authorizationLoaded: true, ...(ceiling ? { permissionCeiling: ceiling } : {}) }) };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function cappedActor(who: Actor, permissionCeiling: string[]): Actor {
  const { exp: _expiry, iat: _issuedAt, ...signed } = auth.verifyToken(who.token)! as ReturnType<typeof auth.verifyToken> & { exp?: number; iat?: number };
  return { ...who, token: auth.signToken({ ...signed, permissionCeiling }) };
}
function app(database = db(), requireAuth = true) {
  const value = express(); value.set('json replacer', (_key: string, item: unknown) => typeof item === 'bigint' ? item.toString() : item); value.use(express.json());
  value.use(createAccountStatusGuard(db())); value.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  value.use(tradePath, createInternalTradeRouter({ prisma: database, requireAuth }));
  value.use('/api/v1/approvals', createApprovalRouter({ prisma: database, requireAuth: true }));
  value.use('/api/v1/approvals-kernel', createApprovalKernelRouter({ prisma: database, requireAuth: true }));
  value.use(costPath, createOrderCostReviewRouter({ prisma: database, requireAuth: true, apiKeys: new Set(), files }));
  value.use('/api/v1/qc', createQcRouter({ prisma: database, requireAuth: true, apiKeys: new Set() }));
  return value;
}
const post = (who: Actor, url: string, body: unknown, database = db()) => request(app(database)).post(url).set('Authorization', `Bearer ${who.token}`).send(body);
const get = (who: Actor, url: string) => request(app()).get(url).set('Authorization', `Bearer ${who.token}`);

async function pair(label: string) {
  // These explicitly configured synthetic capabilities permit the genuine QC
  // prerequisite; they do not change any default company role or cost policy.
  const business = await actor(`${label}-business`, [...scopes, 'qc:read', 'qc:write'], 'role-finance'), leader = await actor(`${label}-leader`, [], 'role-sales-manager');
  const id = `${prefix}-pair-${++serial}-${label}`, now = BigInt(Date.now()), garmentId = `${id}-garment`, fabricId = `${id}-fabric`, garmentLineId = `${id}-GL`, fabricLineId = `${id}-FL`, materialCode = `${id}-fabric-material`;
  const requestDept = `${id}-request-dept`, supplyDept = `${id}-supply-dept`;
  for (const dept of [requestDept, supplyDept]) await db().department.create({ data: { id: dept, name: 'Synthetic native department', status: 'active', headId: leader.id } });
  await db().userAccount.update({ where: { id: business.id }, data: { primaryDeptId: requestDept } });
  for (const [orderId, lineId, internal, unit] of [[garmentId, garmentLineId, false, 'PC'], [fabricId, fabricLineId, true, 'M']] as const) {
    await db().order.create({ data: { id: orderId, customer: 'Synthetic commercial customer', product: 'Synthetic delivered product', type: internal ? 'Fabric' : 'Garment', businessLine: internal ? 'fabric' : 'garment', isInternalFabricTrade: internal, quantity: 100, status: 'Production', dueDate: '2099-11-01', poDate: '2099-11-01', deliveryTerms: 'FOB', quoteAmount: internal ? 3000 : 5000, ownerId: business.id, updatedAt: now } });
    await db().orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, quantity: 100, unit, unitPrice: internal ? 30 : 50, materialCode } });
  }
  const created = await post(business, tradePath, { requestDepartmentId: requestDept, supplyDepartmentId: supplyDept, garmentOrderId: garmentId, fabricOrderId: fabricId, garmentOrderLineId: garmentLineId, fabricOrderLineId: fabricLineId, materialCode, quantity: 100, unit: 'M', settlementPrice: 30, dueDate: '2099-11-01' });
  expect(created.status, diagnostic(created.body)).toBe(201);
  const { transfer, mirror, approvalRequestId } = created.body;
  const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalRequestId } });
  expect(approval).toMatchObject({ targetType: 'OrderInternalTransfer', targetId: transfer.id, reviewerId: leader.id, status: 'pending' });
  return { id, business, leader, garmentId, fabricId, garmentLineId, fabricLineId, materialCode, masterId: transfer.id as string, mirrorId: mirror.id as string, approvalId: approvalRequestId as string };
}
type Pair = Awaited<ReturnType<typeof pair>>;
async function decide(x: Pair, who = x.leader) {
  const result = await post(who, `/api/v1/approvals/${x.approvalId}/decide`, { status: 'approved', decisionNote: 'Synthetic assigned department leader approves the exact native price content' });
  expect(result.status, diagnostic(result.body)).toBe(200);
  const actual = await db().approvalRequest.findUniqueOrThrow({ where: { id: x.approvalId } }); expect(actual.status).toBe('approved');
  const audits = await db().auditLog.findMany({ where: { actorId: who.id, action: 'approve_business_request', targetId: x.approvalId } });
  expect(audits).toHaveLength(1); expect(audits[0].detail.approvalDecisionFact).toMatchObject({ status: 'approved', targetId: x.masterId, decisionActorId: who.id, contentFingerprint: actual.payload.contentFingerprint });
}
async function effective(x: Pair) { await decide(x); const result = await post(x.business, `${tradePath}/${x.masterId}/confirm`, {}); expect(result.status, diagnostic(result.body)).toBe(200); return result.body; }
async function nativeState(x: Pair) {
  return { pair: await db().orderInternalTransfer.findMany({ where: { id: { in: [x.masterId, x.mirrorId] } }, orderBy: { id: 'asc' } }), lines: await db().orderLine.findMany({ where: { id: { in: [x.garmentLineId, x.fabricLineId] } }, orderBy: { id: 'asc' } }), audits: await db().auditLog.findMany({ where: { targetType: 'OrderInternalTransfer', targetId: x.masterId }, orderBy: { id: 'asc' } }) };
}
async function priceState(x: Pair) {
  const approvals = await db().approvalRequest.findMany({ where: { targetType: 'OrderInternalTransfer', targetId: x.masterId }, orderBy: { id: 'asc' } });
  return { ...(await nativeState(x)), approvals,
    approvalAudits: await db().auditLog.findMany({ where: { targetType: 'ApprovalRequest', targetId: { in: approvals.map((row: any) => row.id) } }, orderBy: { id: 'asc' } }) };
}
async function revisionCommand(x: Pair, requestId = `${x.id}-price-revision`) {
  const original = await db().approvalRequest.findUniqueOrThrow({ where: { id: x.approvalId } });
  return { requestId, expectedContentFingerprint: original.payload.contentFingerprint, quantity: 80, settlementPrice: 25, dueDate: '2099-11-02', reason: 'Synthetic financial and business adjustment before recognition requires a new exact native price decision' };
}
async function shipment(x: Pair, side: 'fabric' | 'garment', ship = true) {
  const orderId = side === 'fabric' ? x.fabricId : x.garmentId, lineId = side === 'fabric' ? x.fabricLineId : x.garmentLineId, unit = side === 'fabric' ? 'M' : 'PC';
  // Native prerequisite with a distinct actual inspector and order owner.
  // A legacy PUT body is not an inspection signature or business decision.
  const inspector = await actor(`${x.id}-${side}-inspector`, ['qc:read', 'qc:write']);
  const coverage = await get(x.business, `/api/v1/qc/orders/${orderId}/inspection-scopes`);
  expect(coverage.status, diagnostic(coverage.body)).toBe(200);
  const whole = coverage.body.scopes.find((row: any) => row.scopeType === 'whole_order');
  expect(whole?.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const assigned = await post(x.business, '/api/v1/qc/assignments', {
    orderId, inspectionType: 'final', qcUserId: inspector.id, scopeType: 'whole_order',
    expectedScopeFingerprint: whole.scopeFingerprint, requestKey: randomUUID(),
  });
  expect(assigned.status, diagnostic(assigned.body)).toBe(201);
  const assignmentId = assigned.body.item.id;
  const started = await post(inspector, `/api/v1/qc/assignments/${assignmentId}/start`, {});
  expect(started.status, diagnostic(started.body)).toBe(200);
  const completed = await post(inspector, `/api/v1/qc/assignments/${assignmentId}/complete`, {
    expectedScopeFingerprint: whole.scopeFingerprint, requestKey: randomUUID(), report: {
      inspectionDate: '2026-10-02', result: 'pass', totalUnits: 100, passedUnits: 100,
      criticalDefects: 0, majorDefects: 0, minorDefects: 0,
    },
  });
  expect(completed.status, diagnostic(completed.body)).toBe(200);
  expect(completed.body.report).toMatchObject({ inspectedBy: inspector.id, approvedByBusiness: false });
  const report = completed.body.report;
  const signed = await post(inspector, `/api/v1/qc/reports/${report.id}/sign`, { role: 'qc' });
  expect(signed.status, diagnostic(signed.body)).toBe(200);
  const decided = await post(x.business, `/api/v1/qc/reports/${report.id}/business-decision`, {
    expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
    expectedContentFingerprint: report.contentFingerprint, decision: 'approved', requestKey: randomUUID(),
    reason: 'Synthetic native shipment prerequisite; no real goods or factory dispatch',
  });
  expect(decided.status, diagnostic(decided.body)).toBe(200);
  expect(decided.body.item).toMatchObject({ approvedByBusiness: true, businessApprover: x.business.id });
  if (side === 'fabric') {
    const created = await createSample({ prisma: db(), actorId: x.business.id, input: { type: 'ship', sourceOrderId: orderId } }); expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok) throw Error('actual S/S create failed');
    for (const action of ['start','qc','submit','confirm'] as const) { const result = await advanceSampleStage({ prisma: db(), sampleId: created.data.sample.id, action, actorId: x.business.id, input: { qcStatus: 'passed', customerStatus: 'approved', feedback: 'Synthetic customer observation', sentDate: '2099-11-01', feedbackDate: '2099-11-01' } }); expect(result.ok, diagnostic(result)).toBe(true); }
  }
  const created = await createShipment({ prisma: db(), actorId: x.business.id, input: { id: `${x.id}-${side}-shipment`, shipmentNumber: `${x.id}-${side}-shipment`, orderId, type: side === 'fabric' ? 'Internal' : 'Export', status: 'Booked', shippingMethod: 'Sea', vesselOrFlight: 'Synthetic ship', voyageNumber: 'S001', portOfLoading: 'Synthetic origin', portOfDischarge: 'Synthetic destination' } });
  expect(created.ok, diagnostic(created)).toBe(true); if (!created.ok || !created.data) throw Error('actual shipment create failed');
  const shipmentId = created.data.shipment.id;
  // Garment goods differ physically from the supplying fabric despite the legacy native line material anchor.
  if (side === 'garment') await db().$transaction((tx: any) => replaceShipmentLinesTx(tx, shipmentId, [{ productCode: `${x.id}-garment-goods`, productName: 'Synthetic garment goods', quantity: 100, unit: 'PC', cartons: 1 }], x.business.id));
  const allocated = await createAllocationService(db()).createAllocation(shipmentId, { orderId, orderLineId: lineId, plannedQty: 100, actualQty: 100, unit, status: 'Fulfilled' }, x.business.id);
  expect(allocated.ok, diagnostic(allocated)).toBe(true); if (!allocated.ok || !allocated.data) throw Error('actual allocation create failed');
  if (ship) { const result = await updateShipment({ prisma: db(), shipmentId, actorId: x.business.id, hasStatus: true, patch: { status: 'Shipped' } }); expect(result.ok, diagnostic(result)).toBe(true); }
  return { shipmentId, allocationId: allocated.data.allocation.id as string };
}
async function finishShipment(x: Pair, shipmentId: string) {
  for (const status of ['Arrived','Cleared','Delivered']) { const result = await updateShipment({ prisma: db(), shipmentId, actorId: x.business.id, hasStatus: true, patch: { status } }); expect(result.ok, diagnostic(result)).toBe(true); }
}
async function delivery(x: Pair, sh: Awaited<ReturnType<typeof shipment>>) {
  const command = { shipmentId: sh.shipmentId, allocationId: sh.allocationId, quantity: 100, deliveryDate: '2099-11-01', requestId: `${x.id}-delivery` };
  const response = await post(x.business, `${tradePath}/${x.masterId}/delivery`, command); expect(response.status, diagnostic(response.body)).toBe(200);
  const p = decodeInternalTransferPayload((await db().orderInternalTransfer.findUniqueOrThrow({ where: { id: x.masterId } })).memo)!;
  expect(p.status).toBe('Delivering'); expect(p.deliveries[0]).toMatchObject({ receivedQuantity: null, variance: null });
  return { command, deliveryId: p.deliveries[0].id };
}
const receipt = (x: Pair, deliveryId: string, quantity = 100, requestId = `${x.id}-receipt`, database = db()) => post(x.business, `${tradePath}/${x.masterId}/receipt`, { deliveryId, quantity, receivedDate: '2099-11-01', requestId }, database);
async function review(x: Pair, orderId: string, bill?: { invoiceId: string; purchaseOrderId: string; purchaseLineId: string }) {
  const uploaded = await request(app()).post(`${costPath}/${orderId}/evidence`).set('Authorization', `Bearer ${x.business.token}`).field('requestId', `${orderId}-proof`).field('note', 'Synthetic bill and complete native financial reconciliation original').attach('file', Buffer.from('%PDF-1.4\nSynthetic native reconciliation\n%%EOF'), 'native-reconciliation.pdf');
  expect(uploaded.status, diagnostic(uploaded.body)).toBe(201); const evidenceId = uploaded.body.evidence.id;
  const current = await get(x.business, `${costPath}/${orderId}`); expect(current.status, diagnostic(current.body)).toBe(200);
  const payload = decodeInternalTransferPayload((await db().orderInternalTransfer.findUniqueOrThrow({ where: { id: x.masterId } })).memo)!;
  const command = { sourceFingerprint: current.body.sourceFingerprint, bills: bill ? [{ invoiceId: bill.invoiceId, purchaseOrderId: bill.purchaseOrderId, purchaseLineIds: [bill.purchaseLineId], serviceDeliveryIds: [], treatment: 'cost', evidenceIds: [evidenceId] }] : [], supply: [], expenses: [], internalTransfers: [{ masterId: x.masterId, mirrorId: x.mirrorId, garmentOrderLineId: x.garmentLineId, fabricOrderLineId: x.fabricLineId, deliveryIds: payload.deliveries.map(row => row.id), evidenceIds: [evidenceId] }], coverage: Object.fromEntries(COST_CATEGORIES.map(category => [category, { status: category === 'procurement' ? 'verified' : 'not_applicable', note: 'Synthetic complete finance reconciliation by category', evidenceIds: [evidenceId] }])), expectedRevision: 0, requestId: `${orderId}-review`, note: 'Synthetic actual financial confirmation' };
  return { command, evidenceId };
}
function auditSqlFault(action: string) {
  const seen: any[] = [];
  const wrap = (client: any): any => new Proxy(client, { get(target, key) {
    if (key === '$transaction') return (work: any, options: any) => target.$transaction((tx: any) => work(wrap(tx)), options);
    if (key === 'auditLog') return new Proxy(target.auditLog, { get(delegate, method) {
      if (method === 'create') return async (args: any) => { if (args.data.action !== action) return delegate.create(args); try { return await delegate.create({ ...args, data: { ...args.data, actorId: `${prefix}-actual-missing-FK-actor` } }); } catch (error: any) { seen.push({ code: error.code, meta: error.meta }); throw error; } };
      const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }); return { database: wrap(db()), seen };
}

// Input-layer commercial orders/lines are synthetic. Tool approvals below are
// produced by real routing/create + assigned-reviewer decide, then actual commit
// registry/domain services consume them. This does not exercise Agent HTTP/UI.
async function newAgentSource(x: Pair, label: string) {
  const id = `${x.id}-agent-source-${label}`, garmentId = `${id}-garment`, fabricId = `${id}-fabric`;
  for (const [orderId, internal, unit] of [[garmentId, false, 'PC'], [fabricId, true, 'M']] as const) {
    await db().order.create({ data: { id: orderId, customer: 'Synthetic Agent input customer', product: 'Synthetic actual material', type: internal ? 'Fabric' : 'Garment', businessLine: internal ? 'fabric' : 'garment', isInternalFabricTrade: internal, quantity: 100, status: 'Production', dueDate: '2099-11-01', poDate: '2099-11-01', deliveryTerms: 'FOB', quoteAmount: internal ? 3000 : 5000, ownerId: x.business.id, updatedAt: BigInt(Date.now()) } });
    await db().orderLine.create({ data: { id: `${orderId}-line`, orderId, lineNumber: 1, quantity: 100, unit, unitPrice: internal ? 30 : 50, materialCode: x.materialCode } });
  }
  return { requestDepartmentId: `${x.id}-request-dept`, supplyDepartmentId: `${x.id}-supply-dept`, garmentOrderId: garmentId, fabricOrderId: fabricId, garmentOrderLineId: `${garmentId}-line`, fabricOrderLineId: `${fabricId}-line`, materialCode: x.materialCode, quantity: 100, unit: 'M', settlementPrice: 30, dueDate: '2099-11-01', requesterId: x.business.id };
}
function executionActor(who: Actor): ActorContext {
  const signed = auth.verifyToken(who.token)!;
  return { userId: signed.userId, roles: signed.roles, departmentIds: signed.departmentIds ?? [], permissionScopes: signed.permissions ?? [], permissionsAuthoritative: signed.authorizationLoaded === true, ...(signed.permissionCeiling !== undefined ? { permissionCeiling: signed.permissionCeiling } : {}), memoryScopes: [], knowledgeScopes: [], toolScopes: ['internal_trade'] };
}
async function nativeToolApproval(x: Pair, toolId: 'internal_trade.create' | 'internal_trade.confirm', draft: ReturnType<typeof buildInternalTradeCreateDraft>) {
  const created = await createApprovalCreateService({ prisma: db(), routingService: createApprovalRoutingService({ prisma: db() }) }).createBusinessApproval({ requesterId: x.business.id, actionType: `tool:${toolId}`, targetType: 'AgentTool', targetId: draft.subOperations[0].entityId, payload: { processDraft: draft }, risk: 'high' });
  expect(created).toMatchObject({ status: 'pending', requesterId: x.business.id, reviewerId: x.leader.id });
  const decided = await post(x.leader, `/api/v1/approvals/${created.id}/decide`, { status: 'approved', decisionNote: 'Synthetic assigned leader approves the exact original Agent draft' });
  expect(decided.status, diagnostic(decided.body)).toBe(200);
  expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ status: 'approved', requesterId: x.business.id });
  expect(await db().auditLog.count({ where: { targetId: created.id, actorId: x.leader.id, action: 'approve_business_request' } })).toBe(1);
  return created.id as string;
}
function toolCommit(who: Actor, toolId: 'internal_trade.create' | 'internal_trade.confirm', approvalId: string, input: Record<string, unknown> = {}) {
  return dispatchFromRegistry(db(), { toolId, approvalId, input }, { actorId: who.id, actor: executionActor(who) });
}
async function agentBusinessState(x: Pair, orders: string[], approvalId: string) {
  return {
    transfers: await db().orderInternalTransfer.findMany({ where: { orderId: { in: orders } }, orderBy: { id: 'asc' } }),
    lines: await db().orderLine.findMany({ where: { orderId: { in: orders } }, orderBy: { id: 'asc' } }),
    approvals: await db().approvalRequest.findMany({ where: { requesterId: x.business.id }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: x.business.id }, orderBy: { id: 'asc' } }),
    receipts: await db().agentCommitReceipt.findMany({ where: { approvalId }, orderBy: { id: 'asc' } }),
  };
}
function promiseSignal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function witnessCreateTransaction(pid: ReturnType<typeof promiseSignal<number>>) {
  return new Proxy(db(), { get(target, key) {
    if (key === '$transaction') return (work: any, options: any) => target.$transaction(async (tx: any) => {
      const [actual] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
      pid.resolve(actual.pid); return work(tx);
    }, options);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function waitForRealParentLock(waiterPid: number, blockerPid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [witness] = await db().$queryRawUnsafe('SELECT pg_blocking_pids($1::integer) AS blockers', waiterPid);
    if (witness.blockers.includes(blockerPid)) return witness;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Actual PostgreSQL writer never waited on the witnessed parent Order connection');
}

describe.sequential('V1G05 native internal supply → two actual reviews → consolidated profit', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || ''), name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME, directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT, sandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX;
    expect(Boolean(sandbox)).toBe(true); expect(url.protocol).toBe('postgresql:'); expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe(port); expect(url.pathname).toBe(`/${name}`); expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/); expect(Boolean(directory)).toBe(true); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
    expect(identity, 'verify actual identity before any fixture or evidence write').toEqual([{ name, directory, port: Number(port) }]);
    expect(process.env.BAMBOOK_PRIVATE_FILES_DIR).toBeTruthy(); expect(PRIVATE_FILES_DIR).toBe(process.env.BAMBOOK_PRIVATE_FILES_DIR);
    const relative = path.relative(await fs.realpath(sandbox!), await fs.realpath(PRIVATE_FILES_DIR)); expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
    files = createOrderCostReviewFiles();
    registerInternalTradeFlowTools();
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('ICR01 real native price decision, actual Shipped+receipt, both reviewed sides eliminate3000 once:5000-1200=3800', async () => {
    const x = await pair('whole'), now = BigInt(Date.now()), supplier = `${x.id}-supplier`, poId = `${x.id}-PO`, purchaseLineId = `${x.id}-PL`, invoiceId = `${x.id}-AP`, warehouse = `${x.id}-warehouse`, stock = `${x.id}-stock`;
    await db().relation.create({ data: { id: supplier, name: 'Synthetic external fabric supplier', category: 'Supplier', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
    await db().purchaseOrder.create({ data: { id: poId, poNumber: poId, orderId: x.fabricId, supplierRelationId: supplier, status: 'Confirmed', currency: 'CNY', totalAmount: 9999, orderDate: '2099-11-01', createdAt: now, updatedAt: now, lines: { create: { id: purchaseLineId, orderLineId: x.fabricLineId, kind: 'FinishedGoods', lineNumber: 1, materialCode: x.materialCode, description: 'Synthetic actual supplier goods', quantity: 100, unit: 'M', unitPrice: 99.99, amount: 9999, createdAt: now } } } });
    // Physical warehouse fixture exists before the native receipt resolves its destination.
    await db().warehouse.create({ data: { id: warehouse, code: warehouse, name: warehouse, type: 'Main', createdAt: now, updatedAt: now } });
    await createProcurementService(db()).createMaterialReceipt(poId, { receiptNumber: `${poId}-receipt`, receivedDate: '2099-11-01', totalReceived: 100, totalAccepted: 100, totalRejected: 0, lineReceipts: [{ lineId: purchaseLineId, accepted: 100, rejected: 0 }] }, x.business.id, { expectedOrderId: x.fabricId });
    await db().invoice.create({ data: { id: invoiceId, invoiceNumber: invoiceId, type: 'Payable', status: 'Issued', orderId: x.fabricId, customerRelationId: supplier, sourceType: 'PurchaseOrder', sourceId: poId, amount: 1200, currency: 'CNY', issueDate: '2099-11-01', createdAt: now, updatedAt: now } });
    await db().invoice.create({ data: { id: `${x.id}-AR`, invoiceNumber: `${x.id}-AR`, type: 'Receivable', status: 'Issued', orderId: x.garmentId, amount: 5000, currency: 'CNY', issueDate: '2099-11-01', createdAt: now, updatedAt: now } });
    // Physical source fixture only; actual shipment service must debit this stock and write Outbound.
    await db().inventoryItem.create({ data: { id: stock, warehouseId: warehouse, materialCode: x.materialCode, description: 'Synthetic previously received fabric inventory', quantity: 100, unit: 'M', currency: 'CNY', ownership: 'Owned', orderId: x.fabricId, createdAt: now, updatedAt: now } });
    await effective(x); const fabricShipment = await shipment(x, 'fabric'), shipped = await delivery(x, fabricShipment);
    expect((await db().inventoryItem.findUniqueOrThrow({ where: { id: stock } })).quantity.toString()).toBe('0'); expect(await db().stockMovement.count({ where: { referenceType: 'Shipment', referenceId: fabricShipment.shipmentId, type: 'Outbound' } })).toBe(1);
    const received = await receipt(x, shipped.deliveryId); expect(received.status, diagnostic(received.body)).toBe(200);
    const finalPair = await nativeState(x); expect(decodeInternalTransferPayload(finalPair.pair.find((row: any) => row.id === x.masterId).memo)).toMatchObject({ status: 'Closed', confirmedQuantity: 100, receipts: [expect.objectContaining({ actorId: x.business.id, quantity: 100 })] });
    await finishShipment(x, fabricShipment.shipmentId); const garmentShipment = await shipment(x, 'garment'); await finishShipment(x, garmentShipment.shipmentId);
    for (const [orderId, bill, revenue, cost] of [[x.fabricId, { invoiceId, purchaseOrderId: poId, purchaseLineId }, 3000, 1200], [x.garmentId, undefined, 5000, 3000]] as const) {
      const input = await review(x, orderId, bill); const confirmed = await post(x.business, `${costPath}/${orderId}/confirm`, input.command); expect(confirmed.status, diagnostic(confirmed.body)).toBe(201);
      expect(await readCurrentOrderCostReview(db(), orderId)).toMatchObject({ status: 'complete', actualRevenueCny: revenue, actualCostCny: cost });
      const sheet = await createProfitSheetService(db()).generateOrderProfitSheet(orderId, x.business.id, auth.verifyToken(x.business.token)!); expect(sheet.details.costEvidence).toMatchObject({ status: 'complete', actualRevenueCny: revenue, actualCostCny: cost });
    }
    expect(await db().invoice.count({ where: { orderId: x.fabricId, type: 'Receivable' } })).toBe(0);
    const report = await getConsolidatedProfitReport(db(), { from: '2099-11-01', to: '2099-11-01', actor: auth.verifyToken(x.business.token)! });
    expect(report).toMatchObject({ consolidatedRevenue: 5000, consolidatedCost: 1200, consolidatedProfit: 3800, elimination: { internalPurchase: 3000, internalSales: 3000, amount: 3000, discrepancy: 0 }, departments: { garment: { profit: 2000 }, fabric: { profit: 1800 } } });
  });
  it('ICR02 missing decision, nonassigned reviewer/self and approved-content changes cannot confirm or alter the pair', async () => {
    const x = await pair('approval-boundary'), foreign = await actor('foreign-leader', [], 'role-sales-manager'); const before = await nativeState(x);
    const pending = await post(x.business, `${tradePath}/${x.masterId}/confirm`, {}); expect(pending.status).toBe(409);
    for (const who of [foreign, x.business]) { const rejected = await post(who, `/api/v1/approvals/${x.approvalId}/decide`, { status: 'approved' }); expect(rejected.status).toBe(403); }
    expect(await nativeState(x)).toEqual(before); await decide(x);
    const approved = await nativeState(x); const changed = await post(x.business, `${tradePath}/${x.masterId}/confirm`, { confirmedQuantity: 80, confirmedDueDate: '2099-11-02' }); expect(changed.status).toBe(409); expect(await nativeState(x)).toEqual(approved);
    const exact = await post(x.business, `${tradePath}/${x.masterId}/confirm`, {}); expect(exact.status, diagnostic(exact.body)).toBe(200);
  });
  it('ICR03 Draft/Booked transport, wrong allocation and duplicate material without stable lines cannot supply received facts', async () => {
    const x = await pair('transport-boundary'); await effective(x); const sh = await shipment(x, 'fabric', false), before = await nativeState(x);
    for (const allocationId of [sh.allocationId, `${x.id}-foreign-allocation`]) { const rejected = await post(x.business, `${tradePath}/${x.masterId}/delivery`, { shipmentId: sh.shipmentId, allocationId, quantity: 100, requestId: `${allocationId}-attempt` }); expect(rejected.status).toBe(409); }
    expect(await nativeState(x)).toEqual(before);
    const y = await pair('stable-duplicate');
    await db().orderLine.create({ data: { id: `${y.id}-second-line`, orderId: y.fabricId, lineNumber: 2, materialCode: y.materialCode, quantity: 1, unit: 'M' } });
    const ambiguousBefore = await nativeState(y);
    const ambiguous = await post(y.business, tradePath, { requestDepartmentId: `${y.id}-request-dept`, supplyDepartmentId: `${y.id}-supply-dept`, garmentOrderId: y.garmentId, fabricOrderId: y.fabricId, materialCode: y.materialCode, quantity: 100, unit: 'M', settlementPrice: 30, dueDate: '2099-11-01' });
    expect(ambiguous.status).toBe(409); expect(await nativeState(y)).toEqual(ambiguousBefore);
    await decide(y); const unchanged = await nativeState(y); const altered = await post(y.business, `${tradePath}/${y.masterId}/confirm`, {}); expect(altered.status, diagnostic(altered.body)).toBe(200);
    // Explicit stable identity updates exactly the originally approved line, never every matching code.
    expect((await db().orderLine.findUniqueOrThrow({ where: { id: `${y.id}-second-line` } })).internalTransferPrice).toBeNull(); expect(unchanged.lines.map((row: any) => row.id)).toEqual([y.fabricLineId,y.garmentLineId].sort());
  });
  it('ICR04 short receipt remains Delivering with immutable variance; replay cannot mutate and later balance closes', async () => {
    const x = await pair('short-receipt'); await effective(x); const d = await delivery(x, await shipment(x, 'fabric'));
    const partial = await receipt(x, d.deliveryId, 80); expect(partial.status, diagnostic(partial.body)).toBe(200);
    const before = await nativeState(x), p = decodeInternalTransferPayload(before.pair.find((row: any) => row.id === x.masterId).memo)!;
    expect(p).toMatchObject({ status: 'Delivering', deliveries: [expect.objectContaining({ receivedQuantity: 80, variance: -20 })], receipts: [expect.objectContaining({ quantity: 80 })] });
    expect((await receipt(x, d.deliveryId, 80)).status).toBe(200); expect(await nativeState(x)).toEqual(before);
    expect((await receipt(x, d.deliveryId, 100)).status).toBe(409); expect(await nativeState(x)).toEqual(before);
    const remainder = await receipt(x, d.deliveryId, 20, `${x.id}-receipt-remainder`); expect(remainder.status, diagnostic(remainder.body)).toBe(200);
    const closed = decodeInternalTransferPayload((await db().orderInternalTransfer.findUniqueOrThrow({ where: { id: x.masterId } })).memo)!;
    expect(closed.status).toBe('Closed'); expect(closed.receipts?.map(row => row.quantity)).toEqual([80,20]); expect(closed.deliveries[0].variance).toBe(0);
  });
  it('ICR05 read requires current active grants, capped credential and BOTH heterogeneous order scopes before pagination', async () => {
    const x = await pair('read-scope'), reader = await actor('self-reader', ['orders:read']);
    await db().order.update({ where: { id: x.garmentId }, data: { ownerId: reader.id } });
    expect((await get(reader, `${tradePath}/${x.masterId}`)).status).toBe(404); const hidden = await get(reader, tradePath); expect(hidden.status).toBe(200); expect(hidden.body).toMatchObject({ items: [], total: 0 });
    expect((await get(reader, `${costPath}/${x.garmentId}`)).status).toBe(403);
    await db().order.update({ where: { id: x.fabricId }, data: { ownerId: reader.id } }); const visible = await get(reader, `${tradePath}/${x.masterId}`); expect(visible.status, diagnostic(visible.body)).toBe(200); expect(visible.body.payload.settlementPrice).toBe(30);
    const owner = await actor('limited-owner', scopes, 'role-super-admin', ['pricing:read']); expect((await get(owner, `${tradePath}/${x.masterId}`)).status).toBe(403);
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'orders:read' } }); await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: reader.roleId, permissionId: permission.id } } }); expect((await get(reader, `${tradePath}/${x.masterId}`)).status).toBe(403);
    await db().userAccount.update({ where: { id: x.business.id }, data: { deletedAt: BigInt(Date.now()) } }); expect((await get(x.business, `${tradePath}/${x.masterId}`)).status).toBe(401);
  });
  it('ICR06 wrong pair/line, duplicate cost binding, absent internal proof and current peer source changes cannot become actual cost', async () => {
    const x = await pair('cost-range'); await effective(x); const sh = await shipment(x, 'fabric'), d = await delivery(x, sh); expect((await receipt(x, d.deliveryId)).status).toBe(200); await finishShipment(x, sh.shipmentId);
    const input = await review(x, x.fabricId); const original = input.command.internalTransfers[0];
    for (const patch of [{ mirrorId: `${x.id}-wrong-mirror` }, { fabricOrderLineId: `${x.id}-wrong-line` }, { deliveryIds: [] }]) { const rejected = await post(x.business, `${costPath}/${x.fabricId}/confirm`, { ...input.command, internalTransfers: [{ ...original, ...patch }] }); expect(rejected.status).toBe(409); }
    expect((await post(x.business, `${costPath}/${x.fabricId}/confirm`, { ...input.command, internalTransfers: [original,original] })).status).toBe(409);
    expect((await post(x.business, `${costPath}/${x.fabricId}/confirm`, { ...input.command, internalTransfers: [{ ...original, evidenceIds: [] }] })).status).toBe(409);
    const confirmed = await post(x.business, `${costPath}/${x.fabricId}/confirm`, input.command); expect(confirmed.status, diagnostic(confirmed.body)).toBe(201);
    // The immutable receipt survives, but a current hidden peer cannot be exposed
    // by confirm/retire replays carrying the original stable command.
    await db().userRole.delete({ where: { id: `${x.business.id}-canonical` } });
    await db().order.update({ where: { id: x.garmentId }, data: { ownerId: x.leader.id } });
    const reviewsBefore = await db().orderCostReview.findMany({ where: { orderId: x.fabricId } });
    expect((await post(x.business, `${costPath}/${x.fabricId}/confirm`, input.command)).status).toBe(404);
    expect((await post(x.business, `${costPath}/${x.fabricId}/requests/retire`, input.command)).status).toBe(404);
    expect((await get(x.business, `${costPath}/${x.fabricId}`)).status).toBe(404);
    await expect(createProfitSheetService(db()).generateOrderProfitSheet(x.fabricId, x.business.id, auth.verifyToken(x.business.token)!)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db().orderProfitSheet.count({ where: { orderId: x.fabricId } })).toBe(0); expect(await db().orderCostReview.findMany({ where: { orderId: x.fabricId } })).toEqual(reviewsBefore);
    await db().orderLine.update({ where: { id: x.garmentLineId }, data: { quantity: 99 } }); expect(await readCurrentOrderCostReview(db(), x.fabricId)).toMatchObject({ status: 'stale', pendingReasons: ['ORDER_COST_REVIEW_SOURCE_CHANGED'] });
  });
  it('ICR07 actual PG P2003 mandatory confirmation audit leaves BOTH rows/lines/audits unchanged', async () => {
    const x = await pair('confirm-SQL-fault'); await decide(x); const before = await nativeState(x), fault = auditSqlFault('internal_transfer_confirm');
    const rejected = await post(x.business, `${tradePath}/${x.masterId}/confirm`, {}, fault.database); expect(rejected.status, diagnostic(rejected.body)).toBe(500); expect(fault.seen).toEqual([expect.objectContaining({ code: 'P2003' })]); expect(await nativeState(x)).toEqual(before);
    expect((await post(x.business, `${tradePath}/${x.masterId}/confirm`, {})).status).toBe(200);
  });
  it('ICR08 actual PG P2003 receipt audit rolls back append and projections; current revoked writer cannot retry', async () => {
    const x = await pair('receipt-SQL-fault'); await effective(x); const d = await delivery(x, await shipment(x, 'fabric')), before = await nativeState(x), fault = auditSqlFault('internal_transfer_receipt');
    const failed = await receipt(x, d.deliveryId, 100, `${x.id}-fault-receipt`, fault.database); expect(failed.status, diagnostic(failed.body)).toBe(500); expect(fault.seen).toEqual([expect.objectContaining({ code: 'P2003' })]); expect(await nativeState(x)).toEqual(before);
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'order:internal_trade:write' } }); await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: x.business.roleId, permissionId: permission.id } } });
    const revoked = await receipt(x, d.deliveryId, 100, `${x.id}-fault-receipt`); expect(revoked.status, diagnostic(revoked.body)).toBe(403); expect(await nativeState(x)).toEqual(before);
  });
  it('ICR09 approved history unchanged; revised quantity/price needs NEW assigned decision; immutable replay survives Effective', async () => {
    const x = await pair('price-revision-approved'); await decide(x);
    const original = await db().approvalRequest.findUniqueOrThrow({ where: { id: x.approvalId } }), command = await revisionCommand(x);
    const changed = await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, { ...command, actorId: x.leader.id, reviewerId: x.business.id, priceRevision: 999 });
    expect(changed.status, diagnostic(changed.body)).toBe(201); expect(changed.body).toMatchObject({ revision: 2, previousApprovalId: x.approvalId, previousContentFingerprint: command.expectedContentFingerprint, requestId: command.requestId, replayed: false });
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: x.approvalId } })).toEqual(original);
    const nextApproval = await db().approvalRequest.findUniqueOrThrow({ where: { id: changed.body.approvalRequestId } });
    expect(nextApproval).toMatchObject({ status: 'pending', requesterId: x.business.id, reviewerId: x.leader.id, targetId: x.masterId });
    expect(nextApproval.payload.content).toMatchObject({ quantity: 80, settlementPrice: 25, transferAmount: 2000, priceRevision: 2 });
    const awaiting = await priceState(x); expect((await post(x.business, `${tradePath}/${x.masterId}/confirm`, {})).status).toBe(409); expect(await priceState(x)).toEqual(awaiting);
    await decide({ ...x, approvalId: nextApproval.id });
    const confirmed = await post(x.business, `${tradePath}/${x.masterId}/confirm`, {}); expect(confirmed.status, diagnostic(confirmed.body)).toBe(200);
    expect(confirmed.body.payload).toMatchObject({ status: 'Effective', confirmedQuantity: 80, confirmedDueDate: '2099-11-02', settlementPrice: 25, priceRevision: 2 });
    const final = await priceState(x); expect(final.pair.map((row: any) => row.transferAmount.toString())).toEqual(['2000','2000']); expect(final.lines.map((row: any) => row.internalTransferPrice.toString())).toEqual(['25','25']);
    const replay = await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command); expect(replay.status, diagnostic(replay.body)).toBe(200); expect(replay.body).toEqual({ ...changed.body, replayed: true });
    expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, { ...command, settlementPrice: 26 })).status).toBe(409);
    expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, { ...command, requestId: `${command.requestId}-new`, expectedContentFingerprint: changed.body.contentFingerprint })).status).toBe(409);
    expect(await priceState(x)).toEqual(final);
  });
  it('ICR10 actual P2003 revision audit rolls back pending cancellation/new approval/BOTH rows; retry appends supersede only', async () => {
    const x = await pair('price-revision-SQL-fault'), command = await revisionCommand(x), before = await priceState(x), fault = auditSqlFault('internal_transfer_price_revision');
    const failed = await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command, fault.database);
    expect(failed.status, diagnostic(failed.body)).toBe(500); expect(fault.seen).toEqual([expect.objectContaining({ code: 'P2003' })]); expect(await priceState(x)).toEqual(before);
    const retry = await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command); expect(retry.status, diagnostic(retry.body)).toBe(201);
    const after = await priceState(x); expect(after.approvals).toHaveLength(2);
    expect(after.approvals.find((row: any) => row.id === x.approvalId)).toMatchObject({ status: 'cancelled', reviewerId: x.leader.id });
    expect(after.approvals.find((row: any) => row.id === retry.body.approvalRequestId)).toMatchObject({ status: 'pending', requesterId: x.business.id });
    const supersede = after.approvalAudits.filter((row: any) => row.action === 'internal_transfer_price_supersede'); expect(supersede).toHaveLength(1); expect(supersede[0].detail.approvalDecisionFact).toBeUndefined();
    const final = await priceState(x); expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command)).status).toBe(200); expect(await priceState(x)).toEqual(final);
  });
  it('ICR11 ordinary owner decision is not manager approval; explicit native boss action+3 fields+authority is usable', async () => {
    const owner = await actor('actual-boss', scopes, 'role-super-admin'), ordinary = await pair('ordinary-owner');
    const normal = await post(owner, `/api/v1/approvals/${ordinary.approvalId}/decide`, { status: 'approved', decisionNote: 'Synthetic normal owner fallback, no explicit boss mode' }); expect(normal.status, diagnostic(normal.body)).toBe(200);
    const unrecognized = await priceState(ordinary); const refused = await post(ordinary.business, `${tradePath}/${ordinary.masterId}/confirm`, {}); expect(refused.status, diagnostic(refused.body)).toBe(409); expect(await priceState(ordinary)).toEqual(unrecognized);
    const explicit = await pair('explicit-boss'), reason = 'Synthetic explicit final owner bypass for the exact native price version; reason exceeds thirty characters.';
    const approved = await post(owner, `/api/v1/approvals-kernel/${explicit.approvalId}/boss-bypass`, { reason }); expect(approved.status, diagnostic(approved.body)).toBe(200);
    const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: explicit.approvalId } }); expect(approval).toMatchObject({ status: 'approved', bossFinalBypassBy: owner.id, bossFinalBypassReason: reason }); expect(approval.bossFinalBypassAt).toEqual(approval.decidedAt);
    const audits = await db().auditLog.findMany({ where: { actorId: owner.id, action: 'boss_final_bypass', targetType: 'ApprovalRequest', targetId: explicit.approvalId } }); expect(audits).toHaveLength(1); expect(audits[0].detail).toMatchObject({ bossFinalBypassReason: reason, decisionActorAuthority: { userId: owner.id, authorizationLoaded: true, roles: ['owner'] }, approvalDecisionFact: { status: 'approved', targetId: explicit.masterId, decisionActorId: owner.id, contentFingerprint: approval.payload.contentFingerprint } });
    const confirmed = await post(explicit.business, `${tradePath}/${explicit.masterId}/confirm`, {}); expect(confirmed.status, diagnostic(confirmed.body)).toBe(200); expect(confirmed.body.payload.status).toBe('Effective');
    const self = await pair('boss-self-refusal'); await db().userRole.create({ data: { id: `${self.id}-self-owner`, userId: self.business.id, roleId: 'role-super-admin' } });
    const selfBefore = await priceState(self); expect((await post(self.business, `/api/v1/approvals-kernel/${self.approvalId}/boss-bypass`, { reason })).status).toBe(403); expect(await priceState(self)).toEqual(selfBefore);
  });
  it('ICR12 new-price replay requires current explicit grant, credential ceiling and BOTH Orders; stale fingerprint is zero-write', async () => {
    const x = await pair('price-revision-auth'), command = await revisionCommand(x), before = await priceState(x);
    expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, { ...command, expectedContentFingerprint: '0'.repeat(64) })).status).toBe(409); expect(await priceState(x)).toEqual(before);
    const { exp: _expiry, iat: _issuedAt, ...token } = auth.verifyToken(x.business.token)! as ReturnType<typeof auth.verifyToken> & { exp?: number; iat?: number };
    const capped = { ...x.business, token: auth.signToken({ ...token, permissionCeiling: ['orders:read'] }) };
    expect((await post(capped, `${tradePath}/${x.masterId}/price-revisions`, command)).status).toBe(403); expect(await priceState(x)).toEqual(before);
    const created = await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command); expect(created.status, diagnostic(created.body)).toBe(201); const original = await priceState(x);
    await db().userRole.delete({ where: { id: `${x.business.id}-canonical` } }); await db().order.update({ where: { id: x.garmentId }, data: { ownerId: x.leader.id } });
    expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command)).status).toBe(404); expect(await priceState(x)).toEqual(original);
    await db().order.update({ where: { id: x.garmentId }, data: { ownerId: x.business.id } });
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'order:internal_trade:write' } }); await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: x.business.roleId, permissionId: permission.id } } });
    expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, command)).status).toBe(403); expect(await priceState(x)).toEqual(original);
  });

  it('ICR13 a warmed 60s read cache cannot authorize any native write after actual TeamDataGrant withdrawal', async () => {
    const x = await pair('share-cache-withdrawal'), customerId = `${x.id}-shared-customer`, teamId = `${x.id}-team`, grantId = `${x.id}-grant`;
    await db().relation.create({ data: { id: customerId, name: 'Synthetic shared-customer source', category: 'Customer', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: x.leader.id } });
    await db().team.create({ data: { id: teamId, name: 'Synthetic current shared team' } });
    await db().teamMember.create({ data: { id: `${teamId}-member`, teamId, userId: x.business.id } });
    await db().teamDataGrant.create({ data: { id: grantId, teamId, entityType: 'relation', entityId: customerId, permission: 'read+followup', grantedBy: x.leader.id } });
    await db().userRole.delete({ where: { id: `${x.business.id}-canonical` } });
    await db().order.updateMany({ where: { id: { in: [x.garmentId, x.fabricId] } }, data: { customerRelationId: customerId, ownerId: x.leader.id } });
    __clearTeamShareCacheForTests();
    try {
      expect((await get(x.business, `${tradePath}/${x.masterId}`)).status).toBe(200);
      expect(await createTeamShareService(db()).getActiveGrantedRelationIds(x.business.id)).toContain(customerId);
      await db().teamDataGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedBy: x.leader.id, revokeReason: 'Synthetic actual withdrawal after a read warmed its cache' } });
      // Independent control: cached read IDs still contain the old customer.
      expect(await createTeamShareService(db()).getActiveGrantedRelationIds(x.business.id)).toContain(customerId);
      const before = await priceState(x), revision = await revisionCommand(x);
      const create = { requestDepartmentId: `${x.id}-request-dept`, supplyDepartmentId: `${x.id}-supply-dept`, garmentOrderId: x.garmentId, fabricOrderId: x.fabricId, garmentOrderLineId: x.garmentLineId, fabricOrderLineId: x.fabricLineId, materialCode: x.materialCode, quantity: 100, unit: 'M', settlementPrice: 30, dueDate: '2099-11-01' };
      for (const [url, body] of [[tradePath, create], [`${tradePath}/${x.masterId}/price-revisions`, revision], [`${tradePath}/${x.masterId}/confirm`, {}], [`${tradePath}/${x.masterId}/delivery`, { shipmentId: 'no-authorization-to-query-this-shipment', quantity: 100, requestId: `${x.id}-denied-delivery`, deliveryDate: '2099-11-01' }], [`${tradePath}/${x.masterId}/receipt`, { deliveryId: 'no-authorization-to-query-this-delivery', quantity: 100, requestId: `${x.id}-denied-receipt`, receivedDate: '2099-11-01' }], [`${tradePath}/${x.masterId}/cancel`, { reason: 'Denied withdrawal probe' }]] as const) {
        expect((await post(x.business, url, body)).status, url).toBe(404);
        expect(await priceState(x)).toEqual(before);
      }
      await db().teamDataGrant.update({ where: { id: grantId }, data: { revokedAt: null, revokedBy: null, revokeReason: null } });
      expect((await post(x.business, `${tradePath}/${x.masterId}/price-revisions`, revision)).status).toBe(201);
    } finally { __clearTeamShareCacheForTests(); }
  });

  it('ICR14 requireAuth=false still requires JWT and actual active grants/cap for the native price write', async () => {
    const x = await pair('config-false-authority'), command = await revisionCommand(x), application = app(db(), false), before = await priceState(x);
    expect((await request(application).post(`${tradePath}/${x.masterId}/price-revisions`).send(command)).status).toBe(401); expect(await priceState(x)).toEqual(before);
    const limited = cappedActor(x.business, []);
    expect((await request(application).post(`${tradePath}/${x.masterId}/price-revisions`).set('Authorization', `Bearer ${limited.token}`).send(command)).status).toBe(403); expect(await priceState(x)).toEqual(before);
    await db().userAccount.update({ where: { id: x.business.id }, data: { status: 'disabled' } });
    expect((await request(application).post(`${tradePath}/${x.masterId}/price-revisions`).set('Authorization', `Bearer ${x.business.token}`).send(command)).status).toBe(401); expect(await priceState(x)).toEqual(before);
    await db().userAccount.update({ where: { id: x.business.id }, data: { status: 'active', deletedAt: BigInt(Date.now()) } });
    expect((await request(application).post(`${tradePath}/${x.masterId}/price-revisions`).set('Authorization', `Bearer ${x.business.token}`).send(command)).status).toBe(401); expect(await priceState(x)).toEqual(before);
    await db().userAccount.update({ where: { id: x.business.id }, data: { deletedAt: null } });
    await db().userRole.delete({ where: { id: `${x.business.id}-canonical` } });
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'order:internal_trade:write' } });
    await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: x.business.roleId, permissionId: permission.id } } });
    expect((await request(application).post(`${tradePath}/${x.masterId}/price-revisions`).set('Authorization', `Bearer ${x.business.token}`).send(command)).status).toBe(403); expect(await priceState(x)).toEqual(before);
    await db().rolePermission.create({ data: { id: `${x.id}-restored-write`, roleId: x.business.roleId, permissionId: permission.id } });
    expect((await request(application).post(`${tradePath}/${x.masterId}/price-revisions`).set('Authorization', `Bearer ${x.business.token}`).send(command)).status).toBe(201);
  });

  it('ICR15 actual registered Agent create forwards its real actor into native create/price routing/audit', async () => {
    const x = await pair('agent-create-real'), input = await newAgentSource(x, 'same-principal'), draft = buildInternalTradeCreateDraft({ input });
    const approvalId = await nativeToolApproval(x, 'internal_trade.create', draft);
    const result = await toolCommit(x.business, 'internal_trade.create', approvalId);
    expect(result, diagnostic(result)).toMatchObject({ hit: true, result: { ok: true, status: 'committed' } });
    if (!result.hit) throw Error('real internal trade registration was not reached');
    const created = await db().orderInternalTransfer.findUniqueOrThrow({ where: { id: result.result.transferId } });
    expect(created.orderId).toBe(input.garmentOrderId);
    const payload = decodeInternalTransferPayload(created.memo)!; expect(payload.status).toBe('PendingConfirm');
    const priceApproval = await db().approvalRequest.findUniqueOrThrow({ where: { id: payload.settlementApprovalId } });
    expect(priceApproval).toMatchObject({ status: 'pending', requesterId: x.business.id, reviewerId: x.leader.id, targetType: 'OrderInternalTransfer', targetId: created.id });
    expect(await db().auditLog.count({ where: { actorId: x.business.id, targetId: created.id, action: 'internal_transfer_create' } })).toBe(1);
    expect(await db().agentCommitReceipt.findUniqueOrThrow({ where: { idempotencyKey: `commit:internal_trade.create:${approvalId}` } })).toMatchObject({ status: 'committed' });
  });

  it('ICR16 actual registered Agent confirm consumes the real price decision and audits the true executor', async () => {
    const x = await pair('agent-confirm-real'); await decide(x);
    const draft = buildInternalTradeConfirmDraft({ transferId: x.masterId, actorId: x.business.id }), approvalId = await nativeToolApproval(x, 'internal_trade.confirm', draft);
    const result = await toolCommit(x.business, 'internal_trade.confirm', approvalId);
    expect(result, diagnostic(result)).toMatchObject({ hit: true, result: { ok: true, status: 'committed', transferId: x.masterId, transferStatus: 'Effective' } });
    const actual = decodeInternalTransferPayload((await db().orderInternalTransfer.findUniqueOrThrow({ where: { id: x.masterId } })).memo)!;
    expect(actual.confirmedBy).toBe(x.business.id);
    expect(await db().auditLog.count({ where: { actorId: x.business.id, targetId: x.masterId, action: 'internal_transfer_confirm' } })).toBe(1);
    // Prisma preserves this native Decimal(18,4); compare its exact decimal
    // representation on both sides rather than a JS-number object matcher.
    for (const lineId of [x.garmentLineId, x.fabricLineId]) {
      expect((await db().orderLine.findUniqueOrThrow({ where: { id: lineId } })).internalTransferPrice?.toString()).toBe('30');
    }
  });

  it('ICR17 hash-valid after identity cannot borrow another real privileged account in either formal Agent tool', async () => {
    for (const toolId of ['internal_trade.create', 'internal_trade.confirm'] as const) {
      const x = await pair(`agent-drift-${toolId}`), privileged = await actor(`borrowed-${toolId}`, scopes, 'role-finance');
      await db().userAccount.update({ where: { id: privileged.id }, data: { primaryDeptId: `${x.id}-request-dept` } });
      const input = await newAgentSource(x, 'drift');
      if (toolId === 'internal_trade.confirm') await decide(x);
      const draft = toolId === 'internal_trade.create' ? buildInternalTradeCreateDraft({ input: { ...input, requesterId: privileged.id } }) : buildInternalTradeConfirmDraft({ transferId: x.masterId, actorId: privileged.id });
      const approvalId = await nativeToolApproval(x, toolId, draft), orderIds = [x.garmentId, x.fabricId, input.garmentOrderId, input.fabricOrderId], before = await agentBusinessState(x, orderIds, approvalId);
      expect(await toolCommit(x.business, toolId, approvalId, { actorId: privileged.id, trustedActor: executionActor(privileged) })).toMatchObject({ hit: true, result: { ok: false, errorFeedback: { code: 'FORBIDDEN' } } });
      expect(await agentBusinessState(x, orderIds, approvalId)).toEqual(before);
      expect(await db().auditLog.count({ where: { actorId: privileged.id, action: { in: ['internal_transfer_create', 'internal_transfer_confirm'] } } })).toBe(0);
    }
  });

  it('ICR18 both formal Agent tools retain signed empty ceiling and current DB grant withdrawal, with a real authorized retry', async () => {
    for (const toolId of ['internal_trade.create', 'internal_trade.confirm'] as const) {
      const x = await pair(`agent-authority-${toolId}`), input = await newAgentSource(x, 'authority');
      if (toolId === 'internal_trade.confirm') await decide(x);
      const draft = toolId === 'internal_trade.create' ? buildInternalTradeCreateDraft({ input }) : buildInternalTradeConfirmDraft({ transferId: x.masterId, actorId: x.business.id });
      const approvalId = await nativeToolApproval(x, toolId, draft), orderIds = [x.garmentId, x.fabricId, input.garmentOrderId, input.fabricOrderId], before = await agentBusinessState(x, orderIds, approvalId);
      const limited = cappedActor(x.business, []);
      expect(await toolCommit(limited, toolId, approvalId)).toMatchObject({ hit: true, result: { ok: false, errorFeedback: { code: 'FORBIDDEN' } } }); expect(await agentBusinessState(x, orderIds, approvalId)).toEqual(before);
      await db().userRole.delete({ where: { id: `${x.business.id}-canonical` } });
      const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'order:internal_trade:write' } });
      await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: x.business.roleId, permissionId: permission.id } } });
      expect(await toolCommit(x.business, toolId, approvalId)).toMatchObject({ hit: true, result: { ok: false, errorFeedback: { code: 'FORBIDDEN' } } }); expect(await agentBusinessState(x, orderIds, approvalId)).toEqual(before);
      await db().rolePermission.create({ data: { id: `${x.id}-restore-agent-scope`, roleId: x.business.roleId, permissionId: permission.id } });
      expect(await toolCommit(x.business, toolId, approvalId)).toMatchObject({ hit: true, result: { ok: true, status: 'committed' } });
    }
  });

  it('ICR19 an independently authorized different executor does not replace the original approval draft identity', async () => {
    const x = await pair('agent-distinct-executor'), executor = await actor('actual-separate-executor', scopes, 'role-finance');
    await db().userAccount.update({ where: { id: executor.id }, data: { primaryDeptId: `${x.id}-request-dept` } });
    const input = await newAgentSource(x, 'separate-executor'), draft = buildInternalTradeCreateDraft({ input }), approvalId = await nativeToolApproval(x, 'internal_trade.create', draft);
    const result = await toolCommit(executor, 'internal_trade.create', approvalId);
    expect(result, diagnostic(result)).toMatchObject({ hit: true, result: { ok: true, status: 'committed' } });
    if (!result.hit) throw Error('real internal trade registration was not reached');
    const actual = decodeInternalTransferPayload((await db().orderInternalTransfer.findUniqueOrThrow({ where: { id: result.result.transferId } })).memo)!;
    expect(actual.history[0].actorId).toBe(executor.id);
    expect(await db().approvalRequest.findUniqueOrThrow({ where: { id: actual.settlementApprovalId } })).toMatchObject({ requesterId: executor.id, reviewerId: x.leader.id });
    const original = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(original.requesterId).toBe(x.business.id); expect(original.payload.processDraft.subOperations[0].after.requesterId).toBe(x.business.id);
    expect(await db().auditLog.count({ where: { targetId: actual.masterId, actorId: executor.id, action: 'internal_transfer_create' } })).toBe(1);
  });

  it.each(['role', 'share'] as const)('ICR20-%s real create waits on parent locks then sees committed withdrawal; no outputs and authorized retry', async kind => {
    const x = await pair(`create-lock-withdrawal-${kind}`), input = await newAgentSource(x, 'wait-lock'), orderIds = [input.garmentOrderId, input.fabricOrderId];
    await db().userRole.delete({ where: { id: `${x.business.id}-canonical` } });
    const permission = await db().permission.findUniqueOrThrow({ where: { scope: 'order:internal_trade:write' } });
    const customerId = `${x.id}-lock-customer`, teamId = `${x.id}-lock-team`, grantId = `${x.id}-lock-grant`;
    if (kind === 'share') {
      await db().relation.create({ data: { id: customerId, name: 'Synthetic lock-wait shared source', category: 'Customer', type: 'Company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: x.leader.id } });
      await db().team.create({ data: { id: teamId, name: 'Synthetic lock-wait team' } });
      await db().teamMember.create({ data: { id: `${teamId}-member`, teamId, userId: x.business.id } });
      await db().teamDataGrant.create({ data: { id: grantId, teamId, entityType: 'relation', entityId: customerId, permission: 'read+followup', grantedBy: x.leader.id } });
      await db().order.updateMany({ where: { id: { in: orderIds } }, data: { customerRelationId: customerId, ownerId: x.leader.id } });
    }
    const before = await agentBusinessState(x, orderIds, 'never-created-tool-approval'), lockReady = promiseSignal<number>(), release = promiseSignal<void>(), writerStarted = promiseSignal<number>();
    // Same verified private DB, independent physical connection. Its real row
    // locks, not a mocked callback, determine when the request can continue.
    const blocker = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    let holding: Promise<unknown> | undefined, writing: Promise<request.Response> | undefined;
    try {
      holding = blocker.$transaction(async tx => {
        const [identity] = await tx.$queryRawUnsafe<any[]>('SELECT current_database() AS name,pg_backend_pid() AS pid');
        expect(identity.name).toBe(process.env.BAMBOOK_ACCEPTANCE_DB_NAME);
        for (const orderId of [...orderIds].sort()) await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', orderId);
        lockReady.resolve(identity.pid); await release.promise;
      }, { timeout: 20000 });
      const blockerPid = await Promise.race([lockReady.promise, holding.then(() => { throw Error('Blocker completed before actual locks were established'); })]);
      writing = Promise.resolve(post(x.business, tradePath, input, witnessCreateTransaction(writerStarted)));
      const writerPid = await Promise.race([writerStarted.promise, writing.then(response => { throw Error(`Writer ended before actual transaction witness: ${response.status} ${diagnostic(response.body)}`); })]);
      const witness = await waitForRealParentLock(writerPid, blockerPid); expect(witness.blockers).toContain(blockerPid); expect(writerPid).not.toBe(blockerPid);
      if (kind === 'role') await db().rolePermission.delete({ where: { roleId_permissionId: { roleId: x.business.roleId, permissionId: permission.id } } });
      else await db().teamDataGrant.update({ where: { id: grantId }, data: { revokedAt: new Date(), revokedBy: x.leader.id, revokeReason: 'Synthetic committed withdrawal while native writer really waits' } });
      release.resolve(); await holding;
      const rejected = await writing; expect(rejected.status, diagnostic(rejected.body)).toBe(kind === 'role' ? 403 : 404);
      expect(await agentBusinessState(x, orderIds, 'never-created-tool-approval')).toEqual(before);
      if (kind === 'role') await db().rolePermission.create({ data: { id: `${x.id}-restore-after-wait`, roleId: x.business.roleId, permissionId: permission.id } });
      else await db().teamDataGrant.update({ where: { id: grantId }, data: { revokedAt: null, revokedBy: null, revokeReason: null } });
      const retried = await post(x.business, tradePath, input); expect(retried.status, diagnostic(retried.body)).toBe(201);
      expect(retried.body.payload.status).toBe('PendingConfirm');
      expect(await db().orderInternalTransfer.count({ where: { orderId: { in: orderIds }, deletedAt: null } })).toBe(2);
    } finally {
      release.resolve(); await Promise.allSettled([holding, writing].filter(Boolean) as Promise<unknown>[]); await blocker.$disconnect();
    }
  });
});
