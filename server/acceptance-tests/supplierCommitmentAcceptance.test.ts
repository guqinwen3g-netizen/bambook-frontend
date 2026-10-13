/** Opt-in isolated HTTP/PG only. Configuration and master identities are inputs;
 * every order, sample/QC/choice, supplier promise and physical conclusion below
 * is produced through native HTTP. Never run against a workspace database. */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createQcPassedFabricArchive, recordExactDevelopmentConfirmation, requireHttpSuccess,
  type GlobalBusinessHttpFixture } from './globalBusinessFixtures';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProcurementRouter } from '../src/procurement/procurementRoute';
import { createMesRouter } from '../src/mes/mesRoute';
import { createCustomsRouter } from '../src/customs/customsRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, archive: Awaited<ReturnType<typeof createQcPassedFabricArchive>>;
let dropAcknowledgement: string | null = null;
const originalSupplierAuthorities = new Map<'purchase' | 'processing', string[]>();
const enc = encodeURIComponent, today = () => new Date().toISOString().slice(0, 10);
const base = (kind: 'purchase' | 'processing', id?: string) => `/api/v1/procurement/contracts/${kind}${id ? '/' + enc(id) : ''}`;
const ok = (response: Parameters<typeof requireHttpSuccess>[0], context: string, status = 200, requireOk = true) => requireHttpSuccess(response, context, status, requireOk);
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_target, property) {
    if (property === '$transaction') return async (...args: unknown[]) => {
      const transaction = prisma.$transaction as (...args: unknown[]) => Promise<unknown>, result = await transaction.apply(prisma, args);
      const ack = result && typeof result === 'object' && 'commandAck' in result ? (result as { commandAck?: { requestKey?: string } }).commandAck : undefined;
      if (dropAcknowledgement && ack?.requestKey === dropAcknowledgement) { dropAcknowledgement = null; throw new Error('PRIVATE committed supplier command acknowledgement disconnected'); }
      return result;
    };
    const value = Reflect.get(prisma, property); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `supplier-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options));
    app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/procurement', createProcurementRouter(options)); app.use('/api/v1/mes', createMesRouter(options));
    app.use('/api/v1/customs', createCustomsRouter(options));
  } });
  // These are company configuration, not fixture-owned rows. Other native
  // files may already have set them; preserve their exact lists and restore
  // through the current versioned producer without deleting audit history.
  for (const kind of ['purchase', 'processing'] as const) {
    const before = ok(await f.request('admin', 'get', authorityPath(kind)), 'save existing supplier authority').item;
    originalSupplierAuthorities.set(kind, [...before.userIds]);
  }
  for (const factory of [f.factory, f.secondFactory]) await prisma.factoryProfile.create({ data: { id: `${factory.id}-profile`, relationId: factory.id,
    specialties: ['fabric'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  archive = await createQcPassedFabricArchive(f, { key: 'actual-fabric-source' });
  await recordExactDevelopmentConfirmation(f, archive);
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'fabric', userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
}, 120_000);
afterAll(async () => {
  try {
    if (f) for (const [kind, userIds] of originalSupplierAuthorities)
      await setAuthority(kind, userIds, 'restore-existing');
  } finally {
    try { await f?.close(); } finally { await prisma.$disconnect(); }
  }
});
async function source(label: string) {
  const order = ok(await f.request('salesOwner', 'post', '/api/v2/orders', { poNumber: null, customer: f.customer.name, customerRelationId: f.customer.id,
    product: `Native supplier source ${label}`, type: 'fabric', businessLine: 'fabric', quantity: '1000', unit: 'M', status: 'Pending',
    dueDate: '2099-01-01', quoteAmount: '2500', ownerId: f.actors.salesOwner.id, salesPerson: f.actors.salesOwner.name,
    sourceCaseId: archive.caseId, millRelationId: f.factory.id, millName: f.factory.name, currency: 'CNY', paymentInstrument: 'T/T', paymentTerms: 'T/T 30 days', deliveryTerms: 'FOB',
    finalContractNumber: `${f.prefix}-${label}-customer-contract`, billToRelationId: f.customer.id, billToName: f.customer.name,
    billToAddress: 'Synthetic billing address', consigneeRelationId: f.customer.id, consigneeName: f.customer.name,
    shipToName: f.customer.name, shipToAddress1: 'Synthetic destination', shipToCountry: 'GB' }), 'create actual MOQ-verified fabric order').order;
  expect(order.moqSnapshot).toMatchObject({ source: expect.stringMatching(/^(moq_config|fallback_constant)$/) });
  const line = ok(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: order.id, itemNo: label, description: `Exact fabric ${label}`,
    materialCode: `${f.prefix}-fabric-${label}`, quantity: '1000', unit: 'M', unitPrice: '2.5' }), 'create exact source order line').line;
  ok(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(line.id)}/version`, { confirmedSourceType: 'Asset', confirmedSourceId: archive.assetId }), 'bind actual QC and customer chosen source');
  const submit = ok(await f.request('salesOwner', 'post', `/api/v2/orders/${enc(order.id)}/submit-main-approval`, {}), 'submit actual main approval', 201).item;
  const review = ok(await f.request('manager', 'get', `/api/v1/approvals/${enc(submit.id)}`), 'read actual main approval', 200, false).item;
  const decision = ok(await f.request('manager', 'post', `/api/v1/approvals/${enc(submit.id)}/decide`, { status: 'approved', decisionNote: 'Reviewed exact source contract',
    confirmedReviewedContent: true, reviewContentVersion: review.reviewContentVersion }), 'approve actual main source', 200, false).item;
  expect(decision).toMatchObject({ id: submit.id, status: 'approved', businessSyncStatus: 'completed' });
  return { orderId: order.id as string, lineId: line.id as string };
}
const authorityPath = (kind: 'purchase' | 'processing') => `/api/v1/procurement/contracts/approval-authority/${kind}/fabric`;
async function setAuthority(kind: 'purchase' | 'processing', userIds: string[], purpose: 'configure' | 'missing-authority' | 'restore-existing') {
  const url = authorityPath(kind), before = ok(await f.request('admin', 'get', url), 'read independent supplier authority').item;
  const result = ok(await f.request('admin', 'put', url, { requestKey: `${f.prefix}-${purpose}-${kind}-${before.version}`, expectedConfigVersion: before.version,
    userIds, reason: purpose === 'restore-existing' ? 'Restore the original company supplier authority after this isolated fixture; preserve all configuration history'
      : purpose === 'missing-authority' ? 'Explicitly exercise this isolated fixture with no supplier approvers; main-order approval grants must not substitute'
        : 'Explicit supplier commitment authority; separate from order approval list' }), 'configure actual supplier approver');
  expect(result.item).toMatchObject({ version: before.version + 1, userIds: [...userIds].sort() });
  const restored = ok(await f.request('admin', 'get', url), 'read current exact supplier authority').item;
  expect(restored).toMatchObject({ version: result.item.version, userIds: [...userIds].sort() });
}
async function configure(kind: 'purchase' | 'processing') {
  await setAuthority(kind, [f.actors.manager.id], 'configure');
}
async function approve(kind: 'purchase' | 'processing', id: string, expectedRevision = 1) {
  const submitted = ok(await f.request('salesOwner', 'post', `${base(kind, id)}/submit`, { requestKey: `${f.prefix}-${id}-submit-${expectedRevision}`, expectedRevision }), 'submit supplier commitment');
  const approvalId: string = submitted.commandAck.approvalId;
  const reviewed = ok(await f.request('manager', 'get', `/api/v1/approvals/${enc(approvalId)}`), 'read frozen supplier commitment', 200, false).item;
  expect(reviewed.actionType).toBe('supplier:commitment');
  const decision = ok(await f.request('manager', 'post', `/api/v1/approvals/${enc(approvalId)}/decide`, { status: 'approved', decisionNote: 'Explicitly reviewed supplier and every exact source row',
    confirmedReviewedContent: true, reviewContentVersion: reviewed.reviewContentVersion, requestKey: `${f.prefix}-${approvalId}-decision` }), 'shared supplier approval decision', 200, false);
  expect(decision.item).toMatchObject({ id: approvalId, status: 'approved', businessSyncStatus: 'completed' });
  expect(decision.commandAck).toMatchObject({ contractId: id, approvalId, revisionId: submitted.commandAck.revisionId });
  return submitted.commandAck.revisionId as string;
}
const purchaseDraft = (lineId: string, key: string) => ({ requestKey: key, contractNumber: `${key}-PO`, supplierRelationId: f.factory.id, currency: 'CNY', paymentTerms: 'T/T 30 days',
  mainDeliveryLocation: { kind: 'supplier', relationId: f.secondFactory.id, address: 'Synthetic actual processing address' }, orderDate: today(),
  lines: [{ orderLineId: lineId, kind: 'Material', category: 'Fabric', materialCode: `${f.prefix}-raw`, description: 'Raw cloth', specification: 'Undyed', quantity: '100', unit: 'M', unitPrice: '2', requestedDeliveryDate: '2099-01-01' }] });
