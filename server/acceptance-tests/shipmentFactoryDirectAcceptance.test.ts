/** Opt-in, actual isolated PostgreSQL/HTTP acceptance for shipping slice C.
 * Only accounts/master data and an unapproved order/line are fixture inputs.
 * Development, formal QC, source binding, approval, production ranges, order
 * samples, loading facts, packing and documents use their native producers.
 * No pass, inventory, approval, loading receipt or dispatch fact is seeded.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createShippingRouter } from '../src/shipping/route';
import { createCustomsRouter } from '../src/customs/customsRoute';
import { verifyFactoryLoadingReceiptInTx } from '../src/shipping/factoryLoadingReceiptService';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createQcPassedFabricArchive,
  type GlobalBusinessHttpFixture, type BusinessFixtureActorName, type HttpMethod } from './globalBusinessFixtures';

let prisma: PrismaClient;
let f: GlobalBusinessHttpFixture;
let archive: Awaited<ReturnType<typeof createQcPassedFabricArchive>>;
let loseNextLoadingAcknowledgement = false;
const today = () => new Date().toISOString().slice(0, 10);
const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
const errorCode = (response: any) => response.body.error?.code ?? response.body.code ?? response.body.error;
function status(response: any, expected = 200, context = 'native HTTP command') {
  expect(response.status, `${context}: ${diagnostic(response.body)}`).toBe(expected);
  // Database-looking digits in legitimate ids/timestamps are not error codes.
  // Inspect the error envelope, keeping actual native command failures visible.
  expect(diagnostic({ error: response.body.error, code: response.body.code, message: response.body.message }))
    .not.toMatch(/\b(?:P2003|P2010|23503|42703)\b|Foreign key|constraint|PRIVATE committed loading/i);
  return response.body;
}
const http = (actor: BusinessFixtureActorName, method: HttpMethod, url: string, body?: unknown) => f.request(actor, method, url, body);
const handoffPath = (id: string) => `/api/v1/shipping/handoffs/${id}`;
const shipmentPath = (id: string) => `/api/v1/shipping/${id}`;
const documentPath = (id: string) => `/api/v1/customs/trade-documents/${id}`;

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL } } });
  await assertIsolatedAcceptanceDatabase(prisma);
  // A real commit with a deliberately lost HTTP acknowledgement. This proxy
  // does not manufacture data or bypass service authorization/transactions.
  const shippingClient = new Proxy(prisma, { get(target, key) {
    if (key === '$transaction') return async (...args: any[]) => {
      const result = await (target.$transaction as any)(...args);
      if (loseNextLoadingAcknowledgement && result?.actualLoadingReceipt?.replayed === false) {
        loseNextLoadingAcknowledgement = false;
        throw new Error('PRIVATE committed loading acknowledgement disconnected');
      }
      return result;
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: `ship-direct-${randomUUID().slice(0, 8)}`,
    mountAdditionalRoutes(app) {
      app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? String(value) : value);
      const options = { prisma, requireAuth: true, apiKeys: new Set<string>() };
      app.use('/api/v1/orders', createOrdersRouter(options));
      app.use('/api/v2/orders', createOrdersV2Router(options));
      app.use('/api/v1/order-lines', createOrderLinesRouter(options));
      app.use('/api/v1/approvals', createApprovalRouter({ prisma, requireAuth: true }));
      app.use('/api/v1/production-batches', createProductionBatchRouter(options));
      app.use('/api/v1/shipping', createShippingRouter({ ...options, prisma: shippingClient, exceptionChecker: null }));
      app.use('/api/v1/customs', createCustomsRouter(options));
      // The shared fixture already mounts native sample and QC routes.
    } });
  // Configured factory capability is master data, not a manufacturing fact.
  await prisma.factoryProfile.create({ data: { id: `${f.prefix}-factory-profile`, relationId: f.factory.id,
    specialties: ['fabric'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  archive = await createQcPassedFabricArchive(f, { key: 'source', lengthMeters: '10.5' });
  // Archiving follows professional QC independently. Binding this exact
  // version to a customer contract additionally needs the actual requester's
  // choice, recorded through its own append-only producer.
  expect(await prisma.developmentVersionConfirmation.count({ where: { sampleVersionId: archive.versionId } })).toBe(0);
  const confirmation = status(await http('salesOwner', 'post',
    `/api/v1/development/${encodeURIComponent(archive.caseId)}/sample-versions/${encodeURIComponent(archive.versionId)}/confirmations`, {
      requestKey: `${f.prefix}-contract-source-confirmation`, confirmerType: 'customer',
      confirmerName: 'Synthetic customer specification reviewer', confirmerRelationId: f.customer.id,
      confirmerOrganization: f.customer.name, confirmedAt: String(Date.now() - 1), result: 'approved',
      basis: 'Isolated synthetic written selection of the exact QC-passed fabric version for this contract',
      evidence: [`isolated-acceptance:${archive.versionId}:customer-written-selection`], sampleBatchId: archive.batchId,
    }), 201, 'record actual requester choice independently of QC and product archive').item;
  expect(confirmation).toMatchObject({ sampleVersionId: archive.versionId, recordedBy: f.actors.salesOwner.id,
    confirmerType: 'customer', result: 'approved' });
  expect(confirmation.confirmerName).not.toBe(f.actors.salesOwner.name);
  const confirmations = status(await http('salesOwner', 'get',
    `/api/v1/development/${encodeURIComponent(archive.caseId)}/version-confirmations?versionIds=${encodeURIComponent(archive.versionId)}`));
  expect(confirmations.items.map((row: any) => row.id)).toEqual([confirmation.id]);
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'fabric',
    userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma?.$disconnect(); });

async function approvedProduction(label: string) {
  const id = `${f.prefix}-${label}`, lineId = `${id}-line`;
  // A draft contract of 1,000m meets the ordinary fabric MOQ. Fabric has one
  // complete production branch; individual shipment plans may reserve parts.
  const created = status(await http('salesOwner', 'post', '/api/v2/orders', { poNumber: null, customer: f.customer.name,
    customerRelationId: f.customer.id, product: 'Isolated fabric contract', type: 'fabric', businessLine: 'fabric',
    quantity: '1000', unit: 'm', status: 'Pending', dueDate: '2099-01-01', quoteAmount: '2500',
    ownerId: f.actors.salesOwner.id, salesPerson: f.actors.salesOwner.name, sourceCaseId: archive.caseId,
    millRelationId: f.factory.id, millName: f.factory.name, currency: 'USD', paymentInstrument: 'T/T',
    paymentTerms: 'T/T 30 days', deliveryTerms: 'FOB', finalContractNumber: `${id}-contract`,
    billToRelationId: f.customer.id, billToName: f.customer.name, billToAddress: 'Synthetic billing address',
    consigneeRelationId: f.customer.id, consigneeName: f.customer.name,
    shipToName: f.customer.name, shipToAddress1: 'Synthetic delivery address', shipToCountry: 'GB',
    source: 'isolated-acceptance-draft' }), 200, 'create native draft contract and freeze actual MOQ policy');
  const orderId = created.order.id;
  expect(created.order.moqSnapshot).toMatchObject({ source: expect.stringMatching(/^(moq_config|fallback_constant)$/) });
  await prisma.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010',
    materialCode: 'ISO-FABRIC', description: 'Native approved fabric source', quantity: '1000', unit: 'm',
    unitPrice: '2.5', requiredSampleFamilies: ['fabric_eps', 'fabric_ss'], partialShipmentAllowed: true,
    tolerancePercent: '5', toleranceSource: 'line_override' } });
  status(await http('salesOwner', 'patch', `/api/v1/order-lines/${lineId}/version`, {
    confirmedSourceType: 'Asset', confirmedSourceId: archive.assetId, millRelationId: f.factory.id,
  }), 200, 'bind real QC-passed archived version');
  const submitted = status(await http('salesOwner', 'post', `/api/v2/orders/${orderId}/submit-main-approval`, {}), 201);
  const review = status(await http('manager', 'get', `/api/v1/approvals/${submitted.item.id}`));
  const approved = status(await http('manager', 'post', `/api/v1/approvals/${submitted.item.id}/decide`, {
    status: 'approved', decisionNote: 'Reviewed the explicit draft contract and exact source',
    confirmedReviewedContent: true, reviewContentVersion: review.item.reviewContentVersion,
  }));
  expect(approved.item.status).toBe('approved');
  expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('Confirmed');
  expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).poNumber).toBeNull();
  const base = `/api/v1/production-batches/orders/${orderId}/lines/${lineId}`;
  const listed = status(await http('salesOwner', 'get', base));
  const made = status(await http('salesOwner', 'post', base, { batchCode: `${id}-batch`, quantity: '1000', unit: 'm',
    factoryRelationId: f.factory.id, expectedLineFingerprint: listed.lineFingerprint, requestKey: randomUUID() }), 201);
  const production: Production = { orderId, lineId, base, batch: made.batch, sampleSourceIds: {} };
  production.sampleSourceIds.fabric_eps = (await requiredOrderSample(production, 'fabric_eps')).sourceId;
  production.sampleSourceIds.fabric_ss = (await requiredOrderSample(production, 'fabric_ss')).sourceId;
  await finalQc(production);
  return production;
}
type Production = { orderId: string; lineId: string; base: string; batch: any; sampleSourceIds: Partial<Record<'fabric_eps' | 'fabric_ss', string>> };

async function requiredOrderSample(p: Production, family: 'fabric_eps' | 'fabric_ss', options: {
  previousSourceId?: string; result?: 'pass' | 'fail';
} = {}) {
  const root = '/api/v1/samples/order-native';
  const context = status(await http('salesOwner', 'get', `${root}/context?orderId=${encodeURIComponent(p.orderId)}&family=${family}`)).data;
  const batch = context.batches.find((row: any) => row.id === p.batch.id);
  expect(batch, 'actual current sample scope').toMatchObject({ selectable: true, revision: p.batch.revision });
  const coverage = [{ orderLineId: p.lineId, expectedLineFingerprint: batch.lineFingerprint,
    productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision, rangeStart: batch.rangeStart,
    quantity: batch.quantity, unit: batch.unit }];
  const parent = status(await http('salesOwner', 'post', `${root}/preview`, {
    family, orderId: p.orderId, factoryRelationId: f.factory.id, coverage,
  })).data;
  let ack = status(await http('salesOwner', 'post', `${root}/register`, { protocolVersion: 1, requestKey: randomUUID(),
    family, orderId: p.orderId, factoryRelationId: f.factory.id, expectedParentFingerprint: parent.parentFingerprint,
    coverage, sampleFacts: { quantity: '0.25', unit: 'M', cuttingDate: today() }, previousSourceId: options.previousSourceId ?? null,
  })).data;
  const append = async (actor: BusinessFixtureActorName, eventType: string, payload: unknown) => {
    ack = status(await http(actor, 'post', `${root}/events`, { protocolVersion: 1, requestKey: randomUUID(),
      sourceId: ack.sourceId, expectedHead: { eventId: ack.eventId, sequence: ack.eventSequence },
      eventType, occurredAt: today(), payload })).data;
    return ack;
  };
  const requested = await append('salesOwner', 'qc_requested', { reason: `Inspect the exact ${family} branch sample` });
  const passed = options.result !== 'fail';
  await append('qc', 'qc_reviewed', { requestedEventId: requested.eventId, result: passed ? 'pass' : 'fail',
    opinion: passed ? 'The exact sampled fabric meets its current specification' : 'A new exact round failed the real QC review',
    inspectionDate: today(), inspectorOrg: 'Bambook QC',
    totalUnits: 1, passedUnits: passed ? 1 : 0, sampleSize: 1, criticalDefects: passed ? 0 : 1, majorDefects: 0, minorDefects: 0,
    defectSummary: '', reportFile: null });
  if (passed) {
    const shipped = await append('salesOwner', 'shipped', { sentDate: today(), courier: 'Synthetic direct factory courier',
      trackingNumber: `${p.batch.id}-${family}`, directShipment: true });
    await append('salesOwner', 'customer_feedback', { shippedEventId: shipped.eventId, result: 'approved', channel: 'written',
      confirmationDate: today(), evidenceRefs: [`isolated-acceptance:${p.orderId}:${family}:written-confirmation`] });
  }
  const readback = status(await http('salesOwner', 'get', `${root}/source/${ack.sourceId}`)).data;
  expect(readback.source.family).toBe(family);
  expect(readback.events.map((row: any) => row.eventType)).toEqual(passed
    ? ['registered', 'qc_requested', 'qc_reviewed', 'shipped', 'customer_feedback'] : ['registered', 'qc_requested', 'qc_reviewed']);
  return ack;
}

async function finalQc(p: Production) {
  const scopes = status(await http('salesOwner', 'get', `/api/v1/qc/orders/${p.orderId}/inspection-scopes`));
  const scope = scopes.scopes.find((row: any) => row.productionBatchId === p.batch.id);
  expect(scope, 'exact Final QC batch').toBeTruthy();
  const assigned = status(await http('salesOwner', 'post', '/api/v1/qc/assignments', { orderId: p.orderId,
    inspectionType: 'final', qcUserId: f.actors.qc.id, dueDate: '2099-01-01', scopeType: 'production_batch',
    productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision,
    expectedScopeFingerprint: scope.scopeFingerprint, requestKey: randomUUID() }), 201);
  status(await http('qc', 'post', `/api/v1/qc/assignments/${assigned.item.id}/start`, {}));
  const completed = status(await http('qc', 'post', `/api/v1/qc/assignments/${assigned.item.id}/complete`, {
    requestKey: randomUUID(), expectedScopeFingerprint: scope.scopeFingerprint,
    report: { result: 'pass', inspectionDate: today(), totalUnits: 1000, passedUnits: 1000, sampleSize: 10, lotSize: 1000,
      criticalDefects: 0, majorDefects: 0, minorDefects: 0 },
  }));
  expect(completed.report.approvedByBusiness).toBe(false);
  const report = completed.report;
  const decided = status(await http('salesOwner', 'post', `/api/v1/qc/reports/${report.id}/business-decision`, {
    decision: 'approved', expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
    expectedContentFingerprint: report.contentFingerprint, requestKey: randomUUID(), reason: 'Reviewed the native Final QC report',
  }));
  expect(decided.item.approvedByBusiness).toBe(true);
}

function handoffInput(p: Production, plannedQty: string) {
  return { shippingMethod: 'Sea', requestKey: randomUUID(), note: 'Original business plan; logistics must verify actual goods',
    allocations: [{ orderId: p.orderId, orderLineId: p.lineId, productionBatchId: p.batch.id,
      productionBatchRevision: p.batch.revision, factoryRelationId: f.factory.id, plannedQty, unit: 'm' }] };
}
async function handoff(p: Production, plannedQty: string) {
  const input = handoffInput(p, plannedQty);
  const eligibility = status(await http('salesOwner', 'post', '/api/v1/shipping/handoffs/eligibility', input));
  expect(eligibility.data, diagnostic(eligibility)).toMatchObject({ eligible: true });
  const bundle = status(await http('salesOwner', 'post', '/api/v1/shipping/handoffs', input), 201).data;
  expect(bundle.handoff.status).toBe('PendingLogistics');
  expect(bundle.allocations[0].actualQty).toBeNull();
  expect(bundle.allocations[0].productionBatchAllocations[0].actualQty).toBeNull();
  return status(await http('logistics', 'post', `${handoffPath(bundle.handoff.id)}/start`, {
    expectedUpdatedAt: bundle.handoff.expectedUpdatedAt,
  })).data;
}
async function actualCommand(bundle: any, actualQty: string, receiptId?: string) {
  const data = status(await http('logistics', 'get', `${handoffPath(bundle.handoff.id)}/actual-loading`)).data;
  const current = data.bundle;
  const allocations = current.allocations.map((allocation: any) => ({ allocationId: allocation.id,
    expectedAllocationUpdatedAt: allocation.expectedUpdatedAt, orderId: allocation.orderId,
    orderLineId: allocation.orderLineId, unit: allocation.unit,
    productionBatchAllocations: allocation.productionBatchAllocations.map((branch: any) => ({
      physicalAllocationId: branch.id, expectedPhysicalUpdatedAt: branch.expectedUpdatedAt,
      productionBatchId: branch.productionBatchId, productionBatchRevision: branch.productionBatchRevision,
      factoryRelationId: branch.factoryRelationId, unit: branch.unit,
      receiptActuals: receiptId ? [{ stockReceiptId: receiptId, actualQty }] : [],
      ...(!receiptId ? { factoryLoading: { actualQty, loadingDate: today(), reference: 'Explicit synthetic factory loading observation, recorded by logistics' } } : {}),
    })) }));
  if (receiptId) expect(data.sources[0].candidates.map((row: any) => row.stockReceiptId)).toContain(receiptId);
  else expect(data.sources[0].candidates).toEqual([]);
  return { expectedUpdatedAt: current.handoff.expectedUpdatedAt, requestKey: randomUUID(),
    reason: 'Factory verified the exact actual quantity; original business plan remains unchanged', allocations };
}
const recordActual = (bundle: any, command: any, actor: BusinessFixtureActorName = 'logistics') =>
  http(actor, 'post', `${handoffPath(bundle.handoff.id)}/actual-loading`, command);
async function packingCommand(bundle: any, p: Production, quantity: string) {
  const readback = status(await http('logistics', 'get', `${shipmentPath(bundle.shipment.id)}/packing`));
  return { requestKey: randomUUID(), expectedShipmentUpdatedAt: readback.context.updatedAt,
    expectedPhysicalAllocationFingerprint: readback.context.allocationFingerprint,
    lines: [{ clientLineKey: 'exact-line', orderLineId: p.lineId, productCode: 'ISO-FABRIC', productName: 'Native fabric',
      quantity, unit: 'm', cartons: 1, grossWeight: '10', netWeight: '9', volume: '0.125', hsCode: '5112110000', countryOfOrigin: 'CN' }],
    cartons: [{ cartonNo: 'A-1', description: 'Explicit measured package', length: '50', width: '50', height: '50',
      grossWeight: '10', netWeight: '9', volume: '0.125', items: [{ lineKey: 'exact-line', quantity }] }] };
}
async function physicalCommand(shipmentId: string, actor: BusinessFixtureActorName = 'logistics') {
  const current = status(await http(actor, 'get', `${shipmentPath(shipmentId)}/physical-context`));
  return { requestKey: randomUUID(), expectedShipmentUpdatedAt: current.updatedAt,
    expectedPhysicalAllocationFingerprint: current.allocationFingerprint };
}
async function noFakeWarehouseFacts(orderId: string) {
  expect(await prisma.productionStockReceipt.count({ where: { orderId } })).toBe(0);
  expect(await prisma.inventoryItem.count({ where: { orderId } })).toBe(0);
  expect(await prisma.stockMovement.count({ where: { item: { orderId } } })).toBe(0);
}

async function prepareReturnedDocuments(bundle: any, p: Production) {
  // Transport and external filing are recorded before the CI/PL source is
  // frozen. Later technical handoff changes must not stale business documents.
  status(await http('logistics', 'patch', shipmentPath(bundle.shipment.id), {
    ...await physicalCommand(bundle.shipment.id), status: 'Booked', bookingDate: today(), shippingMethod: 'Sea', loadType: 'LCL',
    bookingNo: `${f.prefix}-BOOK`, vesselOrFlight: 'Synthetic vessel', voyageNumber: 'ISO-01',
    portOfLoading: 'Shanghai', portOfDischarge: 'London', etd: today(), totalPackages: 1,
    grossWeight: '10', netWeight: '9', volume: '0.125',
  }));
  const external = status(await http('logistics', 'post', '/api/v1/customs/trade-documents', {
    type: 'ExportDeclarationProof', shipmentId: bundle.shipment.id, orderId: p.orderId, relationId: f.customer.id,
    notes: 'Synthetic externally supplied filing completion file; no local customs declaration is created',
  }), 201).item;
  const file = Buffer.from('%PDF-1.4\n% Isolated synthetic external filing evidence\n%%EOF\n');
  const uploaded = await request(f.app).post(`${documentPath(external.id)}/external-archive`)
    .set('Authorization', `Bearer ${f.actors.logistics.token}`).attach('file', file, { filename: 'external-filing.pdf', contentType: 'application/pdf' });
  status(uploaded, 201, 'native protected external document archive');
  status(await http('logistics', 'post', `${shipmentPath(bundle.shipment.id)}/export-declaration-completion`, {
    ...await physicalCommand(bundle.shipment.id), completedAt: `${today()}T08:00:00.000Z`,
    evidenceDocumentId: external.id, reference: `${f.prefix}-EXTERNAL`,
  }), 200, 'native external filing completion for a modern physical ticket');
  const lines = await prisma.shipmentLine.findMany({ where: { shipmentId: bundle.shipment.id }, orderBy: { id: 'asc' } });
  const selection = { lineIds: lines.map(row => row.id) };
  const source = status(await http('logistics', 'post', `${shipmentPath(bundle.shipment.id)}/business-ci/source`, selection)).data;
  expect(source.totalAmount).toBe('10'); expect(source.currency).toBe('USD');
  expect(source.lines[0]).toMatchObject({ orderId: p.orderId, orderLineId: p.lineId, quantity: '4', unit: 'm', unitPrice: '2.5' });
  const draft = status(await http('logistics', 'post', `${shipmentPath(bundle.shipment.id)}/business-ci/draft`, {
    ...selection, requestKey: randomUUID(), expectedSourceFingerprint: source.sourceFingerprint,
  })).data;
  expect(draft.item.sourceInvoiceId).toBeNull();
  expect(await prisma.invoice.count({ where: { orderId: p.orderId } })).toBe(0);
  const issued = status(await http('logistics', 'post', `${shipmentPath(bundle.shipment.id)}/business-ci/${draft.item.id}/issue`, {
    ...selection, requestKey: randomUUID(), expectedSourceFingerprint: source.sourceFingerprint,
  })).data;
  expect(issued.item.status).toBe('Issued');
  const pl = status(await http('logistics', 'post', '/api/v1/customs/trade-documents/generate-from-shipment', {
    shipmentId: bundle.shipment.id, types: ['PackingList'],
  }), 201);
  const plId = pl.created[0].id;
  status(await http('logistics', 'post', `${documentPath(plId)}/transition`, { toStatus: 'Issued' }));
  const ciVersion = await prisma.documentVersion.findUniqueOrThrow({ where: { id: issued.versionId } });
  const plVersion = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: plId }, orderBy: { version: 'desc' } });
  expect((plVersion.content as any).plDraftProtocol).toBe(2);
  expect((plVersion.content as any).packingList.packingListSource.lines[0].quantity).toBe('4');
  for (const [documentId, version] of [[draft.item.id, ciVersion.version], [plId, plVersion.version]] as const) {
    status(await http('logistics', 'post', `${documentPath(documentId)}/generate-file`, { version }), 201, 'native CI/PL PDF archive');
    const download = await request(f.app).get(`${documentPath(documentId)}/download?version=${version}`)
      .set('Authorization', `Bearer ${f.actors.salesOwner.token}`).buffer(true).parse((response: any, done: any) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(download.status, diagnostic(download.body)).toBe(200);
    expect(download.body.subarray(0, 5).toString()).toBe('%PDF-');
  }
  const current = status(await http('logistics', 'get', handoffPath(bundle.handoff.id))).data;
  const returned = status(await http('logistics', 'post', `${handoffPath(bundle.handoff.id)}/complete`, {
    expectedUpdatedAt: current.handoff.expectedUpdatedAt, note: 'Current issued and archived CI/PL returned to the original business owner',
  })).data;
  expect(returned.handoff.status).toBe('ReturnedToBusiness');
  expect(returned.shipment.status).toBe('Booked'); expect(returned.shipment.atd).toBeNull();
  const documents = status(await http('salesOwner', 'get', `/api/v1/orders/${p.orderId}/shipment-documents`));
  expect(diagnostic(documents)).toContain(draft.item.id); expect(diagnostic(documents)).toContain(plId);
  for (const [documentId, version] of [[draft.item.id, ciVersion], [plId, plVersion]] as const) {
    const input = { requestKey: randomUUID(), shipmentId: bundle.shipment.id, documentId,
      versionId: version.id, version: version.version, recipient: 'Synthetic customer delivery at customer.example.invalid' };
    status(await http('salesOwner', 'post', `/api/v1/orders/${p.orderId}/shipment-documents/sent`, input), 201);
    expect(status(await http('salesOwner', 'post', `/api/v1/orders/${p.orderId}/shipment-documents/sent`, input)).replayed).toBe(true);
  }
  return returned;
}

describe.sequential('native factory-direct and received-goods shipment handoff, actual isolated PG/HTTP', () => {
  it('C01 source→approval→required sample/Final QC→verified direct loading→business decision→packing→CI/PL return→ATD; cancellation preserves history and capacity', async () => {
    const p = await approvedProduction('full');
    let a = await handoff(p, '5');
    const originalPlan = a.allocations[0].plannedQty;
    const blockedUnknown = await http('logistics', 'put', `${shipmentPath(a.shipment.id)}/packing`, await packingCommand(a, p, '5'));
    expect(blockedUnknown.status, diagnostic(blockedUnknown.body)).toBe(409);
    const command = await actualCommand(a, '4');
    const beforeProofs = await prisma.factoryLoadingReceipt.count({ where: { shipmentId: a.shipment.id } });
    expect((await recordActual(a, command, 'salesOwner')).status).toBe(403);
    const foreignRead = await http('salesOutsider', 'get', handoffPath(a.handoff.id));
    expect(foreignRead.status).toBe(404);
    loseNextLoadingAcknowledgement = true;
    const unknown = await recordActual(a, command);
    expect(unknown.status).toBe(500);
    expect(await prisma.factoryLoadingReceipt.count({ where: { shipmentId: a.shipment.id } })).toBe(beforeProofs + 1);
    a = status(await recordActual(a, command), 200, 'same-key recovery after the actual commit').data;
    expect(a.actualLoadingReceipt.replayed).toBe(true);
    expect(a.handoff.status).toBe('NeedsBusinessDecision');
    expect(a.allocations[0].plannedQty).toBe(originalPlan); expect(a.allocations[0].actualQty).toBe('4');
    const directProof = await prisma.factoryLoadingReceipt.findFirstOrThrow({ where: { shipmentId: a.shipment.id } });
    expect(directProof.requestKey).toBe(command.requestKey); expect(directProof.createdBy).toBe(f.actors.logistics.id);
    const proofBefore = diagnostic(directProof);
    const collision = structuredClone(command); collision.allocations[0].productionBatchAllocations[0].factoryLoading.actualQty = '3';
    const conflicted = await recordActual(a, collision);
    expect(conflicted.status).toBe(409); expect(errorCode(conflicted)).toBe('REQUEST_CONFLICT');
    expect((await http('logistics', 'put', `${shipmentPath(a.shipment.id)}/packing`, await packingCommand(a, p, '4'))).status).toBe(409);
    a = status(await http('salesOwner', 'post', `${handoffPath(a.handoff.id)}/return-to-logistics`, {
      expectedUpdatedAt: a.handoff.expectedUpdatedAt, decision: 'accept_actual', response: 'Accept the four metres explicitly verified by the factory',
    })).data;
    expect(a.handoff.status).toBe('Processing'); expect(a.allocations[0].plannedQty).toBe('5');
    const stale = await recordActual(a, { ...command, requestKey: randomUUID() });
    expect(stale.status, diagnostic(stale.body)).toBe(409);

    // A second real draft reserves the remaining 995m. A concurrent identical
    // loading request creates one receipt and recovers the same original fact.
    let b = await handoff(p, '995');
    const secondCommand = await actualCommand(b, '994');
    const pair = await Promise.all([recordActual(b, secondCommand), recordActual(b, secondCommand)]);
    expect(pair.map(row => row.status), diagnostic(pair.map(row => row.body))).toEqual([200, 200]);
    expect(pair.map(row => row.body.data.actualLoadingReceipt.replayed).sort()).toEqual([false, true]);
    b = pair[0].body.data;
    const bProof = await prisma.factoryLoadingReceipt.findFirstOrThrow({ where: { shipmentId: b.shipment.id } });
    const bFrozen = diagnostic(bProof);
    const oversized = await http('salesOwner', 'post', '/api/v1/shipping/handoffs', handoffInput(p, '1'));
    expect(oversized.status, diagnostic(oversized.body)).toBe(409);
    const cancellation = { expectedUpdatedAt: b.handoff.expectedUpdatedAt, decision: 'cancel', requestKey: randomUUID(),
      response: 'Cancel this unbooked document-free draft; retain the factory observation as history' };
    b = status(await http('salesOwner', 'post', `${handoffPath(b.handoff.id)}/return-to-logistics`, cancellation)).data;
    expect(b.handoff.status).toBe('Cancelled'); expect(b.shipment.status).toBe('Cancelled');
    expect(await prisma.shipmentProductionAllocation.count({ where: { shipmentId: b.shipment.id, state: 'reserved' } })).toBe(0);
    expect(diagnostic(await prisma.factoryLoadingReceipt.findUniqueOrThrow({ where: { id: bProof.id } }))).toBe(bFrozen);
    expect((status(await http('salesOwner', 'post', `${handoffPath(b.handoff.id)}/return-to-logistics`, cancellation))).data.handoff.status).toBe('Cancelled');
    expect((await http('salesOwner', 'post', '/api/v1/shipping/handoffs', handoffInput(p, '996'))).status).toBe(409);
    await noFakeWarehouseFacts(p.orderId);

    status(await http('logistics', 'put', `${shipmentPath(a.shipment.id)}/packing`, await packingCommand(a, p, '4')));
    const packed = status(await http('logistics', 'get', `${shipmentPath(a.shipment.id)}/packing`));
    expect(packed.lines[0].quantity).toBe('4'); expect(packed.cartons[0].items[0].quantity).toBe('4');
    expect((await recordActual(a, await actualCommand(a, '4'))).status).toBe(409);
    a = await prepareReturnedDocuments(a, p);
    const actualDeparture = { expectedUpdatedAt: a.handoff.expectedUpdatedAt, ...await physicalCommand(a.shipment.id, 'salesOwner'), atd: today() };
    a = status(await http('salesOwner', 'post', `${handoffPath(a.handoff.id)}/confirm-departure`, actualDeparture)).data;
    expect(a.shipment.status).toBe('Shipped'); expect(a.shipment.atd).toBe(today());
    expect(await prisma.shipmentProductionAllocation.count({ where: { shipmentId: a.shipment.id, state: 'shipped' } })).toBe(1);
    const shippedAudit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: a.shipment.id, action: 'update_physical_shipment',
      detail: { path: ['after', 'ack', 'shipmentAfter', 'status'], equals: 'Shipped' } } });
    expect((shippedAudit.detail as any).after.ack.stockMovements).toEqual([]);
    expect((shippedAudit.detail as any).after.ack.factoryLoadings).toEqual([expect.objectContaining({ factoryLoadingReceiptId: directProof.id, quantity: '4' })]);
    const deniedCancel = await http('salesOwner', 'post', `${handoffPath(a.handoff.id)}/cancel`, {
      expectedUpdatedAt: a.handoff.expectedUpdatedAt, requestKey: randomUUID(), response: 'Probe: actual ATD cannot be cancelled',
    });
    expect(deniedCancel.status).toBe(409);
    const genericCancel = await http('salesOwner', 'patch', shipmentPath(a.shipment.id), {
      ...await physicalCommand(a.shipment.id, 'salesOwner'), status: 'Cancelled',
    });
    expect(genericCancel.status).toBe(409);
    expect(diagnostic(await prisma.factoryLoadingReceipt.findUniqueOrThrow({ where: { id: directProof.id } }))).toBe(proofBefore);
    const retained = await prisma.shipmentProductionAllocation.findFirstOrThrow({ where: { shipmentId: a.shipment.id } });
    expect(retained.state).toBe('shipped'); expect(String(retained.actualQty)).toBe('4');
    await noFakeWarehouseFacts(p.orderId);
    // Reserved A consumed max(plan=5,actual=4); shipped A consumes actual=4.
    // The released second ticket consumes nothing, leaving exactly 996m.
    const remaining = status(await http('salesOwner', 'post', '/api/v1/shipping/handoffs', handoffInput(p, '996')), 201).data;
    expect(remaining.allocations[0].plannedQty).toBe('996');
    status(await http('salesOwner', 'post', `${handoffPath(remaining.handoff.id)}/cancel`, {
      expectedUpdatedAt: remaining.handoff.expectedUpdatedAt, requestKey: randomUUID(), response: 'Release the test-only remaining plan',
    }));
  }, 180_000);

  it('C02 a new native sample round fails formal QC; prior loading proof cannot preserve current business qualification or rewrite history', async () => {
    const p = await approvedProduction('revision');
    let bundle = await handoff(p, '5');
    const command = await actualCommand(bundle, '4');
    bundle = status(await recordActual(bundle, command)).data;
    const original = await prisma.factoryLoadingReceipt.findFirstOrThrow({ where: { shipmentId: bundle.shipment.id } });
    const frozen = diagnostic(original);
    bundle = status(await http('salesOwner', 'post', `${handoffPath(bundle.handoff.id)}/return-to-logistics`, {
      expectedUpdatedAt: bundle.handoff.expectedUpdatedAt, decision: 'accept_actual', response: 'Accept the real loading observation before the next sample review',
    })).data;
    const next = await requiredOrderSample(p, 'fabric_eps', { previousSourceId: p.sampleSourceIds.fabric_eps, result: 'fail' });
    expect(next.sourceId).not.toBe(p.sampleSourceIds.fabric_eps);
    const eligibility = status(await http('salesOwner', 'post', '/api/v1/shipping/handoffs/eligibility', handoffInput(p, '5'))).data;
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.branches[0].blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUIRED_SAMPLE_NOT_APPROVED', family: 'fabric_eps' }),
    ]));
    const refused = await http('logistics', 'post', `${handoffPath(bundle.handoff.id)}/complete`, {
      expectedUpdatedAt: bundle.handoff.expectedUpdatedAt, note: 'Probe: prior loading does not restore current failed sample qualification',
    });
    expect(refused.status, diagnostic(refused.body)).toBe(409); expect(errorCode(refused)).toBe('GATE_BLOCKED');
    expect(diagnostic(await prisma.factoryLoadingReceipt.findUniqueOrThrow({ where: { id: original.id } }))).toBe(frozen);
    // Immutable history remains readable against its ORIGINAL, exact scope.
    const history = await verifyFactoryLoadingReceiptInTx(prisma, original.id, p.batch, original.scopeFingerprint, {
      shipmentId: original.shipmentId, allocationId: original.allocationId, handoffId: original.handoffId,
    });
    expect(history.identity.factoryLoadingReceiptId).toBe(original.id);
    bundle = status(await http('logistics', 'post', `${handoffPath(bundle.handoff.id)}/return-to-business`, {
      expectedUpdatedAt: bundle.handoff.expectedUpdatedAt, reason: 'New exact sample round failed; return the actual observation for business decision',
    })).data;
    bundle = status(await http('salesOwner', 'post', `${handoffPath(bundle.handoff.id)}/return-to-logistics`, {
      expectedUpdatedAt: bundle.handoff.expectedUpdatedAt, decision: 'cancel', requestKey: randomUUID(), response: 'Cancel the unbooked and document-free ticket after new QC failure',
    })).data;
    expect(bundle.handoff.status).toBe('Cancelled');
    expect(diagnostic(await prisma.factoryLoadingReceipt.findUniqueOrThrow({ where: { id: original.id } }))).toBe(frozen);
    expect(await prisma.shipmentProductionAllocation.count({ where: { shipmentId: bundle.shipment.id, state: 'reserved' } })).toBe(0);
    await noFakeWarehouseFacts(p.orderId);
  }, 120_000);

  it('C03 unknown native received-goods allocation→real receipt→professional actual loading→packing; plan and stock are preserved', async () => {
    const p = await approvedProduction('received');
    const receiptPath = `/api/v1/production-batches/${p.batch.id}/stock-receipts`;
    const before = status(await http('logistics', 'get', receiptPath));
    const received = status(await http('logistics', 'post', receiptPath, { expectedBatchRevision: p.batch.revision,
      expectedScopeFingerprint: before.scopeFingerprint, warehouseId: f.warehouse.id, quantity: '5', unit: 'm',
      movementDate: today(), receiptReference: 'Explicit native receipt before factory packing', ownership: 'Owned',
      unitCost: null, currency: 'USD', requestKey: randomUUID() }), 201);
    let bundle = await handoff(p, '5');
    const command = await actualCommand(bundle, '5', received.receipt.id);
    bundle = status(await recordActual(bundle, command)).data;
    expect(bundle.handoff.status).toBe('Processing'); expect(bundle.actualLoadingReceipt.requiresBusinessDecision).toBe(false);
    expect(bundle.allocations[0]).toMatchObject({ plannedQty: '5', actualQty: '5' });
    expect(bundle.allocations[0].productionBatchAllocations[0].stockReceiptAllocations)
      .toEqual([expect.objectContaining({ stockReceiptId: received.receipt.id, plannedQty: '5', actualQty: '5' })]);
    status(await http('logistics', 'put', `${shipmentPath(bundle.shipment.id)}/packing`, await packingCommand(bundle, p, '5')));
    const readback = status(await http('logistics', 'get', `${shipmentPath(bundle.shipment.id)}/packing`));
    expect(readback.lines[0].quantity).toBe('5');
    expect(await prisma.factoryLoadingReceipt.count({ where: { shipmentId: bundle.shipment.id } })).toBe(0);
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: received.inventoryItem.id } });
    expect(String(item.quantity)).toBe('5');
    expect(await prisma.stockMovement.count({ where: { itemId: item.id, type: 'Outbound' } })).toBe(0);
    expect((status(await recordActual(bundle, command))).data.actualLoadingReceipt.replayed).toBe(true);
  }, 120_000);
});
