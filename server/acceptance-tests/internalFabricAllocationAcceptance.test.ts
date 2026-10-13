/** Opt-in HTTP + isolated PG. Every order approval, exact source QC/choice,
 * allocation and PP conclusion below is produced by native commands. */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createReturnedDevelopmentSample, completeExactDevelopmentQc, convertExactDevelopmentArchive, recordExactDevelopmentConfirmation,
  requireHttpSuccess, type GlobalBusinessHttpFixture, type BusinessFixtureActorName } from './globalBusinessFixtures';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createInternalFabricAllocationRouter } from '../src/orders/internalFabricAllocationRoute';
import { createReleaseRouter } from '../src/production/releaseRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthService } from '../src/auth/service';
import { assertInternalFabricAllocationCapacityInTx, type OrderLineQuantityPlan } from '../src/orderChanges/orderLineQuantityPlan';
import { resolveOrderSampleConsumerProof } from '../src/samples/orderSampleConsumerProof';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, fabricAssetId: string, garmentAssetId: string;
let loseAcknowledgementKey: string | null = null;
const e = encodeURIComponent, today = () => new Date().toISOString().slice(0, 10);
const ok = (response: Parameters<typeof requireHttpSuccess>[0], context: string, status = 200, requireOk = true) => requireHttpSuccess(response, context, status, requireOk);
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_facade, property) {
    if (property === '$transaction') return async (...args: unknown[]) => {
      const transaction = prisma.$transaction as (...args: unknown[]) => Promise<unknown>;
      const result = await transaction.apply(prisma, args);
      if (result && typeof result === 'object' && 'commandAck' in result) {
        const ack = (result as { commandAck?: { requestKey?: string } }).commandAck;
        if (loseAcknowledgementKey && ack?.requestKey === loseAcknowledgementKey) { loseAcknowledgementKey = null; throw new Error('PRIVATE allocation committed but transport acknowledgement disconnected'); }
      }
      return result;
    };
    const value = Reflect.get(prisma, property); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `internal-material-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1', createInternalFabricAllocationRouter(options));
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options)); app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/production-batches', createProductionBatchRouter(options)); app.use('/api/v1/releases', createReleaseRouter(options));
  } });
  await prisma.factoryProfile.create({ data: { id: `${f.factory.id}-profile`, relationId: f.factory.id, specialties: ['fabric', 'garment'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  for (const family of ['fabric', 'garment'] as const) {
    const source = await createReturnedDevelopmentSample(f, { key: `${family}-source`, type: family, internal: family === 'fabric', quantity: 2 });
    await completeExactDevelopmentQc(f, source);
    const archive = await convertExactDevelopmentArchive(f, source, { type: family });
    await recordExactDevelopmentConfirmation(f, source, { type: family === 'fabric' ? 'internal' : 'customer' });
    if (family === 'fabric') fabricAssetId = archive.assetId; else garmentAssetId = archive.assetId;
    await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: family, userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
  }
  // ActualRequester is an actual garment-only colleague, even though Sales
  // still has broad business action scopes. It cannot establish fabric supply.
  await prisma.teamMember.updateMany({ where: { userId: f.actors.actualRequester.id, teamId: f.teamIds.fabric }, data: { leftAt: new Date() } });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

type Supply = { orderId: string; lineId: string };
type Garments = { orderId: string; lineIds: string[] };
async function approve(orderId: string) {
  const submitted = ok(await f.request('salesOwner', 'post', `/api/v2/orders/${e(orderId)}/submit-main-approval`, {}), 'submit actual main approval', 201).item;
  const reviewed = ok(await f.request('manager', 'get', `/api/v1/approvals/${e(submitted.id)}`), 'review accurate full contract', 200, false).item;
  const decided = ok(await f.request('manager', 'post', `/api/v1/approvals/${e(submitted.id)}/decide`, { status: 'approved', decisionNote: '实际核对条目、数量、用途与责任', confirmedReviewedContent: true, reviewContentVersion: reviewed.reviewContentVersion }), 'approve actual main contract', 200, false).item;
  expect(decided).toMatchObject({ id: submitted.id, status: 'approved', businessSyncStatus: 'completed' });
}
const supplyHeader = () => ({ type: 'Fabric', orderPurpose: 'internal_fabric_supply', internalPurpose: '全包成衣 PP 与正式生产供料', internalDemandTeamId: f.teamIds.garment,
  internalReceiverId: f.actors.actualRequester.id, product: '准确内部面料', quantity: '1000', unit: 'M', quoteAmount: 2500, status: 'Pending', dueDate: '2099-01-01', millRelationId: f.factory.id, currency: 'CNY' });
async function supply(label: string): Promise<Supply> {
  const order = ok(await f.request('salesOwner', 'post', '/api/v1/orders', supplyHeader()), 'fabric colleague creates actual internal order without customer/PO').order;
  expect(order).toMatchObject({ orderPurpose: 'internal_fabric_supply', internalDemandTeamId: f.teamIds.garment, internalReceiverId: f.actors.actualRequester.id, customerRelationId: null, poNumber: null });
  const line = ok(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: order.id, itemNo: label, description: '内部准确供给面料行', quantity: '1000', unit: 'M', unitPrice: '2.5' }), 'save actual internal supply line').line;
  ok(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${e(line.id)}/version`, { confirmedSourceType: 'Asset', confirmedSourceId: fabricAssetId }), 'bind actual selected fabric version');
  await approve(order.id); return { orderId: order.id, lineId: line.id };
}
async function garments(label: string, count = 2): Promise<Garments> {
  const order = ok(await f.request('salesOwner', 'post', '/api/v1/orders', { type: 'Garment', product: '全包成衣', customer: f.customer.name, customerRelationId: f.customer.id,
    quantity: '1000', unit: 'PC', quoteAmount: 25000, status: 'Pending', dueDate: '2099-01-01', millRelationId: f.factory.id, currency: 'USD' }), 'create full-package draft contract').order;
  const lineIds = [];
  for (let index = 0; index < count; index++) {
    const line = ok(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: order.id, itemNo: `${label}-${index}`, description: '明确全包责任', quantity: '1000', unit: 'PC', unitPrice: '25',
      styleNo: 'ISO-FULL', sizeBreakdown: { S: 500, M: 500 }, fulfillmentMode: 'full_package', cmtIncludedItems: ['sewing'], requiredSampleFamilies: ['garment_pp', 'garment_ship'] }), 'save explicit garment fulfillment line').line;
    ok(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${e(line.id)}/version`, { confirmedSourceType: 'Asset', confirmedSourceId: garmentAssetId }), 'bind actual selected garment version');
    lineIds.push(line.id);
  }
  await approve(order.id); return { orderId: order.id, lineIds };
}
const allocationPath = (g: Garments, index: number) => `/api/v1/orders/${e(g.orderId)}/lines/${e(g.lineIds[index])}/fabric-allocations`;
const allocationContext = async (g: Garments, index: number) => ok(await f.request('salesOwner', 'get', `/api/v1/orders/${e(g.orderId)}/lines/${e(g.lineIds[index])}/fabric-allocation-context`), 'read current allocation').data;
async function ppParent(g: Garments, index: number) {
  const context = ok(await f.request('salesOwner', 'get', `/api/v1/samples/order-native/context?orderId=${e(g.orderId)}&family=garment_pp`), 'read PP line candidates').data;
  const line = context.lines.find((line: { id: string }) => line.id === g.lineIds[index]);
  const coverage = [{ orderLineId: line.id, expectedLineFingerprint: line.lineFingerprint, rangeStart: '0', quantity: '1000', unit: 'PC' }];
  return { context, line, coverage, input: { family: 'garment_pp', orderId: g.orderId, factoryRelationId: f.factory.id, coverage } };
}
async function approvedPp(g: Garments, index: number) {
  const parent = await ppParent(g, index), root = '/api/v1/samples/order-native';
  const preview = ok(await f.request('salesOwner', 'post', `${root}/preview`, parent.input), 'preview exact PP material basis').data;
  let ack = ok(await f.request('salesOwner', 'post', `${root}/register`, { ...parent.input, protocolVersion: 1, requestKey: randomUUID(), expectedParentFingerprint: preview.parentFingerprint,
    sampleFacts: { quantity: '1', unit: 'PC', cuttingDate: today() }, previousSourceId: null }), 'register actual PP').data;
  const append = async (actor: BusinessFixtureActorName, eventType: string, payload: unknown) => {
    ack = ok(await f.request(actor, 'post', `${root}/events`, { protocolVersion: 1, requestKey: randomUUID(), sourceId: ack.sourceId,
      expectedHead: { eventId: ack.eventId, sequence: ack.eventSequence }, eventType, occurredAt: today(), payload }), `actual PP ${eventType}`).data; return ack;
  };
  const requested = await append('salesOwner', 'qc_requested', { reason: '核对准确全包 PP 实样与冻结材料分配' });
  await append('qc', 'qc_reviewed', { requestedEventId: requested.eventId, result: 'pass', opinion: '当前 PP 实物与准确规格一致', inspectionDate: today(), inspectorOrg: 'Bambook QC',
    totalUnits: 1, passedUnits: 1, sampleSize: 1, criticalDefects: 0, majorDefects: 0, minorDefects: 0, defectSummary: '', reportFile: null });
  const shipped = await append('salesOwner', 'shipped', { sentDate: today(), courier: '工厂实际直接寄送', trackingNumber: `actual-${ack.sampleId}`, directShipment: true });
  await append('salesOwner', 'customer_feedback', { shippedEventId: shipped.eventId, result: 'approved', channel: 'written', confirmationDate: today(), evidenceRefs: [`isolated-acceptance:actual-customer-PP-written:${ack.sampleId}`] });
  const read = ok(await f.request('salesOwner', 'get', `${root}/source/${e(ack.sourceId)}`), 'read actual PP independent conclusions').data;
  expect(read.source.coverage[0].materialProof.allocation.metres).toBe('600');
  return ack;
}

describe('internal metre planning into actual PP and production release', () => {
  it('uses actual domain/team identities, one source serves several lines, and concurrent over-allocation cannot commit', async () => {
    expect((await f.request('actualRequester', 'post', '/api/v1/orders', supplyHeader())).status).toBe(403);
    expect((await f.request('salesOwner', 'post', '/api/v1/orders', { ...supplyHeader(), poNumber: 'invented-external-po' })).status).toBe(400);
    const s = await supply('conservative'), g = await garments('conservative', 3);
    const lacking = await ppParent(g, 0); expect(lacking.line.selectable).toBe(false);
    expect((await f.request('salesOwner', 'post', '/api/v1/samples/order-native/preview', lacking.input)).status).toBe(409);
    const results = await Promise.all([0, 1].map(index => f.request('salesOwner', 'post', allocationPath(g, index), { requestKey: randomUUID(), fabricOrderLineId: s.lineId, metres: '600', expectedRevision: 0 })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const active = await prisma.fabricLineAllocation.findMany({ where: { fabricOrderLineId: s.lineId, status: 'active' } });
    expect(active).toHaveLength(1); expect(active[0].metres.toString()).toBe('600');
    const failedIndex = results[0].status === 409 ? 0 : 1;
    ok(await f.request('salesOwner', 'post', allocationPath(g, failedIndex), { requestKey: randomUUID(), fabricOrderLineId: s.lineId, metres: '400', expectedRevision: 0 }), 'allocate exact remaining metres');
    expect((await allocationContext(g, 2)).candidates.find((row: { lineId: string }) => row.lineId === s.lineId)).toMatchObject({ allocated: '1000', remaining: '0' });
    // This exercises the shared guard against real PG allocation rows under
    // its required source locks. It is not a full quantity-change approval.
    const beforeOrder = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } });
    const shrink: OrderLineQuantityPlan = { version: 1, orderId: s.orderId, expectedUpdatedAt: beforeOrder.updatedAt.toString(),
      lines: [{ lineId: s.lineId, beforeQuantity: '1000', afterQuantity: '999.9999', unit: 'M' }] };
    await expect(prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${s.orderId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${s.lineId} FOR UPDATE`);
      await assertInternalFabricAllocationCapacityInTx(tx, shrink);
      await tx.orderLine.update({ where: { id: s.lineId }, data: { quantity: shrink.lines[0].afterQuantity } });
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: s.lineId } })).quantity.toString()).toBe('1000');
    expect((await f.request('salesOutsider', 'get', `/api/v1/orders/${e(g.orderId)}/lines/${e(g.lineIds[0])}/fabric-allocation-context`)).status).toBe(404);
    const own = (await allocationContext(g, failedIndex)).allocation;
    const user = await loadUserWithRoles(prisma, f.actors.salesOwner.id), ceilingActor = await buildLoadedAuthTokenPayload(prisma, user);
    ceilingActor.permissionCeiling = ['orders:read'];
    const ceiling = { ...f.actors.salesOwner, token: createAuthService().signToken(ceilingActor) };
    expect((await f.request(ceiling, 'post', allocationPath(g, failedIndex), { requestKey: randomUUID(), fabricOrderLineId: s.lineId, metres: '400', expectedRevision: own.revision })).status).toBe(403);
  }, 120_000);

  it('recovers a committed allocation ACK, freezes the same material proof through real PP and release, and rejects old proof after cancellation', async () => {
    const s = await supply('pp'), g = await garments('pp', 1), command = { requestKey: randomUUID(), fabricOrderLineId: s.lineId, metres: '600', expectedRevision: 0 };
    loseAcknowledgementKey = command.requestKey;
    expect((await f.request('salesOwner', 'post', allocationPath(g, 0), command)).status).toBe(500);
    const recovered = ok(await f.request('salesOwner', 'post', allocationPath(g, 0), command), 'recover original committed allocation').data;
    const repeated = ok(await f.request('salesOwner', 'post', allocationPath(g, 0), command), 'repeat same allocation command').data;
    expect(repeated).toEqual(recovered); expect(recovered.commandAck.revision).toBe(1);
    expect((await f.request('salesOwner', 'post', allocationPath(g, 0), { ...command, metres: '601' })).status).toBe(409);
    const pp = await approvedPp(g, 0);
    expect(await prisma.productionStockReceipt.count({ where: { orderId: s.orderId } })).toBe(0);
    const scope = ok(await f.request('salesOwner', 'post', `/api/v1/releases/orders/${e(g.orderId)}/lines/${e(g.lineIds[0])}/release-scopes`, { confirmedSourceType: 'Asset', confirmedSourceId: garmentAssetId, factoryRelationId: f.factory.id, quantity: '1000', unit: 'PC' }), 'create accurate whole-line PP release scope', 201).scope;
    const currentPpProof = await resolveOrderSampleConsumerProof(prisma, { kind: 'release_scope', id: scope.id }, 'garment_pp', { sourceId: pp.sourceId });
    expect(currentPpProof, `actual PP consumer qualification: ${JSON.stringify(currentPpProof.qualified ? { qualified: true } : currentPpProof)}`).toMatchObject({ mode: 'native', qualified: true });
    const request = ok(await f.request('salesOwner', 'post', `/api/v1/releases/release-scopes/${e(scope.id)}/requests`, { sampleId: pp.sampleId, expectedScopeRevision: scope.scopeRevision }), 'request real PP production release', 201).request;
    expect(request.evidenceSnapshot.materialProof.allocation.id).toBe(recovered.allocation.id);
    const action = ok(await f.request('manager', 'get', `/api/v1/releases/release-requests/${e(request.id)}/action-context`), 'leader reviews precise PP and material facts').item;
    const signed = ok(await f.request('manager', 'post', `/api/v1/releases/release-requests/${e(request.id)}/signatures`, { role: 'business', confirmedReviewedContent: true,
      expectedRequestRevision: action.request.requestRevision, expectedScopeRevision: action.scope.scopeRevision, reviewContentFingerprint: action.reviewContentFingerprint }), 'leader explicitly continues production');
    expect(signed.release.id).toBeTruthy();
    ok(await f.request('salesOwner', 'post', `/api/v1/fabric-allocations/${e(recovered.allocation.id)}/cancel`, { requestKey: randomUUID(), expectedRevision: 1 }), 'explicitly cancel plan');
    const historical = ok(await f.request('salesOwner', 'get', `/api/v1/samples/order-native/source/${e(pp.sourceId)}`), 'old PP remains readable').data;
    expect(historical.source.coverage[0].materialProof.allocation.revision).toBe(1);
    expect((await f.request('salesOwner', 'post', `/api/v1/releases/release-scopes/${e(scope.id)}/requests`, { sampleId: pp.sampleId, expectedScopeRevision: scope.scopeRevision })).status).toBe(409);
    expect(await prisma.ppSampleRelease.count({ where: { id: signed.release.id } })).toBe(1);
    expect(ok(await f.request('salesOwner', 'post', allocationPath(g, 0), command), 'original ACK remains the original success after cancellation').data).toEqual(recovered);
  }, 120_000);

  it('rechecks membership and current scopes before replaying an old command', async () => {
    const s = await supply('revocation'), g = await garments('revocation', 1), command = { requestKey: randomUUID(), fabricOrderLineId: s.lineId, metres: '600', expectedRevision: 0 };
    const result = ok(await f.request('salesOwner', 'post', allocationPath(g, 0), command), 'initial authorized plan').data;
    await prisma.teamMember.updateMany({ where: { userId: f.actors.salesOwner.id, teamId: f.teamIds.garment }, data: { leftAt: new Date() } });
    expect((await f.request('salesOwner', 'post', allocationPath(g, 0), command)).status).toBe(404);
    await prisma.teamMember.updateMany({ where: { userId: f.actors.salesOwner.id, teamId: f.teamIds.garment }, data: { leftAt: null } });
    await prisma.userRole.deleteMany({ where: { userId: f.actors.salesOwner.id } });
    expect((await f.request('salesOwner', 'post', allocationPath(g, 0), command)).status).toBe(403);
    const stored = await prisma.fabricLineAllocation.findUniqueOrThrow({ where: { id: result.allocation.id } }); expect(stored.revision).toBe(1); expect(stored.metres.toString()).toBe('600');
  }, 120_000);
});