async function document(kind: 'purchase' | 'processing', id: string, revisionId: string, key: string) {
  const command = { requestKey: key, approvedRevisionId: revisionId };
  dropAcknowledgement = key;
  expect((await f.request('salesOwner', 'post', `${base(kind, id)}/generate-document`, command)).status).toBe(500);
  const generated = ok(await f.request('salesOwner', 'post', `${base(kind, id)}/generate-document`, command), 'recover exact formal supplier PDF');
  expect(generated.commandAck).toMatchObject({ requestKey: key, operation: 'generate_document', contractId: id, revisionId, documentId: generated.item.documentId });
  expect(generated.item).toMatchObject({ revisionId, version: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), fileSize: expect.any(Number) });
  const path = `/api/v1/customs/trade-documents/${enc(generated.item.documentId)}`;
  const selected = ok(await f.request('salesOwner', 'get', path), 'read exact supplier formal document', 200, false).item;
  expect(selected).toMatchObject({ type: kind === 'purchase' ? 'PurchaseOrder' : 'ProcessingContract', domain: 'procurement', status: 'Issued', sourceRef: `supplier:${kind}:${id}:${revisionId}`, orderId: null });
  const preview = await f.request('salesOwner', 'get', `${path}/preview.html?version=1`);
  expect(preview.status).toBe(200); expect(preview.text).toContain(selected.documentNumber); expect(preview.text).toContain(revisionId);
  const versions = await f.request('salesOwner', 'get', `${path}/versions`); expect(versions.status).toBe(200);
  const rows = Array.isArray(versions.body) ? versions.body : versions.body.items;
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ version: 1 });
  const exact = await f.request('salesOwner', 'get', `${path}/versions/1`); expect(exact.status).toBe(200);
  const bytes = await f.request('salesOwner', 'get', `${path}/download?version=1`);
  expect(bytes.status).toBe(200); expect(bytes.headers['content-type']).toContain('application/pdf'); expect(Buffer.isBuffer(bytes.body)).toBe(true);
  expect(bytes.body.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.body.length).toBe(generated.item.fileSize);
  expect(createHash('sha256').update(bytes.body).digest('hex')).toBe(generated.item.sha256);
  for (const [method, suffix, body] of [
    ['put', '', { sourceRef: 'other', type: 'CommercialInvoice' }], ['post', '/versions', { content: { html: '<p>replacement</p>' }, changeReason: 'generic replacement' }],
    ['post', '/transition', { toStatus: 'Cancelled' }], ['post', '/generate-file', {}], ['delete', '', {}],
  ] as const) expect((await f.request('superAdmin', method, path + suffix, body)).status).toBe(409);
  expect((await f.request('superAdmin', 'post', '/api/v1/customs/trade-documents', { type: selected.type, domain: 'procurement', documentNumber: `${key}-forged`, sourceRef: selected.sourceRef })).status).toBe(409);
  expect((await f.request('salesOutsider', 'get', `${path}/download?version=1`)).status).toBe(404);
  return { command, generated, path };
}
describe('Supplier commitment and actual processing chain through native HTTP/PG', () => {
  it('requires an independent authority, merges four-compatible different source rows, freezes pending and approved content, and reapproves an actual offline date change', async () => {
    const first = await source('merge-one'), second = await source('merge-two');
    const created = ok(await f.request('salesOwner', 'post', base('purchase'), purchaseDraft(first.lineId, `${f.prefix}-merge`)), 'create independent exact purchase draft', 201);
    const id: string = created.commandAck.contractId;
    await setAuthority('purchase', [], 'missing-authority');
    const missing = await f.request('salesOwner', 'post', `${base('purchase', id)}/submit`, { requestKey: `${f.prefix}-no-inherited-authority`, expectedRevision: 1 });
    expect(missing.status).toBe(409); expect(missing.body.code).toBe('APPROVAL_AUTHORITY_MISSING');
    await configure('purchase'); await configure('processing');
    const incompatible = await f.request('salesOwner', 'post', `${base('purchase', id)}/merge-demands`, { ...purchaseDraft(second.lineId, `${f.prefix}-wrong-terms`), expectedRevision: 1, paymentTerms: 'T/T 90 days' });
    expect(incompatible.status).toBe(409); expect(incompatible.body.code).toBe('INCOMPATIBLE_CONTRACT');
    const merged = ok(await f.request('salesOwner', 'post', `${base('purchase', id)}/merge-demands`, { ...purchaseDraft(second.lineId, `${f.prefix}-real-merge`), expectedRevision: 1,
      lines: [{ ...purchaseDraft(second.lineId, 'unused').lines[0], description: 'Other source cloth', specification: 'Other actual spec', quantity: '12.125', unitPrice: '2.5', requestedDeliveryDate: '2099-02-01' }] }), 'merge independent source rows');
    expect(merged.item.draft.lines).toHaveLength(2); expect(merged.item.draft.totalAmount).toBe('230.3125');
    const submitted = ok(await f.request('salesOwner', 'post', `${base('purchase', id)}/submit`, { requestKey: `${f.prefix}-merged-submit`, expectedRevision: 2 }), 'submit merged exact contract');
    const deniedEdit = await f.request('salesOwner', 'put', `${base('purchase', id)}/draft`, { ...merged.item.draft, requestKey: `${f.prefix}-pending-edit`, expectedRevision: 2 });
    expect(deniedEdit.status).toBe(409); expect(deniedEdit.body.code).toBe('CONTRACT_APPROVAL_PENDING');
    const approval = ok(await f.request('manager', 'get', `/api/v1/approvals/${enc(submitted.commandAck.approvalId)}`), 'read exact pending supplier snapshot', 200, false).item;
    ok(await f.request('manager', 'post', `/api/v1/approvals/${enc(approval.id)}/decide`, { status: 'approved', confirmedReviewedContent: true, reviewContentVersion: approval.reviewContentVersion }), 'approve merged supplier version', 200, false);
    const revisionId = submitted.commandAck.revisionId as string;
    const originalDocument = await document('purchase', id, revisionId, `${f.prefix}-purchase-document`);
    const sent = { requestKey: `${f.prefix}-actual-offline-send`, approvedRevisionId: revisionId, sentAt: today(), evidence: ['isolated written offline send'] };
    ok(await f.request('salesOwner', 'post', `${base('purchase', id)}/record-offline-send`, sent), 'record actual offline send');
    const feedback = ok(await f.request('salesOwner', 'post', `${base('purchase', id)}/supplier-feedback`, { requestKey: `${f.prefix}-supplier-new-date`, approvedRevisionId: revisionId,
      feedbackAt: today(), lines: [{ lineId: merged.item.draft.lines[0].id, supplierCommittedDeliveryDate: '2099-01-05' }], evidence: ['isolated supplier offline feedback'] }), 'record actual supplier changed date');
    expect(feedback.item).toMatchObject({ requiresAmendment: true, proposedRevisionId: expect.any(String), recordedBy: f.actors.salesOwner.id });
    const still = ok(await f.request('salesOwner', 'get', base('purchase', id)), 'read prior approved basis with unapproved change').item;
    expect(still.approvedRevision.id).toBe(revisionId); expect(still.approvedRevision.snapshot.lines[0].requestedDeliveryDate).toBe('2099-01-01');
    expect((await f.request('salesOwner', 'post', `${base('purchase', id)}/record-offline-send`, { ...sent, requestKey: `${f.prefix}-unapproved-new-send` })).status).toBe(409);
    expect(ok(await f.request('salesOwner', 'post', `${base('purchase', id)}/generate-document`, originalDocument.command), 'recover original PDF after supplier amendment')).toEqual(originalDocument.generated);
    expect((await f.request('salesOwner', 'post', `${base('purchase', id)}/generate-document`, { ...originalDocument.command, requestKey: `${f.prefix}-unapproved-document` })).status).toBe(409);
    const next = await approve('purchase', id, 3); expect(next).toBe(feedback.item.proposedRevisionId);
    const history = ok(await f.request('salesOwner', 'get', `${base('purchase', id)}/revisions`), 'read immutable supplier revision history').items;
    expect(history.find((row: { id: string }) => row.id === revisionId)).toMatchObject({ status: 'superseded', snapshot: { lines: [expect.objectContaining({ requestedDeliveryDate: '2099-01-01' }), expect.any(Object)] } });
  }, 120_000);
  it('commits supplier direct delivery and exact processing input atomically with zero own stock, recovers a lost ACK, and appends two actual partial returns', async () => {
    await configure('purchase'); await configure('processing');
    const actualSource = await source('direct');
    const raw = ok(await f.request('salesOwner', 'post', base('purchase'), purchaseDraft(actualSource.lineId, `${f.prefix}-direct`)), 'create raw purchase', 201);
    const rawId: string = raw.commandAck.contractId, rawLine = raw.item.draft.lines[0];
    const processing = ok(await f.request('salesOwner', 'post', base('processing'), { requestKey: `${f.prefix}-processing-create`, contractNumber: `${f.prefix}-OSO`, supplierRelationId: f.secondFactory.id,
      currency: 'CNY', paymentTerms: 'T/T 30 days', mainDeliveryLocation: { kind: 'external', name: 'Actual receiver', address: 'Synthetic delivery address' }, orderDate: today(),
      lines: [{ orderLineId: actualSource.lineId, processType: 'Dyeing', description: 'Dye raw cloth', materialCode: `${f.prefix}-dyed`, quantity: '100', unit: 'M', unitPrice: '1', requestedDeliveryDate: '2099-01-10',
        inputSource: { kind: 'purchase_contract', contractId: rawId, lineId: rawLine.id } }] }), 'create independent processing contract', 201);
    const processingId: string = processing.commandAck.contractId, processingLine = processing.item.draft.lines[0];
    const rawRevision = await approve('purchase', rawId), processingRevision = await approve('processing', processingId);
    await document('processing', processingId, processingRevision, `${f.prefix}-processing-document`);
    const before = { inventory: await prisma.inventoryItem.count(), movement: await prisma.stockMovement.count(), receipts: await prisma.materialReceipt.count(), invoices: await prisma.invoice.count() };
    const command = { requestKey: `${f.prefix}-lost-direct-ack`, approvedRevisionId: rawRevision, lines: [{ kind: 'purchase_delivery', lineId: rawLine.id, quantity: '60.125', unit: 'M', occurredAt: today(),
      destination: { kind: 'supplier', relationId: f.secondFactory.id, address: 'Synthetic actual processing address' }, processingContractId: processingId, processingRevisionId: processingRevision, processingLineId: processingLine.id,
      evidence: ['isolated actual signed raw handover'] }] };
    dropAcknowledgement = command.requestKey;
    expect((await f.request('salesOwner', 'post', `${base('purchase', rawId)}/fulfillments`, command)).status).toBe(500);
    const posted = ok(await f.request('salesOwner', 'post', `${base('purchase', rawId)}/fulfillments`, command), 'recover same actual direct command');
    expect(posted.commandAck).toMatchObject({ requestKey: command.requestKey, contractId: rawId, revisionId: rawRevision, factIds: [expect.any(String), expect.any(String)] });
    const facts = await prisma.supplierFulfillmentFact.findMany({ where: { id: { in: posted.commandAck.factIds } }, orderBy: { kind: 'asc' } });
    expect(facts).toHaveLength(2);
    const input = facts.find(row => row.kind === 'processing_input')!, delivery = facts.find(row => row.kind === 'purchase_delivery')!;
    expect(input).toMatchObject({ sourceFactId: delivery.id, outsourcingLineId: processingLine.id, orderLineId: actualSource.lineId, toRelationId: f.secondFactory.id });
    expect(facts.map(row => row.quantity.toString())).toEqual(['60.125', '60.125']);
    expect(await prisma.inventoryItem.count()).toBe(before.inventory); expect(await prisma.stockMovement.count()).toBe(before.movement); expect(await prisma.materialReceipt.count()).toBe(before.receipts);
    for (const [index, quantity] of ['20.125', '42'].entries()) ok(await f.request('salesOwner', 'post', `${base('processing', processingId)}/fulfillments`, { requestKey: `${f.prefix}-actual-return-${index}`, approvedRevisionId: processingRevision,
      lines: [{ kind: 'processing_return', lineId: processingLine.id, quantity, unit: 'M', occurredAt: today(), destination: { kind: 'external', name: 'Actual receiver', address: 'Synthetic delivery address' }, evidence: ['isolated actual return receipt'] }] }), 'append actual partial processing return');
    const read = ok(await f.request('salesOwner', 'get', `${base('processing', processingId)}/fulfillments`), 'read exact return history and cumulative difference').item;
    expect(read.lines[0]).toMatchObject({ lineId: processingLine.id, plannedQuantity: '100', returnedQuantity: '62.125', varianceStatus: 'pending' });
    expect(read.facts.filter((row: { kind: string }) => row.kind === 'processing_return')).toHaveLength(2);
    expect(await prisma.invoice.count()).toBe(before.invoices);
    expect((await prisma.outsourcingOrder.findUniqueOrThrow({ where: { id: processingId } })).qualityAcceptedQty.toString()).toBe('0');
    const changedKey = await f.request('salesOwner', 'post', `${base('purchase', rawId)}/fulfillments`, { ...command, lines: [{ ...command.lines[0], quantity: '61' }] });
    expect(changedKey.status).toBe(409); expect(changedKey.body.code).toBe('REQUEST_KEY_CONFLICT');
    expect((await f.request('salesOutsider', 'post', `${base('purchase', rawId)}/fulfillments`, command)).status).toBe(404);
    expect((await f.request('finance', 'post', base('purchase'), purchaseDraft(actualSource.lineId, `${f.prefix}-finance-denied`))).status).toBe(403);
    expect((await f.request('salesOwner', 'post', `/api/v1/procurement/${enc(rawId)}/send`, {})).status).toBe(409);
    expect((await f.request('salesOwner', 'post', `/api/v1/mes/outsourcing/${enc(processingId)}/receive`, { qualityAcceptedQty: 100 })).status).toBe(409);
  }, 120_000);
  it('plans exact purchase and processing demands through current authority, reads both allocation identities, and closes the legacy allocator without writing', async () => {
    const actualSource = await source('demand-two-contracts'), demandPath = '/api/v1/procurement/demands';
    const prepare = async (kind: 'Material' | 'ProcessingService') => {
      const input = { kind, orderId: actualSource.orderId, orderLineId: actualSource.lineId,
        description: `${kind} exact supplier requirement`, unit: 'M', requestKey: `${f.prefix}-demand-${kind}` };
      const created = ok(await f.request('salesOwner', 'post', demandPath, input), 'create unresolved exact supplier requirement', 201, false).demand;
      expect(created).toMatchObject({ kind, orderId: actualSource.orderId, orderLineId: actualSource.lineId, status: 'NeedsConfirmation', requiredQuantity: null, revision: 1 });
      const replay = ok(await f.request('salesOwner', 'post', demandPath, input), 'recover original exact demand creation', 201, false).demand;
      expect(replay.id).toBe(created.id);
      expect((await f.request('salesOutsider', 'post', `${demandPath}/${enc(created.id)}/claim`, { revision: created.revision })).status).toBe(404);
      const claimed = ok(await f.request('salesOwner', 'post', `${demandPath}/${enc(created.id)}/claim`, { revision: created.revision }), 'claim the actual source requirement', 200, false).demand;
      expect(claimed).toMatchObject({ assigneeId: f.actors.salesOwner.id, requiredQuantity: null, revision: 2 });
      const confirmed = ok(await f.request('salesOwner', 'post', `${demandPath}/${enc(created.id)}/confirm`, {
        revision: claimed.revision, orderLineId: actualSource.lineId, requiredQuantity: '100',
      }), 'explicitly confirm total requirement rather than copy the order quantity', 200, false).demand;
      expect(confirmed).toMatchObject({ id: created.id, status: 'Ready', requiredQuantity: '100', remainingQuantity: '100', revision: 3 });
      return confirmed;
    };
    const rawDemand = await prepare('Material'), processingDemand = await prepare('ProcessingService');
    const rawInput = purchaseDraft(actualSource.lineId, `${f.prefix}-demand-purchase`);
    const raw = ok(await f.request('salesOwner', 'post', base('purchase'), { ...rawInput,
      lines: [{ ...rawInput.lines[0], demandId: rawDemand.id, demandRevision: rawDemand.revision, quantity: '40.125' }],
    }), 'save exact demand allocation with native purchase draft', 201);
    const rawId: string = raw.commandAck.contractId, rawLineId: string = raw.item.draft.lines[0].id;
    const processingNumber = `${f.prefix}-demand-processing-OSO`;
    const processing = ok(await f.request('salesOwner', 'post', base('processing'), { requestKey: `${f.prefix}-demand-processing`, contractNumber: processingNumber,
      supplierRelationId: f.secondFactory.id, currency: 'CNY', paymentTerms: 'T/T 30 days', orderDate: today(),
      mainDeliveryLocation: { kind: 'external', name: 'Actual receiver', address: 'Synthetic exact processing destination' },
      lines: [{ orderLineId: actualSource.lineId, demandId: processingDemand.id, demandRevision: processingDemand.revision, processType: 'Dyeing',
        description: 'Exact processing requirement', materialCode: `${f.prefix}-demand-dyed`, quantity: '30', unit: 'M', unitPrice: '1', requestedDeliveryDate: '2099-01-10',
        inputSource: { kind: 'purchase_contract', contractId: rawId, lineId: rawLineId } }],
    }), 'save exact demand allocation with independent native processing draft', 201);
    const processingId: string = processing.commandAck.contractId, processingLineId: string = processing.item.draft.lines[0].id;
    const listPath = `${demandPath}?orderId=${enc(actualSource.orderId)}`;
    const read = ok(await f.request('salesOwner', 'get', listPath), 'read both native allocation types without nullable purchase-ID lookup', 200, false);
    expect(read.total).toBe(2); expect(read.items).toHaveLength(2);
    const rawRead = read.items.find((row: { id: string }) => row.id === rawDemand.id), processingRead = read.items.find((row: { id: string }) => row.id === processingDemand.id);
    expect(rawRead).toMatchObject({ requiredQuantity: '100', allocatedQuantity: '40.125', remainingQuantity: '59.875', revision: 4,
      allocations: [{ contractKind: 'purchase', contractNumber: rawInput.contractNumber, nativeContract: true, purchaseOrderId: rawId, purchaseLineId: rawLineId,
        outsourcingOrderId: null, outsourcingLineId: null, quantity: '40.125', status: 'Active' }] });
    expect(processingRead).toMatchObject({ requiredQuantity: '100', allocatedQuantity: '30', remainingQuantity: '70', revision: 4,
      allocations: [{ contractKind: 'processing', contractNumber: processingNumber, supplierName: f.secondFactory.name, nativeContract: true,
        purchaseOrderId: null, purchaseLineId: null, outsourcingOrderId: processingId, outsourcingLineId: processingLineId, quantity: '30', status: 'Active' }] });
    const checkpoint = async () => ({ purchases: await prisma.purchaseOrder.count(), processors: await prisma.outsourcingOrder.count(), allocations: await prisma.purchaseDemandAllocation.count(),
      facts: await prisma.supplierFulfillmentFact.count(), receipts: await prisma.materialReceipt.count(), inventory: await prisma.inventoryItem.count(), audit: await prisma.auditLog.count(),
      demand: await prisma.procurementDemand.findUniqueOrThrow({ where: { id: processingDemand.id } }) });
    const before = await checkpoint();
    const legacy = await f.request('salesOwner', 'post', `${demandPath}/${enc(processingDemand.id)}/allocate`, { revision: processingRead.revision, requestKey: `${f.prefix}-closed-allocation`,
      supplierRelationId: f.secondFactory.id, quantity: '1', unitPrice: '2', currency: 'CNY' });
    expect(legacy.status).toBe(409); expect(legacy.body.error.code).toBe('NATIVE_SUPPLIER_CONTRACT_REQUIRED'); expect(await checkpoint()).toEqual(before);
    expect((await f.request('salesOutsider', 'get', listPath)).status).toBe(404);
    expect((await f.request('finance', 'post', `${demandPath}/${enc(processingDemand.id)}/confirm`, { revision: processingRead.revision, orderLineId: actualSource.lineId, requiredQuantity: '200' })).status).toBe(403);
    // These are real authorization inputs, not precomputed business conclusions.
    // Keep the original login JWT to prove each following HTTP request reloads grants.
    const roles = await prisma.userRole.findMany({ where: { userId: f.actors.salesOwner.id } });
    try {
      await prisma.userRole.deleteMany({ where: { userId: f.actors.salesOwner.id } });
      expect((await f.request('salesOwner', 'get', listPath)).status).toBe(403);
      expect((await f.request('salesOwner', 'post', `${demandPath}/${enc(processingDemand.id)}/claim`, { revision: processingRead.revision })).status).toBe(403);
    } finally { await prisma.userRole.createMany({ data: roles }); }
    const memberships = await prisma.teamMember.findMany({ where: { userId: f.actors.salesOwner.id, teamId: f.teamIds.fabric, leftAt: null } });
    expect(memberships).toHaveLength(1);
    try {
      await prisma.teamMember.updateMany({ where: { id: { in: memberships.map(row => row.id) } }, data: { leftAt: new Date() } });
      expect((await f.request('salesOwner', 'post', `${demandPath}/${enc(processingDemand.id)}/claim`, { revision: processingRead.revision })).status).toBe(403);
    } finally { for (const row of memberships) await prisma.teamMember.update({ where: { id: row.id }, data: { leftAt: row.leftAt } }); }
    expect(ok(await f.request('actualRequester', 'get', listPath), 'read current explicitly shared source before revocation', 200, false).items).toHaveLength(2);
    const grants = await prisma.teamDataGrant.findMany({ where: { teamId: { in: Object.values(f.teamIds) }, entityId: f.customer.id, revokedAt: null } });
    expect(grants).toHaveLength(2);
    try {
      await prisma.teamDataGrant.updateMany({ where: { id: { in: grants.map(row => row.id) } }, data: { revokedAt: new Date() } });
      expect((await f.request('actualRequester', 'get', listPath)).status).toBe(404);
      expect((await f.request('actualRequester', 'post', `${demandPath}/${enc(processingDemand.id)}/claim`, { revision: processingRead.revision })).status).toBe(404);
    } finally { for (const row of grants) await prisma.teamDataGrant.update({ where: { id: row.id }, data: { revokedAt: row.revokedAt } }); }
    expect(await checkpoint()).toEqual(before);
    const released = ok(await f.request('salesOwner', 'post', `${demandPath}/${enc(processingDemand.id)}/release`, { revision: processingRead.revision, reason: 'Actual responsibility handoff; keep the exact existing contract allocation' }), 'release responsibility without releasing the contract plan', 200, false).demand;
    expect(released).toMatchObject({ assigneeId: null, allocatedQuantity: '30', remainingQuantity: '70', revision: 5, allocations: processingRead.allocations });
    const reclaimed = ok(await f.request('actualRequester', 'post', `${demandPath}/${enc(processingDemand.id)}/claim`, { revision: released.revision }), 'current source team takes actual responsibility', 200, false).demand;
    expect(reclaimed).toMatchObject({ assigneeId: f.actors.actualRequester.id, revision: 6, allocations: processingRead.allocations });
  }, 120_000);
});
