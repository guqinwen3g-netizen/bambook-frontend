/** Disposable PG only: actual manual contract -> approval -> actual production
 * organization -> PP inspection/choice -> release -> Final QC/completion ->
 * shipment eligibility. No approved sample, stock or production fact is seeded. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, requireHttpSuccess, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createReleaseRouter } from '../src/production/releaseRoute';
import { createShippingRouter } from '../src/shipping/route';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import type { ProductionLineChoice } from '../src/production/productionLineIdentity';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, loseAckKey: string | null = null;
const enc = encodeURIComponent, today = () => new Date().toISOString().slice(0, 10);
const ok = (response: Parameters<typeof requireHttpSuccess>[0], label: string, status = 200, requireOk = true) => requireHttpSuccess(response, label, status, requireOk);
type Branch = { orderId: string; lineId: string; batch: { id: string; revision: number }; lineFingerprint: string };
const base = (p: { orderId: string; lineId: string }) => `/api/v1/production-batches/orders/${enc(p.orderId)}/lines/${enc(p.lineId)}`;
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_facade, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      const transaction = prisma.$transaction as (...args: unknown[]) => Promise<unknown>, result = await transaction.apply(prisma, args);
      if (result && typeof result === 'object') {
        const receipt = result as { line?: { requestKey?: string }; productionLineReceipt?: { requestKey?: string } };
        if (loseAckKey && (receipt.line?.requestKey === loseAckKey || receipt.productionLineReceipt?.requestKey === loseAckKey)) {
          loseAckKey = null; throw Error('PRIVATE actual production-line commit lost its HTTP acknowledgement');
        }
      }
      return result;
    };
    const value = Reflect.get(prisma, key); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `actual-line-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options)); app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/production-batches', createProductionBatchRouter(options)); app.use('/api/v1/releases', createReleaseRouter(options));
    app.use('/api/v1/shipping', createShippingRouter({ ...options, exceptionChecker: null }));
  } });
  for (const factory of [f.factory, f.secondFactory]) await prisma.factoryProfile.create({ data: { id: `${factory.id}-profile`, relationId: factory.id,
    specialties: ['garment'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'garment', userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

async function approvedManual(label: string) {
  const order = ok(await f.request('salesOwner', 'post', '/api/v2/orders', { type: 'Garment', businessLine: 'garment', product: `真实生产线验收 ${label}`, customer: f.customer.name,
    customerRelationId: f.customer.id, consigneeRelationId: f.customer.id, consigneeName: f.customer.name,
    shipToName: f.customer.name, shipToAddress1: '独立验收的实际收货地址', shipToCountry: 'GB',
    quantity: '500', unit: 'PC', quoteAmount: 12500, status: 'Pending', dueDate: '2099-01-01', millRelationId: f.factory.id, currency: 'USD' }), 'create actual garment manual draft', 200).order;
  expect(order).toMatchObject({ type: 'Garment', businessLine: 'garment', status: 'Pending' });
  const line = ok(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: order.id, description: `真实生产线条目 ${label}`, itemNo: label, quantity: '500', unit: 'PC', unitPrice: '25',
    styleNo: 'ISO-ACTUAL-LINE', sizeBreakdown: { S: 200, M: 300 }, fulfillmentMode: 'cmt', cmtIncludedItems: [], requiredSampleFamilies: ['garment_pp', 'garment_ship'],
    partialShipmentAllowed: true, tolerancePercent: '5', toleranceSource: 'line_override',
    manualSpecification: { factoryRelationId: f.factory.id, specification: '真实人工录入本款工艺和逐码表 S200 M300', agreementBasis: '客户书面订单约定本条目规格', evidence: [`isolated-acceptance:${label}:manual-spec`] } }), 'record manual exact specification').line;
  expect(line).toMatchObject({ orderId: order.id, partialShipmentAllowed: true, toleranceSource: 'line_override' });
  expect(Number(line.tolerancePercent)).toBe(5);
  const actualLines = ok(await f.request('salesOwner', 'get', `/api/v1/order-lines?orderId=${enc(order.id)}`), 'read stored manual shipment terms').lines;
  expect(Array.isArray(actualLines)).toBe(true);
  const actualLine = actualLines.find((row: { id: string }) => row.id === line.id);
  expect(actualLine).toMatchObject({ id: line.id, orderId: order.id, partialShipmentAllowed: true, toleranceSource: 'line_override' });
  expect(Number(actualLine.tolerancePercent)).toBe(5);
  const requested = ok(await f.request('salesOwner', 'post', `/api/v2/orders/${enc(order.id)}/submit-main-approval`, {}), 'submit exact manual main approval', 201).item;
  const reviewed = ok(await f.request('manager', 'get', `/api/v1/approvals/${enc(requested.id)}`), 'read actual approval', 200, false).item;
  const approved = ok(await f.request('manager', 'post', `/api/v1/approvals/${enc(requested.id)}/decide`, { status: 'approved', decisionNote: '核对真实工厂、人工规格、逐码约定及生产组织', confirmedReviewedContent: true,
    reviewContentVersion: reviewed.reviewContentVersion }), 'leadership approves manual contract', 200, false).item;
  expect(approved).toMatchObject({ id: requested.id, status: 'approved', businessSyncStatus: 'completed' });
  const current = ok(await f.request('salesOwner', 'get', `/api/v1/orders/${enc(order.id)}`), 'read approved actual garment source').order;
  expect(current).toMatchObject({ id: order.id, type: 'Garment', businessLine: 'garment', status: 'Confirmed' });
  return { orderId: order.id as string, lineId: line.id as string };
}
async function registerLine(p: { orderId: string; lineId: string }, name: string) {
  return ok(await f.request('salesOwner', 'post', `${base(p)}/factory-production-lines`, { factoryRelationId: f.factory.id, name, location: '实际工厂车间', requestKey: randomUUID() }), 'register actual named production line', 201).line;
}
async function plan(p: { orderId: string; lineId: string }, choice: ProductionLineChoice): Promise<Branch> {
  const account = ok(await f.request('salesOwner', 'get', base(p)), 'read exact neutral branch account');
  const batch = ok(await f.request('salesOwner', 'post', base(p), { batchCode: `ACTUAL-${randomUUID().slice(0, 8)}`, quantity: '500', unit: 'PC', factoryRelationId: f.factory.id,
    sizeBreakdown: { S: 200, M: 300 }, expectedLineFingerprint: account.lineFingerprint, productionLineChoice: choice, requestKey: randomUUID() }), 'plan explicitly declared actual production organization', 201).batch;
  expect(batch.productionLineSnapshot).toMatchObject({ mode: choice.mode, factoryRelationId: f.factory.id, declaredBy: f.actors.salesOwner.id });
  return { ...p, batch, lineFingerprint: account.lineFingerprint };
}
async function nativeSample(p: Branch, family: 'garment_pp' | 'garment_ship', wholeLine = false) {
  const root = '/api/v1/samples/order-native';
  const context = ok(await f.request('salesOwner', 'get', `${root}/context?orderId=${enc(p.orderId)}&family=${family}`), 'read actual sample scope candidates').data;
  const candidate = wholeLine ? context.lines.find((row: { id: string }) => row.id === p.lineId) : context.batches.find((row: { id: string }) => row.id === p.batch.id);
  expect(candidate, 'actual selected sample parent').toMatchObject({ selectable: true });
  const range = { family, orderId: p.orderId, factoryRelationId: f.factory.id, coverage: [{ orderLineId: p.lineId, expectedLineFingerprint: candidate.lineFingerprint,
    productionBatchId: wholeLine ? null : p.batch.id, expectedBatchRevision: wholeLine ? null : p.batch.revision, rangeStart: wholeLine ? '0' : candidate.rangeStart, quantity: '500', unit: 'PC' }] };
  const preview = ok(await f.request('salesOwner', 'post', `${root}/preview`, range), 'preview exact actual sample basis').data;
  let ack = ok(await f.request('salesOwner', 'post', `${root}/register`, { ...range, protocolVersion: 1, requestKey: randomUUID(), expectedParentFingerprint: preview.parentFingerprint,
    sampleFacts: { quantity: '1', unit: 'PC', cuttingDate: today() }, previousSourceId: null }), 'register actual PP or shipment sample').data;
  const append = async (actor: 'salesOwner' | 'qc', eventType: string, payload: unknown) => {
    ack = ok(await f.request(actor, 'post', `${root}/events`, { protocolVersion: 1, requestKey: randomUUID(), sourceId: ack.sourceId, expectedHead: { eventId: ack.eventId, sequence: ack.eventSequence },
      eventType, occurredAt: today(), payload }), `record actual ${family} ${eventType}`).data; return ack;
  };
  {
    const requested = await append('salesOwner', 'qc_requested', { reason: '检验实际生产组织对应 PP 与本行规格' });
    await append('qc', 'qc_reviewed', { requestedEventId: requested.eventId, result: 'pass', opinion: '本实际生产线 PP 实物与本行规格一致', inspectionDate: today(), inspectorOrg: 'Bambook QC',
      totalUnits: 1, passedUnits: 1, sampleSize: 1, criticalDefects: 0, majorDefects: 0, minorDefects: 0, defectSummary: '', reportFile: null });
  }
  const sent = await append('salesOwner', 'shipped', { sentDate: today(), courier: '实际工厂直寄', trackingNumber: `actual-${ack.sampleId}`, directShipment: true });
  await append('salesOwner', 'customer_feedback', { shippedEventId: sent.eventId, result: 'approved', channel: 'written', confirmationDate: today(), evidenceRefs: [`isolated-acceptance:${family}:${ack.sampleId}:written-choice`] });
  const readback = ok(await f.request('salesOwner', 'get', `${root}/source/${enc(ack.sourceId)}`), 'read immutable actual sample source').data;
  if (!wholeLine) {
    const actualBatch = await prisma.productionBatch.findUniqueOrThrow({ where: { id: p.batch.id } });
    expect(readback.source.coverage[0].productionLineIdentity).toEqual(actualBatch.productionLineSnapshot);
    const stored = await prisma.orderSampleCoverage.findFirstOrThrow({ where: { sourceId: ack.sourceId } });
    expect(stored.productionLineIdentity).toEqual(actualBatch.productionLineSnapshot);
  }
  return ack;
}
async function release(p: Branch, sampleId: string, currentScope?: { id: string; scopeRevision: number }) {
  const scope = currentScope ?? ok(await f.request('salesOwner', 'post', `/api/v1/releases/orders/${enc(p.orderId)}/lines/${enc(p.lineId)}/release-scopes`, { quantity: '500', unit: 'PC', productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision }), 'create exact actual-line release scope', 201).scope;
  const request = ok(await f.request('salesOwner', 'post', `/api/v1/releases/release-scopes/${enc(scope.id)}/requests`, { sampleId, expectedScopeRevision: scope.scopeRevision }), 'request release on actual PP', 201).request;
  const action = ok(await f.request('manager', 'get', `/api/v1/releases/release-requests/${enc(request.id)}/action-context`), 'read current actual-line release evidence').item;
  ok(await f.request('manager', 'post', `/api/v1/releases/release-requests/${enc(request.id)}/signatures`, { role: 'business', confirmedReviewedContent: true, expectedRequestRevision: action.request.requestRevision,
    expectedScopeRevision: action.scope.scopeRevision, reviewContentFingerprint: action.reviewContentFingerprint }), 'leadership explicitly releases accurate actual-line branch');
  return scope;
}
async function completeAndFinalQc(p: Branch) {
  const scopes = ok(await f.request('salesOwner', 'get', `/api/v1/qc/orders/${enc(p.orderId)}/inspection-scopes`), 'read actual Final QC scope').scopes;
  const scope = scopes.find((row: { productionBatchId: string }) => row.productionBatchId === p.batch.id); expect(scope).toBeTruthy();
  const assignment = ok(await f.request('salesOwner', 'post', '/api/v1/qc/assignments', { orderId: p.orderId, inspectionType: 'final', qcUserId: f.actors.qc.id, dueDate: '2099-01-01', scopeType: 'production_batch',
    productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision, expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID() }), 'assign actual Final QC', 201).item;
  ok(await f.request('qc', 'post', `/api/v1/qc/assignments/${enc(assignment.id)}/start`, {}), 'professional claims actual Final QC');
  const completed = ok(await f.request('qc', 'post', `/api/v1/qc/assignments/${enc(assignment.id)}/complete`, { requestKey: randomUUID(), expectedScopeFingerprint: scope.scopeFingerprint,
    report: { result: 'pass', inspectionDate: today(), totalUnits: 500, passedUnits: 500, sampleSize: 10, lotSize: 500, criticalDefects: 0, majorDefects: 0, minorDefects: 0,
      productionSizeChecks: { schemaVersion: 1, actualSizes: ['S', 'M'], scopeComplete: true, basis: '实际核对工厂生产清单及 S/M 实物', checks: ['S', 'M'].map(size => ({ size, inspectedUnits: 2, result: 'pass', evidence: [`isolated-acceptance:actual-line-final:${size}.pdf`] })) } } }), 'professional records exact actual-line Final QC');
  ok(await f.request('salesOwner', 'post', `/api/v1/qc/reports/${enc(completed.report.id)}/business-decision`, { decision: 'approved', expectedRevision: completed.report.revision, expectedScopeFingerprint: completed.report.scopeFingerprint,
    expectedContentFingerprint: completed.report.contentFingerprint, requestKey: randomUUID(), reason: '业务核对当前真实生产线的 Final QC 报告' }), 'business reads actual Final QC result');
  ok(await f.request('salesOwner', 'post', `/api/v1/production-batches/${enc(p.batch.id)}/complete-production`, { expectedRevision: p.batch.revision, expectedLineFingerprint: p.lineFingerprint,
    actualQty: '500', actualQtyBySize: { S: 200, M: 300 }, requestKey: randomUUID() }), 'record actual production completion', 201);
  await nativeSample(p, 'garment_ship');
}
async function shipmentEligibility(p: Branch) {
  return ok(await f.request('salesOwner', 'post', '/api/v1/shipping/handoffs/eligibility', { shippingMethod: 'Sea', requestKey: randomUUID(), allocations: [{ orderId: p.orderId,
    orderLineId: p.lineId, productionBatchId: p.batch.id, productionBatchRevision: p.batch.revision, factoryRelationId: f.factory.id, plannedQty: '500', unit: 'PC' }] }), 'canonical exact-line shipment eligibility').data;
}

describe('explicit actual production organization and PP scope identity', () => {
  it('rechecks a changed actual line; only a new accurate PP/release can qualify current shipment', async () => {
    const manual = await approvedManual('named-line'), firstLine = await registerLine(manual, '实际车缝一线'), secondLine = await registerLine(manual, '实际车缝二线');
    const p = await plan(manual, { mode: 'named_line', productionLineId: firstLine.id });
    const pp = await nativeSample(p, 'garment_pp'), originalScope = await release(p, pp.sampleId);
    const command = { expectedRevision: p.batch.revision, expectedLineFingerprint: p.lineFingerprint, productionLineChoice: { mode: 'named_line', productionLineId: secondLine.id }, requestKey: randomUUID() };
    loseAckKey = command.requestKey;
    expect((await f.request('salesOwner', 'post', `/api/v1/production-batches/${enc(p.batch.id)}/production-line`, command)).status).toBe(500);
    const recovered = ok(await f.request('salesOwner', 'post', `/api/v1/production-batches/${enc(p.batch.id)}/production-line`, command), 'recover original actual-line change');
    expect(recovered).toMatchObject({ replayed: true, batch: { id: p.batch.id, revision: 2, productionLineId: secondLine.id }, productionLineReceipt: { requestKey: command.requestKey, actorId: f.actors.salesOwner.id, revision: 2 } });
    expect((await f.request('salesOwner', 'post', `/api/v1/production-batches/${enc(p.batch.id)}/production-line`, { ...command, productionLineChoice: { mode: 'named_line', productionLineId: firstLine.id } })).status).toBe(409);
    p.batch = recovered.batch;
    const scope = ok(await f.request('salesOwner', 'post', `/api/v1/releases/release-scopes/${enc(originalScope.id)}/rebind`,
      { quantity: '500', unit: 'PC', productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision,
        expectedScopeRevision: originalScope.scopeRevision }), 'explicitly rebind the original accurate branch scope').scope;
    expect(scope).toMatchObject({ id: originalScope.id, scopeRevision: originalScope.scopeRevision + 1, productionBatchRevision: p.batch.revision,
      state: 'no_release', currentReleaseId: null });
    expect(await prisma.releaseScope.count({ where: { orderId: p.orderId, orderLineId: p.lineId, productionBatchId: p.batch.id } })).toBe(1);
    expect((await f.request('salesOwner', 'post', `/api/v1/releases/release-scopes/${enc(scope.id)}/requests`, { sampleId: pp.sampleId, expectedScopeRevision: scope.scopeRevision })).status).toBe(409);
    expect((await shipmentEligibility(p)).eligible).toBe(false);
    const currentPp = await nativeSample(p, 'garment_pp'); await release(p, currentPp.sampleId, scope); await completeAndFinalQc(p);
    const eligible = await shipmentEligibility(p); expect(eligible, JSON.stringify(eligible)).toMatchObject({ eligible: true });
    const stored = await prisma.orderSampleCoverage.findMany({ where: { sourceId: { in: [pp.sourceId, currentPp.sourceId] } } });
    expect(stored.map(row => row.productionBatchRevision).sort()).toEqual([1, 2]);
  }, 180_000);
  it('accepts explicit factory single-line operation without inventing a named line or replacing actual PP', async () => {
    const before = await prisma.factoryProductionLine.count(), p = await plan(await approvedManual('factory-single'), { mode: 'factory_single' });
    const batch = await prisma.productionBatch.findUniqueOrThrow({ where: { id: p.batch.id } }); expect(batch.productionLineId).toBeNull();
    expect(batch.productionLineSnapshot).toMatchObject({ mode: 'factory_single', productionLineId: null, lineRevision: null });
    expect(await prisma.factoryProductionLine.count()).toBe(before);
    const pp = await nativeSample(p, 'garment_pp', true); await release(p, pp.sampleId); await completeAndFinalQc(p);
    const eligible = await shipmentEligibility(p); expect(eligible, JSON.stringify(eligible)).toMatchObject({ eligible: true });
  }, 180_000);
  it('uses fresh factory followup/L2/ceiling and recovers the exact original actual-line registration once', async () => {
    const p = await approvedManual('line-authority'), path = `${base(p)}/factory-production-lines`, command = { factoryRelationId: f.factory.id, name: `真实新线-${randomUUID().slice(0, 6)}`, location: null, requestKey: randomUUID() };
    expect((await f.request('salesOutsider', 'post', path, command)).status).toBe(404);
    expect((await f.request('actualRequester', 'post', path, command)).status).toBe(403);
    const grant = await prisma.teamDataGrant.create({ data: { teamId: f.teamIds.garment, entityType: 'relation', entityId: f.factory.id, permission: 'read', grantedBy: f.actors.manager.id } });
    ok(await f.request('actualRequester', 'get', `${path}?factoryRelationId=${enc(f.factory.id)}`), 'factory directory read share is readable');
    expect((await f.request('actualRequester', 'post', path, command)).status).toBe(403);
    await prisma.teamDataGrant.update({ where: { id: grant.id }, data: { permission: 'read+followup' } });
    const actual = await buildLoadedAuthTokenPayload(prisma, (await loadUserWithRoles(prisma, f.actors.actualRequester.id))!);
    const limited = { ...f.actors.actualRequester, token: createAuthService().signToken({ ...actual, permissionCeiling: ['orders:read'] }) };
    expect((await f.request(limited, 'post', path, command)).status).toBe(403);
    loseAckKey = command.requestKey; expect((await f.request('actualRequester', 'post', path, command)).status).toBe(500);
    const [a, b] = await Promise.all([f.request('actualRequester', 'post', path, command), f.request('actualRequester', 'post', path, command)]);
    const first = ok(a, 'recover actual-line original'), second = ok(b, 'concurrent exact actual-line original');
    expect(first.line).toEqual(second.line); expect(first.replayed).toBe(true); expect(second.replayed).toBe(true);
    expect(await prisma.factoryProductionLine.count({ where: { createdBy: f.actors.actualRequester.id, requestKey: command.requestKey } })).toBe(1);
    expect((await f.request('actualRequester', 'post', path, { ...command, name: '不同实际线名' })).status).toBe(409);
    await prisma.teamDataGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    expect((await f.request('actualRequester', 'post', path, command)).status).toBe(403);
  }, 180_000);
});
