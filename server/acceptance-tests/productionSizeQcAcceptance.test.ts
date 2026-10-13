/** Opt-in isolated PostgreSQL + real account/HTTP acceptance. A draft contract
 * and authorization/master data are inputs; approved source, main approval,
 * branches, completion, QC, issues and recovery use native HTTP commands.
 * Never run against a workspace/default database. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createReturnedDevelopmentSample, completeExactDevelopmentQc, convertExactDevelopmentArchive,
  requireHttpSuccess, type GlobalBusinessHttpFixture, type BusinessFixtureActorName } from './globalBusinessFixtures';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { readProductionQcReleaseCoverage } from '../src/qc/productionQcSizeCoverage';
import { SYSTEM_ROLE_IDS } from '../src/_shared/rolePermissionMatrix';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture;
let archive: Awaited<ReturnType<typeof convertExactDevelopmentArchive>>;
let sourceCaseId: string;
let loseNextReportAcknowledgement = false;
const enc = encodeURIComponent;
const today = () => new Date().toISOString().slice(0, 10);
const code = (response: any) => typeof response.body.error === 'string' ? response.body.error : response.body.error?.code;
const check = (size: string, result: 'pass' | 'fail' = 'pass') => ({ size, inspectedUnits: 2, result,
  evidence: [`isolated-acceptance:actual-${size}-${result}.pdf`] });
const sizeFacts = (actualSizes: string[], scopeComplete: boolean, checks = actualSizes.map(size => check(size))) => ({
  schemaVersion: 1, actualSizes, scopeComplete, basis: 'QC 现场核对准确工厂分支的实际生产清单与实物', checks,
});
type Production = { orderId: string; lineId: string; base: string; batches: any[]; tasks: Array<{ item: any; scope: any }> };

beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  // A native transaction commits, then the transport intentionally loses its
  // acknowledgement. No business helper or persisted report is mocked.
  const client = new Proxy(prisma, { get(target, property) {
    if (property === '$transaction') return async (...args: any[]) => {
      const result = await (target.$transaction as any)(...args);
      if (loseNextReportAcknowledgement && result?.report?.productionSizeChecks && result.replayed === false) {
        loseNextReportAcknowledgement = false; throw new Error('PRIVATE committed QC acknowledgement disconnected');
      }
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `size-qc-${randomUUID().slice(0, 8)}`,
    mountAdditionalRoutes(app) {
      app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
      const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
      app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
      app.use('/api/v1/order-lines', createOrderLinesRouter(options));
      app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
      app.use('/api/v1/production-batches', createProductionBatchRouter(options));
    } });
  for (const factory of [f.factory, f.secondFactory]) await prisma.factoryProfile.create({ data: {
    id: `${factory.id}-profile`, relationId: factory.id, specialties: ['garment'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const source = await createReturnedDevelopmentSample(f, { key: 'garment-source', type: 'garment', quantity: 2 });
  sourceCaseId = source.caseId;
  await completeExactDevelopmentQc(f, source, { key: `${f.prefix}-source-qc` });
  archive = await convertExactDevelopmentArchive(f, source, { type: 'garment', key: `${f.prefix}-source-archive` });
  requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/development/${enc(source.caseId)}/sample-versions/${enc(source.versionId)}/confirmations`, {
    requestKey: `${f.prefix}-source-customer-choice`, confirmerType: 'customer', confirmerName: 'Synthetic actual customer reviewer',
    confirmerRelationId: f.customer.id, confirmerOrganization: f.customer.name, confirmedAt: String(Date.now() - 1), result: 'approved',
    basis: '客户明确选用当前准确成衣版本，业务员仅录入实际确认', evidence: [`isolated-acceptance:${source.versionId}:customer-choice`], sampleBatchId: source.batchId,
  }), 'record exact source customer choice', 201);
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'garment', userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
  // A real professional account keeps its existing domain/read capabilities,
  // but receives no business dispatch/write authority. Old login claims cannot
  // restore the removed grant because every HTTP command reloads current roles.
  const professionalRoleId = `${f.prefix}-inspect-only-role`;
  const professionalGrants = await prisma.rolePermission.findMany({ where: { roleId: SYSTEM_ROLE_IDS.QC }, include: { permission: true } });
  await prisma.role.create({ data: { id: professionalRoleId, name: `${f.prefix} professional inspector` } });
  for (const grant of professionalGrants.filter(row => row.permission.scope !== 'qc:write')) {
    await prisma.rolePermission.create({ data: { id: `${professionalRoleId}-${grant.permissionId}`, roleId: professionalRoleId, permissionId: grant.permissionId } });
  }
  await prisma.userRole.deleteMany({ where: { userId: f.actors.qc.id } });
  await prisma.userRole.create({ data: { id: `${f.actors.qc.id}-inspect-only`, userId: f.actors.qc.id, roleId: professionalRoleId } });
  expect(professionalGrants.some(row => row.permission.scope === 'qc:inspect')).toBe(true);
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

async function production(label: string): Promise<Production> {
  const intentKey = `${f.prefix}-${label}`;
  const created = requireHttpSuccess(await f.request('salesOwner', 'post', '/api/v2/orders', { poNumber: null, customer: f.customer.name, customerRelationId: f.customer.id,
    product: 'Isolated garment production', type: 'garment', businessLine: 'garment', quantity: '1000', unit: 'PC', status: 'Pending',
    dueDate: '2099-01-01', quoteAmount: '25000', ownerId: f.actors.salesOwner.id, salesPerson: f.actors.salesOwner.name,
    sourceCaseId, millRelationId: f.factory.id, millName: f.factory.name, currency: 'USD', paymentInstrument: 'T/T', paymentTerms: 'T/T 30 days',
    deliveryTerms: 'FOB', finalContractNumber: `${intentKey}-contract`, billToRelationId: f.customer.id, billToName: f.customer.name,
    billToAddress: 'Synthetic billing address', consigneeRelationId: f.customer.id, consigneeName: f.customer.name,
    shipToName: f.customer.name, shipToAddress1: 'Synthetic destination', shipToCountry: 'GB', source: 'isolated-acceptance-draft' }),
  'create native garment draft with actual MOQ policy').order;
  const orderId: string = created.id;
  expect(created.moqSnapshot).toMatchObject({ source: expect.stringMatching(/^(moq_config|fallback_constant)$/) });
  const createdLine = requireHttpSuccess(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId, itemNo: '0010', materialCode: 'ISO-GARMENT',
    description: 'Exact garment factory version', quantity: '1000', unit: 'PC', unitPrice: '25', sizeBreakdown: { S: 500, M: 500 },
    requiredSampleFamilies: ['garment_pp', 'garment_ship'], partialShipmentAllowed: true, tolerancePercent: '5', toleranceSource: 'line_override' }),
  'create native exact garment product line').line;
  const lineId: string = createdLine.id;
  expect(createdLine).toMatchObject({ orderId, quantity: '1000', sizeBreakdown: { S: 500, M: 500 } });
  requireHttpSuccess(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(lineId)}/version`, {
    confirmedSourceType: 'Asset', confirmedSourceId: archive.assetId,
  }), 'bind exact QC-passed/customer-selected garment archive');
  const mode = requireHttpSuccess(await f.request('salesOwner', 'put', `/api/v1/order-lines/${enc(lineId)}`, {
    fulfillmentMode: 'cmt', cmtIncludedItems: [],
  }), 'business explicitly records CMT with no included trims before main approval').line;
  expect(mode).toMatchObject({ id: lineId, fulfillmentMode: 'cmt', cmtIncludedItems: [] });
  const modeRead = requireHttpSuccess(await f.request('salesOwner', 'get', `/api/v1/order-lines?orderId=${enc(orderId)}`),
    'read back actual garment fulfillment responsibility').lines.find((row: { id: string }) => row.id === lineId);
  expect(modeRead).toMatchObject({ fulfillmentMode: 'cmt', cmtIncludedItems: [] });
  const submitted = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v2/orders/${enc(orderId)}/submit-main-approval`, {}), 'submit main order approval', 201).item;
  const reviewed = requireHttpSuccess(await f.request('manager', 'get', `/api/v1/approvals/${enc(submitted.id)}`), 'read actual main approval', 200, false).item;
  const mainDecision = requireHttpSuccess(await f.request('manager', 'post', `/api/v1/approvals/${enc(submitted.id)}/decide`, {
    status: 'approved', decisionNote: 'Reviewed exact garment contract/version/size plan', confirmedReviewedContent: true, reviewContentVersion: reviewed.reviewContentVersion,
  }), 'approve native main order', 200, false).item;
  expect(mainDecision).toMatchObject({ id: submitted.id, status: 'approved', businessSyncStatus: 'completed' });
  const base = `/api/v1/production-batches/orders/${enc(orderId)}/lines/${enc(lineId)}`;
  const batches = [];
  for (const [index, factory] of [f.factory, f.secondFactory].entries()) {
    const listed = requireHttpSuccess(await f.request('salesOwner', 'get', base), 'read current factory branch plan');
    batches.push(requireHttpSuccess(await f.request('salesOwner', 'post', base, { batchCode: `${label}-${index + 1}`, quantity: '500', unit: 'PC',
      factoryRelationId: factory.id, sizeBreakdown: { S: 250, M: 250 }, expectedLineFingerprint: listed.lineFingerprint, requestKey: randomUUID(),
      productionLineChoice: { mode: 'factory_single' },
    }), 'create native exact factory branch', 201).batch);
  }
  const scopes = requireHttpSuccess(await f.request('salesOwner', 'get', `/api/v1/qc/orders/${enc(orderId)}/inspection-scopes`), 'read exact QC scopes').scopes;
  expect(scopes.every((scope: any) => scope.scopeType === 'production_batch')).toBe(true);
  const tasks = [];
  for (const batch of batches) {
    const scope = scopes.find((row: any) => row.productionBatchId === batch.id);
    const item = requireHttpSuccess(await f.request('salesOwner', 'post', '/api/v1/qc/assignments', {
      orderId, inspectionType: 'final', qcUserId: f.actors.qc.id, scopeType: 'production_batch', productionBatchId: batch.id,
      expectedBatchRevision: batch.revision, expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID(),
    }), 'assign exact production QC', 201).item;
    requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/assignments/${enc(item.id)}/start`, {}), 'assigned QC starts own task'); tasks.push({ item, scope });
  }
  return { orderId, lineId, base, batches, tasks };
}
const command = (p: Production, index: number, productionSizeChecks: unknown, result: 'pass' | 'fail' = 'pass', resolvesProductionQcIssueIds?: string[]) => ({
  requestKey: randomUUID(), expectedScopeFingerprint: p.tasks[index].scope.scopeFingerprint,
  report: { result, inspectionDate: today(), totalUnits: 10, passedUnits: result === 'pass' ? 10 : 8, lotSize: 500, sampleSize: 10,
    criticalDefects: 0, majorDefects: result === 'pass' ? 0 : 1, minorDefects: 0, defectSummary: result === 'fail' ? 'M 尺码缝线开裂' : '',
    ...(productionSizeChecks == null ? {} : { productionSizeChecks }), ...(resolvesProductionQcIssueIds ? { resolvesProductionQcIssueIds } : {}) },
});
async function complete(p: Production, index: number, input: ReturnType<typeof command>, actor: BusinessFixtureActorName = 'qc') {
  return f.request(actor, 'post', `/api/v1/qc/assignments/${enc(p.tasks[index].item.id)}/complete`, input);
}
async function coverage(p: Production, index = 0) {
  return prisma.$transaction(tx => readProductionQcReleaseCoverage(tx, { orderId: p.orderId, productionBatchId: p.batches[index].id,
    expectedBatchRevision: p.batches[index].revision }));
}
async function context(p: Production, index = 0) {
  return requireHttpSuccess(await f.request('qc', 'get', `/api/v1/qc/assignments/${enc(p.tasks[index].item.id)}/inspection-context`), 'read native QC results and issues');
}
async function issueFor(reportId: string) { return prisma.productionQcIssue.findUniqueOrThrow({ where: { failedReportId: reportId } }); }
async function resume(p: Production, requestKey = randomUUID(), actor: BusinessFixtureActorName = 'salesOwner') {
  return f.request(actor, 'post', `/api/v1/qc/production-batches/${enc(p.batches[0].id)}/business-resume`, {
    orderLineId: p.lineId, expectedRevision: p.batches[0].revision, requestKey,
  });
}

describe('Production QC actual size coverage and explicit issue recovery through HTTP/PG', () => {
  it('never infers checked sizes from plans or another factory, accumulates exact reports and checks native final actual sizes', async () => {
    const p = await production('coverage');
    const dispatch = await f.request('qc', 'post', '/api/v1/qc/assignments', { orderId: p.orderId,
      inspectionType: 'midline', qcUserId: f.actors.qc.id, scopeType: 'production_batch', productionBatchId: p.batches[0].id,
      expectedBatchRevision: p.batches[0].revision, expectedScopeFingerprint: p.tasks[0].scope.scopeFingerprint, requestKey: randomUUID() });
    expect(dispatch.status).toBe(403); // inspect-only may execute, never dispatch.
    expect((await context(p)).productionSizeCoverage).toMatchObject({ satisfied: false, actualSizes: [] });
    const missing = await complete(p, 0, command(p, 0, null)); expect(missing.status).toBe(400);
    expect(await prisma.inspectionReport.count({ where: { orderId: p.orderId } })).toBe(0);
    const first = command(p, 0, sizeFacts(['S', 'M'], true, [check('S')]));
    const firstAck = requireHttpSuccess(await complete(p, 0, first), 'record actual S inspection');
    expect(firstAck.item).toMatchObject({ status: 'InProgress', completedAt: null });
    const forgedQcSign = await f.request('salesOwner', 'post', `/api/v1/qc/reports/${enc(firstAck.report.id)}/sign`, {
      role: 'qc', actorId: f.actors.qc.id, inspectedBy: f.actors.salesOwner.id,
    });
    expect(forgedQcSign.status).toBe(403);
    expect((await prisma.inspectionReport.findUniqueOrThrow({ where: { id: firstAck.report.id } })).signatures ?? {}).not.toHaveProperty('qcSignerId');
    const qcSign = requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/reports/${enc(firstAck.report.id)}/sign`, { role: 'qc' }),
      'actual inspect-only QC signs own accurate factory report').item;
    expect(qcSign.signatures.qcSignerId).toBe(f.actors.qc.id);
    expect(qcSign.signatures.qcSignedAt).toBeTruthy();
    expect((await f.request('qc', 'post', `/api/v1/qc/reports/${enc(firstAck.report.id)}/sign`, { role: 'business' })).status).toBe(403);
    const businessSign = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/qc/reports/${enc(firstAck.report.id)}/sign`, { role: 'business' }),
      'actual responsible business signs its own side').item;
    expect(businessSign.signatures).toMatchObject({ qcSignerId: f.actors.qc.id, businessSignerId: f.actors.salesOwner.id });
    expect((await coverage(p)).sizeCoverage).toMatchObject({ satisfied: false, missingSizes: ['M'] });
    requireHttpSuccess(await complete(p, 1, command(p, 1, sizeFacts(['S', 'M'], true, [check('M')]))), 'record other factory M');
    expect((await coverage(p)).sizeCoverage.missingSizes).toEqual(['M']);
    const listing = requireHttpSuccess(await f.request('salesOwner', 'get', p.base), 'read final completion fingerprint');
    requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/production-batches/${enc(p.batches[0].id)}/complete-production`, {
      expectedRevision: p.batches[0].revision, expectedLineFingerprint: listing.lineFingerprint,
      actualQty: '500', actualQtyBySize: { S: 250, M: 250 }, requestKey: randomUUID(),
    }), 'register true final actual sizes separately from QC', 201);
    expect((await coverage(p)).satisfied).toBe(false);
    const second = command(p, 0, sizeFacts(['M'], false));
    const secondAck = requireHttpSuccess(await complete(p, 0, second), 'append actual M inspection');
    expect((await coverage(p)).sizeCoverage).toMatchObject({ satisfied: true, actualSizes: ['M', 'S'], missingSizes: [] });
    expect((await coverage(p, 1)).sizeCoverage).toMatchObject({ satisfied: false, missingSizes: ['S'] });
    expect((await context(p)).productionSizeCoverage.checks.map((row: any) => row.reportId).sort()).toEqual([firstAck.report.id, secondAck.report.id].sort());
    expect((await prisma.inspectionReport.findUniqueOrThrow({ where: { id: secondAck.report.id } })).productionSizeChecks).toEqual(second.report.productionSizeChecks);
    const replay = requireHttpSuccess(await complete(p, 0, first), 'replay exact older report'); expect(replay.report.id).toBe(firstAck.report.id);
    const conflict = await complete(p, 0, { ...first, report: { ...first.report,
      productionSizeChecks: sizeFacts(['S', 'M'], true, [{ ...check('S'), evidence: ['different-evidence'] }]) } });
    expect(conflict.status).toBe(409); expect(code(conflict)).toBe('CONFLICT');
    expect(await prisma.inspectionReport.count({ where: { productionBatchId: p.batches[0].id } })).toBe(2);
  }, 90_000);

  it('pauses only the NOK branch, rejects unrelated retests and requires explicit business recovery after a named pass', async () => {
    const p = await production('retest');
    requireHttpSuccess(await complete(p, 0, command(p, 0, sizeFacts(['S', 'M'], true))), 'initial actual size quality pass');
    const failed = requireHttpSuccess(await complete(p, 0, command(p, 0, sizeFacts(['M'], false, [check('M', 'fail')]), 'fail')), 'append production M NOK').report;
    const issue = await issueFor(failed.id);
    expect((await context(p)).productionQcIssues.issues).toMatchObject([{ issueId: issue.id, status: 'open', failedSizes: ['M'] }]);
    expect((await context(p, 1)).productionQcIssues.issues).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: f.actors.salesOwner.id, type: 'production_qc_issue' } })).toBeGreaterThan(0);
    requireHttpSuccess(await complete(p, 0, command(p, 0, sizeFacts(['S', 'M'], true))), 'generic pass does not resolve a named issue');
    expect((await coverage(p)).satisfied).toBe(false); expect((await context(p)).productionQcIssues.issues[0].status).toBe('open');
    const countBefore = await prisma.inspectionReport.count({ where: { orderId: p.orderId } });
    expect((await complete(p, 0, command(p, 0, sizeFacts(['S'], false), 'pass', [issue.id]))).status).toBe(400);
    expect(await prisma.inspectionReport.count({ where: { orderId: p.orderId } })).toBe(countBefore);
    const right = command(p, 0, sizeFacts(['M'], false), 'pass', [issue.id]);
    const passed = requireHttpSuccess(await complete(p, 0, right), 'targeted M retest');
    expect(passed.report.resolvesProductionQcIssueIds).toEqual([issue.id]);
    expect((await context(p)).productionQcIssues.issues[0].status).toBe('waiting_business_resume');
    expect((await coverage(p)).satisfied).toBe(false);
    expect((await resume(p, randomUUID(), 'qc')).status).toBe(403);
    expect((await resume(p, randomUUID(), 'salesOutsider')).status).toBe(404);
    const requestKey = randomUUID(); requireHttpSuccess(await resume(p, requestKey), 'responsible business explicitly resumes');
    expect((await coverage(p)).satisfied).toBe(true);
    expect((await context(p)).productionQcIssues.issues[0].status).toBe('resumed');
    expect(requireHttpSuccess(await resume(p, requestKey), 'retry business recovery').replayed).toBe(true);
    expect(await prisma.productionQcIssueEvent.count({ where: { issueId: issue.id, kind: 'business_resumed' } })).toBe(1);
    const again = requireHttpSuccess(await complete(p, 0, command(p, 0, sizeFacts(['M'], false, [check('M', 'fail')]), 'fail')), 'new NOK is a new issue').report;
    expect((await issueFor(again.id)).id).not.toBe(issue.id);
    const oldReplay = requireHttpSuccess(await complete(p, 0, right), 'old pass receipt remains its own historical fact');
    expect(oldReplay.report.id).toBe(passed.report.id); expect((await coverage(p)).satisfied).toBe(false);
  }, 90_000);

  it('keeps zero-actual planned sizes distinct and recovers an unknown committed retest without duplicate reports or auto-resume', async () => {
    const p = await production('unknown');
    const selfAssignment = await f.request('salesOwner', 'post', '/api/v1/qc/assignments', { orderId: p.orderId,
      inspectionType: 'midline', qcUserId: f.actors.salesOwner.id, scopeType: 'production_batch', productionBatchId: p.batches[0].id,
      expectedBatchRevision: p.batches[0].revision, expectedScopeFingerprint: p.tasks[0].scope.scopeFingerprint, requestKey: randomUUID() });
    expect(selfAssignment.status).toBe(400); expect(JSON.stringify(selfAssignment.body)).toContain('专业检验权限');
    const listing = requireHttpSuccess(await f.request('salesOwner', 'get', p.base), 'read current final completion basis');
    requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/production-batches/${enc(p.batches[0].id)}/complete-production`, {
      expectedRevision: p.batches[0].revision, expectedLineFingerprint: listing.lineFingerprint, actualQty: '500',
      actualQtyBySize: { S: 500, M: 0 }, requestKey: randomUUID(),
    }), 'native completion has no actual M production', 201);
    const wrongActor = await complete(p, 0, command(p, 0, sizeFacts(['S'], true)), 'salesOwner'); expect(wrongActor.status).toBe(403);
    const wrongQc = await complete(p, 0, command(p, 0, sizeFacts(['S'], true)), 'qcOutsider'); expect(wrongQc.status).toBe(403);
    const failure = requireHttpSuccess(await complete(p, 0, command(p, 0, sizeFacts(['S'], true, [check('S', 'fail')]), 'fail')), 'actual S NOK').report;
    const issue = await issueFor(failure.id);
    const original = command(p, 0, sizeFacts(['S'], true), 'pass', [issue.id]);
    loseNextReportAcknowledgement = true;
    const unknown = await complete(p, 0, original); expect(unknown.status).toBe(500);
    expect(JSON.stringify(unknown.body)).not.toContain('PRIVATE committed');
    const committed = await prisma.inspectionReport.findUniqueOrThrow({ where: { inspectedBy_requestKey: { inspectedBy: f.actors.qc.id, requestKey: original.requestKey } } });
    expect((await coverage(p)).sizeCoverage).toMatchObject({ satisfied: true, actualSizes: ['S'], missingSizes: [] });
    expect((await coverage(p)).satisfied).toBe(false);
    const replay = requireHttpSuccess(await complete(p, 0, original), 'resolve original committed report acknowledgement');
    expect(replay.replayed).toBe(true); expect(replay.report.id).toBe(committed.id);
    expect(replay.report.resolvesProductionQcIssueIds).toEqual([issue.id]);
    expect(await prisma.inspectionReport.count({ where: { inspectedBy: f.actors.qc.id, requestKey: original.requestKey } })).toBe(1);
    expect(await prisma.productionQcIssueEvent.count({ where: { issueId: issue.id, kind: 'qc_resolved' } })).toBe(1);
    expect(await prisma.productionQcIssueEvent.count({ where: { issueId: issue.id, kind: 'business_resumed' } })).toBe(0);
    await prisma.userAccount.update({ where: { id: f.actors.qc.id }, data: { status: 'disabled' } });
    try { expect((await complete(p, 0, command(p, 0, sizeFacts(['S'], true)))).status).toBe(401); }
    finally { await prisma.userAccount.update({ where: { id: f.actors.qc.id }, data: { status: 'active' } }); }
    requireHttpSuccess(await resume(p), 'separate business recovery after original receipt');
    expect((await coverage(p)).satisfied).toBe(true);
  }, 90_000);
});
