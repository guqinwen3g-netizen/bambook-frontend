/** Explicit opt-in, private HTTP/PostgreSQL acceptance. Only account/master
 * authorization is seeded. Orders, approvals, claims, handoffs, uploaded bytes,
 * reports, issues and business recovery use their real authenticated commands. */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import supertest from 'supertest';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createQcPassedFabricArchive, recordExactDevelopmentConfirmation, requireHttpSuccess,
  type GlobalBusinessHttpFixture, type BusinessFixtureActor, type BusinessFixtureActorName } from './globalBusinessFixtures';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createOrderBusinessWorkspaceRouter } from '../src/orders/orderBusinessWorkspaceRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createAdminRouter } from '../src/admin/route';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { SYSTEM_ROLE_IDS } from '../src/_shared/rolePermissionMatrix';
import { readProductionQcReleaseCoverage } from '../src/qc/productionQcSizeCoverage';
import type { QcHandoffInput } from '../src/qc/qcAssignmentHandoffService';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, archive: Awaited<ReturnType<typeof createQcPassedFabricArchive>>;
let dropAcknowledgement: string | null = null;
const enc = encodeURIComponent, today = () => new Date().toISOString().slice(0, 10);
const ok = (response: Parameters<typeof requireHttpSuccess>[0], context: string, status = 200, requireOk = true) => requireHttpSuccess(response, context, status, requireOk);
type Inspector = 'qc' | 'qcOutsider';
type NativeOrder = { orderId: string; lineId: string };
type NativeTask = NativeOrder & { batch: { id: string; revision: number }; assignment: { id: string; updatedAt: string | number; qcUserId: string | null }; scope: { scopeFingerprint: string } };

beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  // A real command commits before the transport loses its response. No state
  // machine, source proof or report producer is mocked by this fault injection.
  const client = new Proxy({} as PrismaClient, { get(_target, property) {
    if (property === '$transaction') return async (...args: unknown[]) => {
      const transaction = prisma.$transaction as (...args: unknown[]) => Promise<unknown>, result = await transaction.apply(prisma, args);
      const value = result as { commandAck?: { requestKey?: string }; receipt?: { requestKey?: string }; requestKey?: string } | null;
      if (dropAcknowledgement && [value?.commandAck?.requestKey, value?.receipt?.requestKey, value?.requestKey].includes(dropAcknowledgement)) {
        dropAcknowledgement = null; throw new Error('PRIVATE native command committed but acknowledgement disconnected');
      }
      return result;
    };
    const value = Reflect.get(prisma, property); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `approval-qc-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrderBusinessWorkspaceRouter(options));
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options));
    app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/production-batches', createProductionBatchRouter(options));
    app.use('/api/v1/admin', createAdminRouter(options));
  } });
  await prisma.factoryProfile.create({ data: { id: `${f.factory.id}-profile`, relationId: f.factory.id,
    specialties: ['fabric'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  archive = await createQcPassedFabricArchive(f, { key: 'native-exact-source' });
  await recordExactDevelopmentConfirmation(f, archive);
  // Real QC execution capability without business dispatch/write authority.
  const professionalRoleId = `${f.prefix}-inspect-only`;
  const grants = await prisma.rolePermission.findMany({ where: { roleId: SYSTEM_ROLE_IDS.QC }, include: { permission: true } });
  expect(grants.some(row => row.permission.scope === 'qc:inspect')).toBe(true);
  await prisma.role.create({ data: { id: professionalRoleId, name: `${f.prefix} actual professional inspector` } });
  for (const grant of grants.filter(row => row.permission.scope !== 'qc:write')) {
    await prisma.rolePermission.create({ data: { id: `${professionalRoleId}-${grant.permissionId}`, roleId: professionalRoleId, permissionId: grant.permissionId } });
  }
  for (const name of ['qc', 'qcOutsider'] as const) {
    await prisma.userRole.deleteMany({ where: { userId: f.actors[name].id } });
    await prisma.userRole.create({ data: { id: `${f.actors[name].id}-professional-role`, userId: f.actors[name].id, roleId: professionalRoleId } });
  }
  await configure('fabric', [f.actors.manager.id, f.actors.actualRequester.id]);
  await configure('garment', [f.actors.manager.id]);
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

async function configure(businessLine: 'fabric' | 'garment', userIds: string[]) {
  const result = ok(await f.request('admin', 'put', `/api/v1/admin/order-approval-authorities/${businessLine}`, { userIds }), 'configure explicit domain authority');
  expect(result.businessLine).toBe(businessLine);
  expect(result.assignments.map((row: { userId: string }) => row.userId).sort()).toEqual([...userIds].sort());
}
async function source(label: string): Promise<NativeOrder> {
  const order = ok(await f.request('salesOwner', 'post', '/api/v2/orders', { poNumber: null, customer: f.customer.name, customerRelationId: f.customer.id,
    product: `Native approval/QC ${label}`, type: 'fabric', businessLine: 'fabric', quantity: '1000', unit: 'M', status: 'Pending',
    dueDate: '2099-01-01', quoteAmount: '2500', ownerId: f.actors.salesOwner.id, salesPerson: f.actors.salesOwner.name,
    sourceCaseId: archive.caseId, millRelationId: f.factory.id, millName: f.factory.name, currency: 'CNY', paymentInstrument: 'T/T', paymentTerms: 'T/T 30 days', deliveryTerms: 'FOB',
    finalContractNumber: `${f.prefix}-${label}-contract`, billToRelationId: f.customer.id, billToName: f.customer.name,
    billToAddress: 'Synthetic billing address', consigneeRelationId: f.customer.id, consigneeName: f.customer.name,
    shipToName: f.customer.name, shipToAddress1: 'Synthetic destination', shipToCountry: 'GB' }), 'create native draft with actual MOQ policy').order;
  expect(order.moqSnapshot).toMatchObject({ source: expect.stringMatching(/^(moq_config|fallback_constant)$/) });
  const line = ok(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: order.id, itemNo: label,
    description: `Exact fabric ${label}`, materialCode: `${f.prefix}-${label}`, quantity: '1000', unit: 'M', unitPrice: '2.5' }), 'create exact native line').line;
  ok(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(line.id)}/version`, { confirmedSourceType: 'Asset', confirmedSourceId: archive.assetId }), 'bind exact source with native QC and actual customer choice');
  return { orderId: order.id, lineId: line.id };
}
async function submit(order: NativeOrder) {
  return ok(await f.request('salesOwner', 'post', `/api/v2/orders/${enc(order.orderId)}/submit-main-approval`, {}), 'submit real frozen main approval', 201).item;
}
async function review(id: string, actor: BusinessFixtureActorName | BusinessFixtureActor = 'manager') {
  return ok(await f.request(actor, 'get', `/api/v1/approvals/${enc(id)}`), 'read exact current approval', 200, false).item;
}
const decision = (version: string, fields: Record<string, unknown> = {}) => ({ status: 'approved', confirmedReviewedContent: true, reviewContentVersion: version, ...fields });
function ceiling(name: BusinessFixtureActorName, permissionCeiling: string[]): BusinessFixtureActor {
  const auth = createAuthService(), claims = auth.verifyToken(f.actors[name].token) as TokenPayload & { exp?: number; iat?: number };
  const { exp: _exp, iat: _iat, ...payload } = claims;
  return { ...f.actors[name], token: auth.signToken({ ...payload, permissionCeiling }) };
}
async function production(label: string): Promise<NativeTask> {
  const order = await source(label), approval = await submit(order), viewed = await review(approval.id);
  ok(await f.request('manager', 'post', `/api/v1/approvals/${enc(approval.id)}/decide`, decision(viewed.reviewContentVersion)), 'approve exact production source', 200, false);
  const base = `/api/v1/production-batches/orders/${enc(order.orderId)}/lines/${enc(order.lineId)}`;
  const listed = ok(await f.request('salesOwner', 'get', base), 'read current line fingerprint');
  const batch = ok(await f.request('salesOwner', 'post', base, { requestKey: `${f.prefix}-${label}-branch`, expectedLineFingerprint: listed.lineFingerprint,
    factoryRelationId: f.factory.id, batchCode: `${f.prefix}-${label}`, quantity: '1000', unit: 'M' }), 'create actual factory branch', 201).batch;
  const scopes = ok(await f.request('salesOwner', 'get', `/api/v1/qc/orders/${enc(order.orderId)}/inspection-scopes`), 'read actual scope').scopes;
  const scope = scopes.find((row: { productionBatchId: string }) => row.productionBatchId === batch.id);
  expect(scope).toBeTruthy();
  const assignment = ok(await f.request('salesOwner', 'post', '/api/v1/qc/assignments', { requestKey: `${f.prefix}-${label}-dispatch`, orderId: order.orderId,
    inspectionType: 'midline', qcUserId: null, scopeType: 'production_batch', productionBatchId: batch.id, expectedBatchRevision: batch.revision,
    expectedScopeFingerprint: scope.scopeFingerprint }), 'business dispatches an explicitly unclaimed accurate task', 201).item;
  expect(assignment.qcUserId).toBeNull();
  return { ...order, batch, scope, assignment };
}
async function context(task: NativeTask, actor: Inspector) {
  return ok(await f.request(actor, 'get', `/api/v1/qc/assignments/${enc(task.assignment.id)}/inspection-context`), 'read accurate professional task');
}
async function releaseCoverage(task: NativeTask) {
  return prisma.$transaction(tx => readProductionQcReleaseCoverage(tx, { orderId: task.orderId,
    productionBatchId: task.batch.id, expectedBatchRevision: task.batch.revision }));
}
function claim(task: NativeTask, requestKey: string): QcHandoffInput {
  return { requestKey, expectedQcUserId: null, expectedUpdatedAt: String(task.assignment.updatedAt),
    expectedScopeFingerprint: task.scope.scopeFingerprint, reason: '我已到本工厂，由当前账号实际执行本次检验', toQcUserId: 'self-reported-inspector-must-be-ignored' };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sKwAAAAASUVORK5CYII=', 'base64');
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content); content += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}
async function docx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Actual isolated factory inspection notes</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function upload(task: NativeTask, actor: Inspector | 'salesOwner', requestKey: string, name: string, bytes: Buffer) {
  return supertest(f.app).post(`/api/v1/qc/assignments/${enc(task.assignment.id)}/evidence-files`).set('Authorization', `Bearer ${f.actors[actor].token}`)
    .field('requestKey', requestKey).field('expectedScopeFingerprint', task.scope.scopeFingerprint).attach('file', bytes, { filename: name });
}
const reportCommand = (task: NativeTask, requestKey: string, result: 'pass' | 'fail', attachmentIds: string[], issueIds?: string[]) => ({ requestKey,
  expectedScopeFingerprint: task.scope.scopeFingerprint, report: { result, inspectionDate: today(), lotSize: 1000, sampleSize: 10,
    totalUnits: 10, passedUnits: result === 'pass' ? 10 : 8, criticalDefects: 0, majorDefects: result === 'pass' ? 0 : 2, minorDefects: 0,
    defectSummary: result === 'fail' ? '准确工厂批次实物存在两处断纱' : '', notes: result === 'pass' ? '复验原问题对应实物，确认修复' : '现场图文记录，与实际附件原件对应',
    attachmentIds, ...(issueIds ? { resolvesProductionQcIssueIds: issueIds } : {}) } });

