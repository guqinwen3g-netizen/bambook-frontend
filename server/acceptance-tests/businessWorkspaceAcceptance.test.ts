/** Opt-in continuous native commands against the runner's disposable PG only. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createReturnedDevelopmentSample, completeExactDevelopmentQc, convertExactDevelopmentArchive,
  recordExactDevelopmentConfirmation, requireHttpSuccess, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';
import { createDevelopmentWorkspaceRouter } from '../src/development/developmentWorkspaceRoute';
import { createOrderBusinessWorkspaceRouter } from '../src/orders/orderBusinessWorkspaceRoute';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createReleaseRouter } from '../src/production/releaseRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { createAuthService } from '../src/auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../src/auth/tokenHelpers';
import type { BusinessWorkspaceContext, BusinessWorkspaceContinueCommand } from '../src/shared/businessWorkspaceContract';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, loseAckKey: string | null = null;
const e = encodeURIComponent, today = () => new Date().toISOString().slice(0, 10);
const ok = (response: Parameters<typeof requireHttpSuccess>[0], label: string, status = 200, requireOk = true) => requireHttpSuccess(response, label, status, requireOk);
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_facade, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      const run = prisma.$transaction as (...args: unknown[]) => Promise<unknown>, result = await run.apply(prisma, args);
      if (result && typeof result === 'object' && 'commandAck' in result) {
        const ack = (result as { commandAck?: { requestKey?: string } }).commandAck;
        if (loseAckKey && ack?.requestKey === loseAckKey) { loseAckKey = null; throw new Error('PRIVATE committed workspace continuation lost its transport ACK'); }
      }
      return result;
    };
    const value = Reflect.get(prisma, key); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `workspace-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/dev', createDevelopmentWorkspaceRouter(options));
    app.use('/api/v1/orders', createOrderBusinessWorkspaceRouter(options));
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options)); app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/production-batches', createProductionBatchRouter(options)); app.use('/api/v1/releases', createReleaseRouter(options));
  } });
  for (const factory of [f.factory, f.secondFactory]) await prisma.factoryProfile.create({ data: { id: `${factory.id}-profile`, relationId: factory.id,
    specialties: ['fabric', 'garment'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  for (const businessLine of ['fabric', 'garment'] as const) await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine, userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

function devPath(caseId: string, versionId: string) { return `/api/v1/dev/${e(caseId)}/business-workspace?sampleVersionId=${e(versionId)}`; }
async function readDevelopment(caseId: string, versionId: string): Promise<BusinessWorkspaceContext> { return ok(await f.request('salesOwner', 'get', devPath(caseId, versionId)), 'read exact development workspace').data; }
async function readOrder(orderId: string, lineId?: string, batch?: { id: string; revision: number }): Promise<BusinessWorkspaceContext> {
  const query = new URLSearchParams(); if (lineId) query.set('orderLineId', lineId); if (batch) { query.set('productionBatchId', batch.id); query.set('productionBatchRevision', String(batch.revision)); }
  return ok(await f.request('salesOwner', 'get', `/api/v1/orders/${e(orderId)}/business-workspace${query.size ? `?${query}` : ''}`), 'read exact order workspace').data;
}
const continuation = (context: BusinessWorkspaceContext, targetNodeId: string): BusinessWorkspaceContinueCommand => ({ scope: context.scope, targetNodeId, expectedContextFingerprint: context.contextFingerprint, requestKey: randomUUID() });
function continuePath(context: BusinessWorkspaceContext) { return context.scope.kind === 'development_version' || context.scope.kind === 'development_case'
  ? `/api/v1/dev/${e(context.scope.caseId)}/business-workspace/continue` : `/api/v1/orders/${e(context.scope.orderId)}/business-workspace/continue`; }
async function approve(orderId: string) {
  const request = ok(await f.request('salesOwner', 'post', `/api/v2/orders/${e(orderId)}/submit-main-approval`, {}), 'submit real manual order main approval', 201).item;
  const reviewed = ok(await f.request('manager', 'get', `/api/v1/approvals/${e(request.id)}`), 'read exact manual specification approval', 200, false).item;
  const decided = ok(await f.request('manager', 'post', `/api/v1/approvals/${e(request.id)}/decide`, { status: 'approved', decisionNote: '逐条核对人工规格、真实工厂与实际约定', confirmedReviewedContent: true, reviewContentVersion: reviewed.reviewContentVersion }), 'approve real manual main contract', 200, false).item;
  expect(decided).toMatchObject({ id: request.id, status: 'approved', businessSyncStatus: 'completed' }); return request.id;
}
async function manualOrder(label: string, withSpecification = true) {
  const order = ok(await f.request('salesOwner', 'post', '/api/v1/orders', { type: 'Garment', product: `人工录单 ${label}`, customer: f.customer.name, customerRelationId: f.customer.id,
    quantity: '500', unit: 'PC', quoteAmount: 12500, status: 'Pending', dueDate: '2099-01-01', millRelationId: f.factory.id, currency: 'USD' }), 'create actual manual draft').order;
  const specification = { factoryRelationId: f.factory.id, specification: '实际人工录入款式、工艺和 S/M 尺码表，以附件为据', agreementBasis: '实际业务按客户书面订单规格录入本行', evidence: [`isolated-acceptance:${label}:manual-order-specification`] };
  const line = ok(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: order.id, description: `人工准确条目 ${label}`, itemNo: label, quantity: '500', unit: 'PC', unitPrice: '25',
    styleNo: 'ISO-MANUAL', sizeBreakdown: { S: 200, M: 300 }, fulfillmentMode: 'cmt', cmtIncludedItems: [], requiredSampleFamilies: ['garment_pp', 'garment_ship'],
    ...(withSpecification ? { manualSpecification: specification } : {}) }), 'record real manual line and actual specification').line;
  return { order, line, specification };
}

describe('accurate progressive business workspaces and real manual fulfillment', () => {
  it('reads without writing and requires an explicit continue after each exact development gate', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'progressive' });
    const before = await prisma.auditLog.count({ where: { action: 'continue_business_workspace' } });
    const initial = await readDevelopment(source.caseId, source.versionId); await readDevelopment(source.caseId, source.versionId);
    expect(await prisma.auditLog.count({ where: { action: 'continue_business_workspace' } })).toBe(before);
    expect(initial.nodes.find(node => node.id === 'qc')).toMatchObject({ canOpen: false, canContinue: true });
    expect((await f.request('salesOwner', 'post', continuePath(initial), continuation(initial, 'archive'))).status).toBe(409);
    const qcCommand = continuation(initial, 'qc'), qcOpened = ok(await f.request('salesOwner', 'post', continuePath(initial), qcCommand), 'business explicitly opens exact QC').data;
    expect(qcOpened.commandAck).toMatchObject({ scope: initial.scope, targetNodeId: 'qc', requestKey: qcCommand.requestKey, actorId: f.actors.salesOwner.id });
    await completeExactDevelopmentQc(f, source); const passed = await readDevelopment(source.caseId, source.versionId);
    expect(passed.nodes.find(node => node.id === 'archive')).toMatchObject({ canOpen: false, canContinue: true });
    const archiveOpened = ok(await f.request('salesOwner', 'post', continuePath(passed), continuation(passed, 'archive')), 'explicit archive work area').data;
    expect(archiveOpened.context.nodes.find((node: { id: string }) => node.id === 'archive').canOpen).toBe(true);
    await convertExactDevelopmentArchive(f, source); const unselected = await readDevelopment(source.caseId, source.versionId);
    expect(unselected.nodes.find(node => node.id === 'order')).toMatchObject({ canOpen: false, canContinue: false });
    await recordExactDevelopmentConfirmation(f, source); const selected = await readDevelopment(source.caseId, source.versionId);
    expect(selected.nodes.find(node => node.id === 'order')).toMatchObject({ canOpen: false, canContinue: true });
    const minor = ok(await f.request('salesOwner', 'post', `/api/v1/development/${e(source.caseId)}/sample-versions/${e(source.versionId)}/minors`, { requestKey: randomUUID(), note: '同实物准确文字小版，独立 QC 与需求方选择' }), 'create independent minor', 201).item;
    const minorContext = await readDevelopment(source.caseId, minor.id);
    expect(minorContext.scope).toMatchObject({ sampleVersionId: minor.id });
    expect(minorContext.nodes.find(node => node.id === 'archive')).toMatchObject({ canOpen: false, canContinue: false });
    expect((await f.request('salesOwner', 'post', continuePath(minorContext), continuation(minorContext, 'order'))).status).toBe(409);
  }, 120_000);

  it('recovers a committed lost ACK, rejects changed input, and reads current failed gates on original replay', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'unknown-ack' }); await completeExactDevelopmentQc(f, source);
    const context = await readDevelopment(source.caseId, source.versionId), command = continuation(context, 'archive'); loseAckKey = command.requestKey;
    expect((await f.request('salesOwner', 'post', continuePath(context), command)).status).toBe(500);
    const recovered = ok(await f.request('salesOwner', 'post', continuePath(context), command), 'recover original committed continue').data;
    expect(recovered.replayed).toBe(true); expect(recovered.commandAck).toMatchObject({ requestKey: command.requestKey, scope: context.scope, targetNodeId: 'archive' });
    expect(await prisma.auditLog.count({ where: { id: recovered.commandAck.auditId } })).toBe(1);
    expect((await f.request('salesOwner', 'post', continuePath(context), { ...command, targetNodeId: 'order' })).status).toBe(409);
    await completeExactDevelopmentQc(f, source, { key: 'genuine-same-version-reassessment', result: 'reject' });
    const original = ok(await f.request('salesOwner', 'post', continuePath(context), command), 'original ACK plus current rejected QC').data;
    expect(original.commandAck).toEqual(recovered.commandAck); expect(original.context.nodes.find((node: { id: string }) => node.id === 'archive')).toMatchObject({ status: 'blocked', canContinue: false });
    const actual = await buildLoadedAuthTokenPayload(prisma, (await loadUserWithRoles(prisma, f.actors.salesOwner.id))!);
    const limited = { ...f.actors.salesOwner, token: createAuthService().signToken({ ...actual, permissionCeiling: ['products:read'] }) };
    const readReplay = ok(await f.request(limited, 'post', continuePath(context), command), 'old success remains a currently authorized read').data;
    expect(readReplay.replayed).toBe(true); expect(readReplay.context.nodes.every((node: { canContinue: boolean }) => !node.canContinue)).toBe(true);
    const roles = await prisma.userRole.findMany({ where: { userId: f.actors.salesOwner.id } });
    try { await prisma.userRole.deleteMany({ where: { userId: f.actors.salesOwner.id } }); expect((await f.request('salesOwner', 'post', continuePath(context), command)).status).toBe(403); }
    finally { await prisma.userRole.createMany({ data: roles }); }
    expect(await prisma.auditLog.count({ where: { id: recovered.commandAck.auditId } })).toBe(1);
  }, 120_000);

  it('freezes a real manually entered row in main approval and reaches native PP, QC, choice and branch release', async () => {
    const assetCount = await prisma.productAsset.count();
    const { order, line, specification } = await manualOrder('manual-closed-loop');
    expect(line).toMatchObject({ confirmedSourceType: 'ManualOrderLine', confirmedSourceId: line.id, specSnapshot: { manualOrderLine: { recordedBy: f.actors.salesOwner.id, ...specification } } });
    const draft = await readOrder(order.id, line.id); expect(draft.nodes.find(node => node.id === 'fulfillment')).toMatchObject({ canOpen: false, canContinue: false });
    await approve(order.id); const approved = await readOrder(order.id, line.id);
    expect(approved.overview.formalApprovalVerified).toBe(true); expect(approved.nodes.find(node => node.id === 'fulfillment')).toMatchObject({ canOpen: false, canContinue: true });
    ok(await f.request('salesOwner', 'post', continuePath(approved), continuation(approved, 'fulfillment')), 'business explicitly continues this manually entered row');
    const account = ok(await f.request('salesOwner', 'get', `/api/v1/production-batches/orders/${e(order.id)}/lines/${e(line.id)}`), 'read exact native line batch basis');
    const batch = ok(await f.request('salesOwner', 'post', `/api/v1/production-batches/orders/${e(order.id)}/lines/${e(line.id)}`, { requestKey: randomUUID(), batchCode: 'MANUAL-FACTORY-BRANCH', quantity: '500', unit: 'PC', factoryRelationId: f.factory.id,
      expectedLineFingerprint: account.lineFingerprint, sizeBreakdown: { S: 200, M: 300 }, productionLineChoice: { mode: 'factory_single' } }), 'plan actual manual source factory branch', 201).batch;
    const branch = await readOrder(order.id, line.id, batch); expect(branch.scope).toMatchObject({ kind: 'production_branch', productionBatchId: batch.id, productionBatchRevision: batch.revision });
    expect(branch.nodes.find(node => node.id === 'shipment')).toMatchObject({ canOpen: false, canContinue: false });
    const root = '/api/v1/samples/order-native', context = ok(await f.request('salesOwner', 'get', `${root}/context?orderId=${e(order.id)}&family=garment_pp`), 'read manual exact PP candidates').data;
    const candidate = context.batches.find((row: { id: string }) => row.id === batch.id); expect(candidate.selectable).toBe(true);
    const range = { family: 'garment_pp', orderId: order.id, factoryRelationId: f.factory.id, coverage: [{ orderLineId: line.id, expectedLineFingerprint: candidate.lineFingerprint, productionBatchId: batch.id,
      expectedBatchRevision: batch.revision, rangeStart: candidate.rangeStart, quantity: '500', unit: 'PC' }] };
    const preview = ok(await f.request('salesOwner', 'post', `${root}/preview`, range), 'preview real manual PP basis').data;
    let ack = ok(await f.request('salesOwner', 'post', `${root}/register`, { ...range, protocolVersion: 1, requestKey: randomUUID(), expectedParentFingerprint: preview.parentFingerprint, sampleFacts: { quantity: '1', unit: 'PC', cuttingDate: today() }, previousSourceId: null }), 'register real manual-source PP').data;
    const append = async (actor: 'salesOwner' | 'qc', eventType: string, payload: unknown) => { ack = ok(await f.request(actor, 'post', `${root}/events`, { protocolVersion: 1, requestKey: randomUUID(), sourceId: ack.sourceId,
      expectedHead: { eventId: ack.eventId, sequence: ack.eventSequence }, eventType, occurredAt: today(), payload }), `manual PP actual ${eventType}`).data; return ack; };
    const requested = await append('salesOwner', 'qc_requested', { reason: '检验本行人工规格代表实样' });
    await append('qc', 'qc_reviewed', { requestedEventId: requested.eventId, result: 'pass', opinion: '实际 PP 实物与准确人工规格一致', inspectionDate: today(), inspectorOrg: 'Bambook QC', totalUnits: 1, passedUnits: 1, sampleSize: 1,
      criticalDefects: 0, majorDefects: 0, minorDefects: 0, defectSummary: '', reportFile: null });
    const sent = await append('salesOwner', 'shipped', { sentDate: today(), courier: '真实工厂直寄', trackingNumber: `manual-pp-${ack.sampleId}`, directShipment: true });
    await append('salesOwner', 'customer_feedback', { shippedEventId: sent.eventId, result: 'approved', channel: 'written', confirmationDate: today(), evidenceRefs: [`isolated-acceptance:actual-manual-PP-selection:${ack.sampleId}`] });
    const scope = ok(await f.request('salesOwner', 'post', `/api/v1/releases/orders/${e(order.id)}/lines/${e(line.id)}/release-scopes`, { quantity: '500', unit: 'PC', productionBatchId: batch.id, expectedBatchRevision: batch.revision }), 'create exact manual branch release scope', 201).scope;
    const request = ok(await f.request('salesOwner', 'post', `/api/v1/releases/release-scopes/${e(scope.id)}/requests`, { sampleId: ack.sampleId, expectedScopeRevision: scope.scopeRevision }), 'request release on actual approved manual PP', 201).request;
    const action = ok(await f.request('manager', 'get', `/api/v1/releases/release-requests/${e(request.id)}/action-context`), 'read exact manual branch release evidence').item;
    ok(await f.request('manager', 'post', `/api/v1/releases/release-requests/${e(request.id)}/signatures`, { role: 'business', confirmedReviewedContent: true, expectedRequestRevision: action.request.requestRevision,
      expectedScopeRevision: action.scope.scopeRevision, reviewContentFingerprint: action.reviewContentFingerprint }), 'authorized leadership explicitly releases manual branch');
    const released = await readOrder(order.id, line.id, batch); expect(released.overview.selectedProductionBranch).toMatchObject({ id: batch.id, revision: batch.revision, fulfillmentBasisVerified: true });
    expect(released.nodes.find(node => node.id === 'shipment')).toMatchObject({ canOpen: false, canContinue: true });
    expect(await prisma.productAsset.count()).toBe(assetCount);
  }, 120_000);

  it('does not infer unknown manual facts, another row or a revision from whole-order state', async () => {
    const first = await manualOrder('unknown-manual', false), other = await manualOrder('other-row'); await approve(first.order.id); await approve(other.order.id);
    const unknown = await readOrder(first.order.id, first.line.id); expect(unknown.nodes.find(node => node.id === 'fulfillment')).toMatchObject({ canContinue: false });
    expect((await f.request('salesOwner', 'get', `/api/v1/orders/${e(first.order.id)}/business-workspace?orderLineId=${e(other.line.id)}`)).status).toBe(404);
    expect((await f.request('salesOwner', 'get', `/api/v1/orders/${e(first.order.id)}/business-workspace?productionBatchId=unknown&productionBatchRevision=1`)).status).toBe(400);
    expect((await f.request('salesOutsider', 'get', `/api/v1/orders/${e(first.order.id)}/business-workspace?orderLineId=${e(first.line.id)}`)).status).toBe(404);
    expect((await f.request('salesOwner', 'post', continuePath(unknown), continuation(unknown, 'fulfillment'))).status).toBe(409);
    expect(await prisma.orderLine.findUniqueOrThrow({ where: { id: first.line.id } })).toMatchObject({ confirmedSourceType: null, confirmedSourceId: null });
  }, 120_000);
});