describe('Main approval and professional QC native account return loops', () => {
  it('uses independent explicit lists, one concurrent first decision, current ceilings and qualified self approval', async () => {
    const configured = ok(await f.request('admin', 'get', '/api/v1/admin/order-approval-authorities'), 'read independently configured authorities');
    expect(configured.assignments.filter((row: { businessLine: string }) => row.businessLine === 'garment').map((row: { userId: string }) => row.userId)).toEqual([f.actors.manager.id]);
    const order = await source('concurrent'), submitted = await submit(order), frozen = JSON.stringify(submitted.payload);
    expect(submitted.eligibleReviewerIds).toEqual(expect.arrayContaining([f.actors.manager.id, f.actors.actualRequester.id]));
    expect((await review(submitted.id, 'salesOwner')).canApprove).toBe(false);
    expect((await review(submitted.id, ceiling('manager', ['orders:read']))).canApprove).toBe(false);
    const viewed = await review(submitted.id);
    expect((await f.request(ceiling('manager', ['orders:read']), 'post', `/api/v1/approvals/${enc(submitted.id)}/decide`, decision(viewed.reviewContentVersion))).status).toBe(403);
    expect((await f.request('salesOutsider', 'get', `/api/v1/approvals/${enc(submitted.id)}`)).status).toBe(404);
    const outcomes = await Promise.all((['manager', 'actualRequester'] as const).map(actor => f.request(actor, 'post', `/api/v1/approvals/${enc(submitted.id)}/decide`, decision(viewed.reviewContentVersion))));
    expect(outcomes.map(response => response.status).sort()).toEqual([200, 409]);
    const persisted = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: submitted.id } });
    expect(persisted.status).toBe('approved'); expect([f.actors.manager.id, f.actors.actualRequester.id]).toContain(persisted.reviewerId);
    expect(JSON.stringify(persisted.payload)).toBe(frozen);
    expect(await prisma.orderStatusTransition.count({ where: { orderId: order.orderId, toStatus: 'Confirmed' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { targetId: submitted.id, action: 'approve_order_main_approval' } })).toBe(1);
    const sourceRead = ok(await f.request('salesOwner', 'get', `/api/v2/orders/${enc(order.orderId)}`), 'business reads actual formal order').order;
    expect(sourceRead.status).toBe('Confirmed');
    await configure('fabric', [f.actors.manager.id, f.actors.salesOwner.id]);
    try {
      const own = await source('self'), ownApproval = await submit(own), ownReview = await review(ownApproval.id, 'salesOwner');
      expect(ownReview.canApprove).toBe(true);
      const actual = ok(await f.request('salesOwner', 'post', `/api/v1/approvals/${enc(ownApproval.id)}/decide`, decision(ownReview.reviewContentVersion)), 'qualified actual requester approves own source', 200, false).item;
      expect(actual).toMatchObject({ requesterId: f.actors.salesOwner.id, reviewerId: f.actors.salesOwner.id, status: 'approved' });
    } finally { await configure('fabric', [f.actors.manager.id, f.actors.actualRequester.id]); }
  }, 90_000);

  it('keeps rejection facts distinct, freezes pending edits and recovers the original withdrawal before explicit resubmission', async () => {
    const order = await source('correction'), first = await submit(order), viewed = await review(first.id), frozen = JSON.stringify(first.payload);
    const path = `/api/v1/approvals/${enc(first.id)}/decide`;
    for (const fields of [{ rejectionReason: '', requestedChanges: '补合同交期' }, { rejectionReason: '交期不符', requestedChanges: '' }]) {
      expect((await f.request('manager', 'post', path, decision(viewed.reviewContentVersion, { status: 'rejected', decisionNote: '不能用合并备注代替两项事实', ...fields }))).status).toBe(400);
    }
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('pending');
    const rejected = ok(await f.request('manager', 'post', path, decision(viewed.reviewContentVersion,
      { status: 'rejected', rejectionReason: '客户合同交期与逐条约定不一致', requestedChanges: '逐条核对交期，补充合同说明后重新提交' })), 'record distinct rejection facts', 200, false).item;
    expect(rejected.rejectionReason).toBe('客户合同交期与逐条约定不一致');
    const history = ok(await f.request('salesOwner', 'get', `/api/v2/orders/${enc(order.orderId)}/main-approvals`), 'business reads actual correction requirements').items;
    expect(history.find((row: { id: string }) => row.id === first.id)).toMatchObject({ rejectionReason: rejected.rejectionReason, requestedChanges: rejected.requestedChanges });
    ok(await f.request('salesOwner', 'put', `/api/v2/orders/${enc(order.orderId)}`, { specialInstructions: '已逐条核对交期并补充合同说明' }), 'business corrects the returned draft');
    const next = await submit(order), nextView = await review(next.id);
    expect(next.id).not.toBe(first.id); expect(next.payload.round).toBe(first.payload.round + 1);
    expect((await f.request('salesOwner', 'put', `/api/v2/orders/${enc(order.orderId)}`, { specialInstructions: '待审时不可再偷偷改原件' })).status).toBe(409);
    await configure('fabric', [f.actors.actualRequester.id]);
    try {
      expect((await f.request('manager', 'get', `/api/v1/approvals/${enc(next.id)}`)).status).toBe(403);
      expect((await f.request('manager', 'post', `/api/v1/approvals/${enc(next.id)}/decide`, decision(nextView.reviewContentVersion))).status).toBe(403);
      expect((await review(next.id, 'salesOwner')).canApprove).toBe(false);
    } finally { await configure('fabric', [f.actors.manager.id, f.actors.actualRequester.id]); }
    const withdrawal = { requestKey: `${f.prefix}-withdraw-lost-ack`, reviewContentVersion: nextView.reviewContentVersion, reason: '重新核对准确原件后再提交，由业务显式发起' };
    dropAcknowledgement = withdrawal.requestKey;
    expect((await f.request('salesOwner', 'post', `/api/v1/approvals/${enc(next.id)}/withdraw`, withdrawal)).status).toBe(500);
    const recovered = ok(await f.request('salesOwner', 'post', `/api/v1/approvals/${enc(next.id)}/withdraw`, withdrawal), 'recover same committed withdrawal');
    expect(recovered).toMatchObject({ replayed: true, item: { id: next.id, status: 'cancelled' }, commandAck: { actorId: f.actors.salesOwner.id, reason: withdrawal.reason } });
    expect(await prisma.auditLog.count({ where: { targetId: next.id, action: 'withdraw_order_main_approval' } })).toBe(1);
    const cancelled = await review(next.id, 'salesOwner');
    expect(cancelled).toMatchObject({ status: 'cancelled', withdrawnBy: f.actors.salesOwner.id, withdrawalReason: withdrawal.reason }); expect(cancelled.withdrawnAt).toMatch(/^\d+$/);
    expect((await f.request('salesOwner', 'post', `/api/v1/approvals/${enc(next.id)}/withdraw`, { ...withdrawal, reason: '不同内容不能复用原请求键' })).status).toBe(409);
    expect(await prisma.approvalRequest.count({ where: { targetId: order.orderId } })).toBe(2);
    ok(await f.request('salesOwner', 'put', `/api/v2/orders/${enc(order.orderId)}`, { specialInstructions: '撤回后业务重新核对准确依据' }), 'withdrawn source is editable again');
    const resubmitted = await submit(order);
    expect(resubmitted.id).not.toBe(next.id); expect(resubmitted.payload.round).toBe(next.payload.round + 1);
    const originalReplay = ok(await f.request('salesOwner', 'post', `/api/v1/approvals/${enc(next.id)}/withdraw`, withdrawal), 'old withdrawal receipt survives a new pending instance');
    expect(originalReplay.commandAck).toEqual(recovered.commandAck);
    expect(JSON.stringify((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: first.id } })).payload)).toBe(frozen);
  }, 90_000);

  it('self-claims with current accounts, transfers actual work and returns immutable image/Word/PDF reports to the exact business source', async () => {
    const task = await production('handoff'), claimKey = `${f.prefix}-actual-claim`, command = claim(task, claimKey);
    const claimPath = `/api/v1/qc/assignments/${enc(task.assignment.id)}/claim`;
    expect((await f.request('salesOwner', 'post', claimPath, command)).status).toBe(403);
    expect((await f.request('qcOutsider', 'post', claimPath, command)).status).toBe(404);
    expect((await f.request('qc', 'post', `/api/v1/qc/assignments/${enc(task.assignment.id)}/start`, {})).status).toBe(403);
    expect((await f.request(ceiling('qc', ['qc:read']), 'post', claimPath, command)).status).toBe(403);
    for (const family of ['fabric', 'garment'] as const) await prisma.teamMember.create({ data: {
      id: `${f.teamIds[family]}-current-second-qc`, teamId: f.teamIds[family], userId: f.actors.qcOutsider.id, role: 'member' } });
    const claims = await Promise.all((['qc', 'qcOutsider'] as const).map(actor => f.request(actor, 'post', claimPath, { ...command, requestKey: `${claimKey}-${actor}` })));
    expect(claims.map(response => response.status).sort()).toEqual([200, 409]);
    const first: Inspector = claims[0].status === 200 ? 'qc' : 'qcOutsider', second: Inspector = first === 'qc' ? 'qcOutsider' : 'qc';
    const claimed = ok(claims[first === 'qc' ? 0 : 1], 'one current professional account wins the actual claim');
    expect(claimed.receipt.toQcUserId).toBe(f.actors[first].id); expect(claimed.receipt.toQcUserId).not.toBe(command.toQcUserId);
    expect((await context(task, first)).assignment).toMatchObject({ canClaim: false, canTransfer: true, qcUserId: f.actors[first].id });
    ok(await f.request(first, 'post', `/api/v1/qc/assignments/${enc(task.assignment.id)}/start`, {}), 'actual inspector starts assigned work');
    expect((await f.request(first, 'post', '/api/v1/qc/assignments', { orderId: task.orderId, inspectionType: 'final', qcUserId: f.actors[first].id })).status).toBe(403);
    const pngKey = `${f.prefix}-actual-photo`, pdfBytes = pdf(), wordBytes = await docx();
    const photo = ok(await upload(task, first, pngKey, 'factory-photo.png', png), 'upload actual photo bytes', 201).file;
    const formal = ok(await upload(task, first, `${f.prefix}-actual-report`, 'factory-report.pdf', pdfBytes), 'upload actual PDF bytes', 201).file;
    const notes = ok(await upload(task, first, `${f.prefix}-actual-word`, 'inspection-notes.docx', wordBytes), 'upload actual Word bytes', 201).file;
    expect(photo).toMatchObject({ sourceId: task.assignment.id, sourceFingerprint: task.scope.scopeFingerprint, uploadedBy: f.actors[first].id,
      sha256: createHash('sha256').update(png).digest('hex') });
    expect(ok(await upload(task, first, pngKey, 'factory-photo.png', png), 'recover original photo upload', 201).file.id).toBe(photo.id);
    expect((await upload(task, first, pngKey, 'different.png', png)).status).toBe(409);
    expect((await upload(task, 'salesOwner', `${f.prefix}-business-forgery`, 'forged.pdf', pdfBytes)).status).toBe(403);
    expect((await upload(task, first, `${f.prefix}-fake-pdf`, 'fake.pdf', Buffer.from('not a PDF, regardless of its name'))).status).toBe(400);
    const foreign = await production('foreign-evidence');
    ok(await f.request(second, 'post', `/api/v1/qc/assignments/${enc(foreign.assignment.id)}/claim`, claim(foreign, `${f.prefix}-foreign-claim`)), 'claim a different accurate source');
    const foreignFile = ok(await upload(foreign, second, `${f.prefix}-foreign-photo`, 'other-factory-photo.png', png), 'upload another source original', 201).file;
    const completePath = `/api/v1/qc/assignments/${enc(task.assignment.id)}/complete`;
    expect((await f.request(first, 'post', completePath, reportCommand(task, `${f.prefix}-foreign-report-forgery`, 'fail', [foreignFile.id]))).status).toBe(400);
    expect(await prisma.inspectionReport.count({ where: { orderId: task.orderId } })).toBe(0);
    const failedInput = reportCommand(task, `${f.prefix}-fail-report`, 'fail', [photo.id, formal.id, notes.id]);
    dropAcknowledgement = failedInput.requestKey;
    expect((await f.request(first, 'post', completePath, failedInput)).status).toBe(500);
    const failed = ok(await f.request(first, 'post', completePath, failedInput), 'recover original NOK report after lost ACK').report;
    expect(failed).toMatchObject({ orderId: task.orderId, productionBatchId: task.batch.id, inspectedBy: f.actors[first].id, result: 'fail', notes: failedInput.report.notes });
    expect(failed.evidenceFiles.map((file: { id: string }) => file.id).sort()).toEqual([photo.id, formal.id, notes.id].sort());
    const issue = await prisma.productionQcIssue.findUniqueOrThrow({ where: { failedReportId: failed.id } });
    const prior = (await context(task, first)).assignment;
    const transfer = { requestKey: `${f.prefix}-handoff-lost-ack`, expectedQcUserId: f.actors[first].id, expectedUpdatedAt: String(prior.updatedAt),
      expectedScopeFingerprint: task.scope.scopeFingerprint, toQcUserId: f.actors[second].id, reason: '由实际同域专业 QC 接续复验，原报告及缺陷保留' } satisfies QcHandoffInput;
    dropAcknowledgement = transfer.requestKey;
    const transferPath = `/api/v1/qc/assignments/${enc(task.assignment.id)}/transfer`;
    expect((await f.request(first, 'post', transferPath, transfer)).status).toBe(500);
    const transferred = ok(await f.request(first, 'post', transferPath, transfer), 'recover original successful transfer');
    expect(transferred).toMatchObject({ replayed: true, item: { reportId: failed.id, qcUserId: f.actors[second].id }, receipt: { fromQcUserId: f.actors[first].id, toQcUserId: f.actors[second].id, actorId: f.actors[first].id } });
    expect((await releaseCoverage(task)).satisfied).toBe(false);
    expect((await f.request('salesOwner', 'patch', `/api/v1/qc/assignments/${enc(task.assignment.id)}`, { qcUserId: f.actors[first].id })).status).toBe(409);
    expect(ok(await upload(task, first, pngKey, 'factory-photo.png', png), 'original upload survives transfer', 201).file.id).toBe(photo.id);
    expect((await upload(task, first, `${f.prefix}-old-inspector-new-file`, 'old-actor-new.pdf', pdfBytes)).status).toBe(403);
    expect(ok(await f.request(first, 'post', completePath, failedInput), 'original report survives transfer').report.id).toBe(failed.id);
    const passInput = reportCommand(task, `${f.prefix}-targeted-retest`, 'pass', [formal.id], [issue.id]);
    expect((await f.request(first, 'post', completePath, passInput)).status).toBe(403);
    const passed = ok(await f.request(second, 'post', completePath, passInput), 'actual recipient records targeted retest').report;
    expect(passed).toMatchObject({ inspectedBy: f.actors[second].id, result: 'pass', supersedesId: failed.id });
    const afterQc = await context(task, second);
    expect(afterQc.productionQcIssues.issues).toMatchObject([{ issueId: issue.id, status: 'waiting_business_resume' }]);
    expect(afterQc.assignment.handoffHistory).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'transfer', actorId: f.actors[first].id, toQcUserId: f.actors[second].id })]));
    expect((await releaseCoverage(task)).satisfied).toBe(false);
    const returned = await prisma.notification.findMany({ where: { userId: f.actors.salesOwner.id, type: 'production_qc_report_returned' } });
    const exact = returned.filter(row => (row.metadata as { orderId?: string } | null)?.orderId === task.orderId);
    expect(exact).toHaveLength(2);
    for (const report of [failed, passed]) expect(exact.find(row => (row.metadata as { reportId?: string } | null)?.reportId === report.id)?.metadata).toMatchObject({
      orderId: task.orderId, orderLineId: task.lineId, productionBatchId: task.batch.id, assignmentId: task.assignment.id,
      reportId: report.id, scopeFingerprint: task.scope.scopeFingerprint, actualInspectorId: report.inspectedBy,
      target: { kind: 'order', orderId: task.orderId, lineId: task.lineId } });
    const businessReports = ok(await f.request('salesOwner', 'get', `/api/v1/qc/orders/${enc(task.orderId)}/reports`), 'source business reads actual report history', 200, false).items;
    expect(businessReports.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([failed.id, passed.id]));
    const workspace = ok(await f.request('salesOwner', 'get', `/api/v1/orders/${enc(task.orderId)}/business-workspace?orderLineId=${enc(task.lineId)}&productionBatchId=${enc(task.batch.id)}&productionBatchRevision=${task.batch.revision}`), 'business returns to its exact native source').data;
    expect(workspace.overview).toMatchObject({ id: task.orderId, selectedLineId: task.lineId, selectedProductionBranch: { id: task.batch.id, revision: task.batch.revision } });
    const downloaded = await supertest(f.app).get(`/api/v1/qc/reports/${enc(failed.id)}/evidence-files/${enc(formal.id)}`).set('Authorization', `Bearer ${f.actors.salesOwner.token}`)
      .buffer(true).parse((response, done) => { const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => done(null, Buffer.concat(chunks))); });
    expect(downloaded.status).toBe(200); expect(downloaded.body).toEqual(pdfBytes);
    expect((await f.request('salesOutsider', 'get', `/api/v1/qc/reports/${enc(failed.id)}/evidence-files/${enc(formal.id)}`)).status).toBe(404);
    ok(await f.request('salesOwner', 'post', `/api/v1/qc/production-batches/${enc(task.batch.id)}/business-resume`, {
      orderLineId: task.lineId, expectedRevision: task.batch.revision, requestKey: `${f.prefix}-actual-business-resume` }), 'actual business explicitly restores the resolved branch');
    expect((await context(task, second)).productionQcIssues.issues).toMatchObject([{ issueId: issue.id, status: 'resumed' }]);
    expect((await releaseCoverage(task)).satisfied).toBe(true);
    expect(await prisma.inspectionReport.count({ where: { orderId: task.orderId } })).toBe(2);
    const currentRoles = await prisma.userRole.findMany({ where: { userId: f.actors[first].id } });
    await prisma.userRole.deleteMany({ where: { userId: f.actors[first].id } });
    try {
      expect((await f.request(first, 'post', completePath, failedInput)).status).toBe(403);
      expect((await upload(task, first, pngKey, 'factory-photo.png', png)).status).toBe(403);
    } finally { for (const role of currentRoles) await prisma.userRole.create({ data: role }); }
    const currentTeams = await prisma.teamMember.findMany({ where: { userId: f.actors[first].id } });
    await prisma.teamMember.deleteMany({ where: { userId: f.actors[first].id } });
    try {
      expect((await f.request(first, 'post', completePath, failedInput)).status).toBe(404);
      expect((await upload(task, first, pngKey, 'factory-photo.png', png)).status).toBe(404);
    } finally { for (const member of currentTeams) await prisma.teamMember.create({ data: member }); }
  }, 120_000);
});
