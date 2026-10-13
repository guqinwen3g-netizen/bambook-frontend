/** Isolated real HTTP/PG only. Master grants are fixture inputs; approvals,
 * supplier contracts, original VAT, AP, payments and allocations use producers. */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createQcPassedFabricArchive, recordExactDevelopmentConfirmation,
  type GlobalBusinessHttpFixture, type BusinessFixtureActorName } from './globalBusinessFixtures';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createProcurementRouter } from '../src/procurement/procurementRoute';
import { createFinanceRouter } from '../src/finance/route';
import { createPaymentRequestRouter } from '../src/paymentRequests/paymentRequestRoute';
import { registerPaymentRequestApprovalHook } from '../src/paymentRequests/paymentRequestApprovalHook';
import { approvalEventBus } from '../src/agent/events';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { createAuthService } from '../src/auth/service';
import { createAcceptanceCashAccount, acceptanceCashInput } from './companyCashAcceptanceHelpers';
import type { SupplierVatSelectedLine } from '../src/finance/supplierVatPayableSource';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, archive: Awaited<ReturnType<typeof createQcPassedFabricArchive>>;
let loseAck: string | null = null, hooks: Function[] = [];
const enc = encodeURIComponent, date = '2026-10-08';
const stringify = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v);
function body(response: { status: number; body: any }, label: string, status = 200) {
  expect(response.status, `${label}: ${stringify(response.body)}`).toBe(status);
  // Numeric SQL codes can legitimately occur inside generated business IDs.
  // Check actual diagnostics rather than treating those IDs as SQL failures.
  expect(stringify(response.body?.error ?? null)).not.toMatch(/P2003|P2010|23503|42703/i);
  expect(stringify(response.body)).not.toMatch(/PRIVATE committed supplier VAT/i);
  return response.body;
}
const payable = (id: string, suffix = '') => `/api/v1/finance/supplier-vat-payables/${enc(id)}${suffix}`;
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_target, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      const result = await (prisma.$transaction as (...args: unknown[]) => Promise<unknown>).apply(prisma, args);
      const envelope = result && typeof result === 'object' && 'financeCommand' in result ? result.financeCommand : null;
      if (loseAck && envelope && typeof envelope === 'object' && 'requestKey' in envelope && envelope.requestKey === loseAck) {
        loseAck = null; throw Error('PRIVATE committed supplier VAT acknowledgement lost');
      }
      return result;
    };
    const value = Reflect.get(prisma, key); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `supplier-vat-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_k: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options)); app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/procurement', createProcurementRouter(options));
    // Exercise root's real guarded finance mount, not an alternate test router.
    app.use('/api/v1/finance', createFinanceRouter(options)); app.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma: client, requireAuth: true }));
  } });
  for (const supplier of [f.factory, f.secondFactory]) await prisma.factoryProfile.create({ data: { id: `${supplier.id}-profile`,
    relationId: supplier.id, specialties: ['fabric'], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  archive = await createQcPassedFabricArchive(f, { key: 'supplier-vat-native-source' });
  await recordExactDevelopmentConfirmation(f, archive);
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'fabric', userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
  const user = await prisma.userAccount.findUniqueOrThrow({ where: { id: f.actors.salesOwner.id }, select: { primaryDeptId: true } });
  await prisma.department.update({ where: { id: user.primaryDeptId! }, data: { headId: f.actors.manager.id } });
  const existing = new Set(approvalEventBus.listeners('resolved'));
  registerPaymentRequestApprovalHook({ prisma: client }); hooks = approvalEventBus.listeners('resolved').filter(listener => !existing.has(listener));
  for (const kind of ['purchase', 'processing']) {
    const url = `/api/v1/procurement/contracts/approval-authority/${kind}/fabric`;
    const current = body(await f.request('admin', 'get', url), 'read supplier authority').item;
    body(await f.request('admin', 'put', url, { requestKey: `${f.prefix}-${kind}-authority`, expectedConfigVersion: current.version,
      userIds: [f.actors.manager.id, f.actors.superAdmin.id], reason: 'Actual isolated supplier approvers; owner handles explicitly cross-group sources without widening manager scope' }), 'set supplier authority');
  }
}, 120_000);
afterAll(async () => { for (const hook of hooks) approvalEventBus.off('resolved', hook as (...args: any[]) => void); await f?.close(); await prisma.$disconnect(); });

async function source(label: string, actor: 'salesOwner' | 'actualRequester' = 'salesOwner', customer = f.customer, chosenArchive = archive) {
  const created = body(await f.request(actor, 'post', '/api/v2/orders', { poNumber: null, customer: customer.name, customerRelationId: customer.id,
    product: `Supplier VAT ${label}`, type: 'fabric', businessLine: 'fabric', quantity: '1000', unit: 'M', status: 'Pending', dueDate: '2099-01-01', quoteAmount: '2500',
    ownerId: f.actors[actor].id, salesPerson: f.actors[actor].name, sourceCaseId: chosenArchive.caseId, millRelationId: f.factory.id, millName: f.factory.name,
    currency: 'CNY', paymentInstrument: 'T/T', paymentTerms: 'TT 30 days', deliveryTerms: 'FOB', finalContractNumber: `${f.prefix}-${label}-buyer-contract`,
    billToRelationId: customer.id, billToName: customer.name, billToAddress: 'Isolated billing address', consigneeRelationId: customer.id,
    consigneeName: customer.name, shipToName: customer.name, shipToAddress1: 'Isolated destination', shipToCountry: 'GB' }), 'create real source order').order;
  const line = body(await f.request(actor, 'post', '/api/v1/order-lines', { orderId: created.id, itemNo: label, description: `Exact source ${label}`,
    materialCode: `${f.prefix}-${label}`, quantity: '1000', unit: 'M', unitPrice: '2.5' }), 'create actual line').line;
  body(await f.request(actor, 'patch', `/api/v1/order-lines/${enc(line.id)}/version`, { confirmedSourceType: 'Asset', confirmedSourceId: chosenArchive.assetId }), 'bind actual chosen QC asset');
  const submitted = body(await f.request(actor, 'post', `/api/v2/orders/${enc(created.id)}/submit-main-approval`, {}), 'submit actual main approval', 201).item;
  const reviewer = actor === 'actualRequester' ? 'superAdmin' : 'manager';
  const review = body(await f.request(reviewer, 'get', `/api/v1/approvals/${enc(submitted.id)}`), 'read exact main approval').item;
  const decided = body(await f.request(reviewer, 'post', `/api/v1/approvals/${enc(review.id)}/decide`, {
    status: 'approved', confirmedReviewedContent: true, reviewContentVersion: review.reviewContentVersion, decisionNote: 'Reviewed exact source and commercial terms' }), 'approve actual source').item;
  expect(decided).toMatchObject({ status: 'approved', businessSyncStatus: 'completed' });
  return { orderId: created.id as string, lineId: line.id as string };
}
async function contract(kind: 'purchase' | 'processing', sourceIds: string[], label: string, actor: 'salesOwner' | 'actualRequester' | 'manager' = 'salesOwner') {
  const url = `/api/v1/procurement/contracts/${kind}`;
  const draft = { requestKey: `${f.prefix}-${label}-create`, contractNumber: `${f.prefix}-${label}`, supplierRelationId: f.factory.id,
    currency: 'CNY', paymentTerms: 'TT 30 days', mainDeliveryLocation: { kind: 'external', name: 'Isolated receiver', address: 'Actual declared destination' }, orderDate: date,
    lines: sourceIds.map(orderLineId => ({ orderLineId, description: `${kind} exact source`, quantity: '100', unit: 'M', unitPrice: '1', requestedDeliveryDate: '2099-01-01',
      ...(kind === 'purchase' ? { kind: 'Material', category: 'Fabric' } : { processType: 'Dyeing', inputSource: { kind: 'customer_supplied', relationId: f.customer.id } }) })) };
  const created = body(await f.request(actor, 'post', url, draft), 'create real supplier contract', 201);
  const id = created.commandAck.contractId as string;
  const submitted = body(await f.request(actor, 'post', `${url}/${enc(id)}/submit`, { requestKey: `${f.prefix}-${label}-submit`, expectedRevision: 1 }), 'submit supplier contract');
  const reviewer = actor === 'salesOwner' ? 'manager' : 'superAdmin';
  const review = body(await f.request(reviewer, 'get', `/api/v1/approvals/${enc(submitted.commandAck.approvalId)}`), 'read supplier frozen proof').item;
  const approved = body(await f.request(reviewer, 'post', `/api/v1/approvals/${enc(review.id)}/decide`, { status: 'approved', confirmedReviewedContent: true,
    reviewContentVersion: review.reviewContentVersion, requestKey: `${f.prefix}-${label}-approve`, decisionNote: 'Approved real vendor, price, exact sources and delivery' }), 'approve supplier contract');
  expect(approved.item).toMatchObject({ status: 'approved', businessSyncStatus: 'completed' });
  return { kind, id, revisionId: submitted.commandAck.revisionId as string, lines: created.item.draft.lines as Array<{ id: string; orderLineId: string }>, draft };
}
function selected(c: Awaited<ReturnType<typeof contract>>, index: number, amount: string): SupplierVatSelectedLine {
  return { contractKind: c.kind, contractId: c.id, commitmentRevisionId: c.revisionId, lineId: c.lines[index].id, contractAmount: amount };
}
async function vat(label: string, net: string) {
  const tax = new Prisma.Decimal(net).mul('0.13').toDecimalPlaces(4);
  return body(await f.request('finance', 'post', '/api/v1/finance/vat-invoices', { requestKey: randomUUID(), vatNumber: `${f.prefix}-${label}`, direction: 'Input', invoiceType: 'Special',
    sellerName: f.factory.name, buyerName: 'Isolated actual company', issueDate: date, netAmount: net, taxRate: '13', taxAmount: tax.toFixed(4),
    totalAmount: new Prisma.Decimal(net).plus(tax).toFixed(4), currency: 'CNY', relationId: f.factory.id,
    notes: 'Externally issued supplier original declared through native VAT producer; no invented file, fulfillment or payment fact' }), 'record real Input VAT', 201);
}
async function command(vatId: string, sources: SupplierVatSelectedLine[]) {
  const selection = { amountBasis: 'net' as const, dueDate: '2026-11-08', sources };
  const preview = body(await f.request('finance', 'post', payable(vatId, '/preview'), selection), 'preview original VAT and exact contract capacity');
  return { ...selection, requestKey: randomUUID(), expectedVatUpdatedAt: preview.vatUpdatedAt as string, expectedSourceFingerprint: preview.sourceFingerprint as string };
}

describe('native Input VAT → exact approved contract → AP → actual payment and multi-AP allocation', () => {
  it('registers purchase/processing sources without finance owning contracts, recovers unknown ACK, and pays portions of two original APs', async () => {
    const firstSource = await source('first'), secondSource = await source('second');
    const purchase = await contract('purchase', [firstSource.lineId], 'actual-purchase'), processing = await contract('processing', [secondSource.lineId], 'actual-processing');
    const stockBefore = await prisma.inventoryItem.count();
    const original = await vat('original-one', '100'), originalCommand = await command(original.id, [selected(purchase, 0, '60'), selected(processing, 0, '40')]);
    expect((await f.request('salesOwner', 'post', payable(original.id, '/register'), originalCommand)).status).toBe(403);
    const limited = { ...f.actors.finance, token: createAuthService().signToken({ userId: f.actors.finance.id, roles: ['finance'], roleIds: [], departmentIds: [], permissions: [],
      permissionCeiling: ['invoices:read', 'vat:read'] }) };
    const candidatePage = body(await f.request(limited, 'get', payable(original.id, '/sources?amountBasis=net&limit=100')), 'read approved sources with finance read ceiling only');
    expect(candidatePage.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ contractKind: 'purchase', contractId: purchase.id, commitmentRevisionId: purchase.revisionId, lineId: purchase.lines[0].id,
        orderId: firstSource.orderId, orderLineId: firstSource.lineId, approvedLineAmount: '100.0000', paymentTerms: 'TT 30 days',
        registeredAmount: '0.0000', remainingAmount: '100.0000', registeredAmountBasis: null, selectable: true }),
      expect.objectContaining({ contractKind: 'processing', contractId: processing.id, commitmentRevisionId: processing.revisionId, lineId: processing.lines[0].id, selectable: true }),
    ]));
    expect(Object.keys(candidatePage).sort()).toEqual(['hasMore', 'items', 'nextCursor', 'ok']);
    expect((await f.request(limited, 'post', payable(original.id, '/register'), originalCommand)).status).toBe(403);
    expect((await f.request('finance', 'post', '/api/v1/finance', { invoiceNumber: 'fake-source', type: 'Payable', status: 'Issued', amount: '113', currency: 'CNY',
      issueDate: date, customerRelationId: f.factory.id, sourceType: 'SupplierVatPayable', sourceId: original.id })).status).toBe(409);
    loseAck = originalCommand.requestKey;
    expect((await f.request('finance', 'post', payable(original.id, '/register'), originalCommand)).status).toBe(500);
    const recovered = body(await f.request('finance', 'post', payable(original.id, '/register'), originalCommand), 'recover committed original AP');
    expect(recovered).toMatchObject({ replayed: true, invoice: { type: 'Payable', status: 'Issued', amount: '113', sourceType: 'SupplierVatPayable', sourceId: original.id },
      receipt: { requestKey: originalCommand.requestKey, actorId: f.actors.finance.id, vatInvoiceId: original.id, invoiceId: recovered.invoice.id } });
    expect(recovered.snapshot.sources.map((row: { contractKind: string }) => row.contractKind).sort()).toEqual(['processing', 'purchase']);
    const allocations = await prisma.invoiceOrderAllocation.findMany({ where: { invoiceId: recovered.invoice.id } });
    expect(allocations.map(row => row.orderId).sort()).toEqual([firstSource.orderId, secondSource.orderId].sort()); expect(allocations.every(row => row.allocatedAmount == null)).toBe(true);
    expect((await f.request('finance', 'post', payable(original.id, '/register'), { ...originalCommand, dueDate: '2026-12-01' })).status).toBe(409);
    const secondVat = await vat('original-two', '40'), secondCommand = await command(secondVat.id, [selected(purchase, 0, '40')]);
    const grossCandidates = body(await f.request('finance', 'get', payable(secondVat.id, `/sources?amountBasis=gross&search=${enc(purchase.draft.contractNumber)}`)), 'read explicit basis conflict before separate VAT registration');
    expect(grossCandidates.items.find((row: { contractId: string }) => row.contractId === purchase.id)).toMatchObject({
      registeredAmount: '60.0000', remainingAmount: '40.0000', registeredAmountBasis: 'net', selectable: false, unavailableReason: expect.stringMatching(/基准/) });
    const second = body(await f.request('finance', 'post', payable(secondVat.id, '/register'), secondCommand), 'register separate supplier original AP', 201);
    expect(second.invoice.amount).toBe('45.2'); expect(await prisma.inventoryItem.count()).toBe(stockBefore);
    const invoiceRead = body(await f.request('finance', 'get', `/api/v1/finance/${enc(recovered.invoice.id)}`), 'read existing shared financial balance');
    for (const [method, suffix, input] of [
      ['patch', '', { amount: '1' }], ['post', '/cancel', { reason: 'Do not erase external original' }], ['delete', '', {}],
    ] as const) expect((await f.request('finance', method, `/api/v1/finance/${enc(recovered.invoice.id)}${suffix}`,
      { requestKey: randomUUID(), expectedUpdatedAt: String(invoiceRead.updatedAt), ...input })).status).toBe(409);
    const request = body(await f.request('salesOwner', 'post', '/api/v1/payment-requests', { supplierId: f.factory.id, supplierName: f.factory.name, totalAmount: '100', currency: 'CNY',
      paymentCategory: 'normal', requestDate: date, expectedPaymentDate: '2026-11-08', sourceType: 'supplier_payable',
      payableSelections: [{ invoiceId: recovered.invoice.id, requestedAmount: '60.0000', expectedSourceFingerprint: recovered.snapshot.sourceFingerprint },
        { invoiceId: second.invoice.id, requestedAmount: '40.0000', expectedSourceFingerprint: second.snapshot.sourceFingerprint }],
      remark: 'Actual vendor balance payment with two exact original APs; bank execution is separate' }), 'create actual supplier payment request', 201);
    const requestFact = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: request.paymentRequest.id } });
    const approvalFact = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.approvalRequestId } });
    const requestAttachments = requestFact.attachments as { sourceSnapshot: { sourceType: string; sourceFingerprint: string; entries: Array<{ invoiceId: string; requestedAmount: string }> }; sourceDocument: unknown };
    const approvalPayload = approvalFact.payload as { sourceSnapshot: unknown; sourceDocument: unknown };
    expect(requestAttachments.sourceSnapshot).toMatchObject({ sourceType: 'SupplierVatPayablePayment', supplierId: f.factory.id, currency: 'CNY', totalAmount: '100.0000' });
    expect(requestAttachments.sourceSnapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoiceId: recovered.invoice.id, requestedAmount: '60.0000', sourceFingerprint: recovered.snapshot.sourceFingerprint }),
      expect.objectContaining({ invoiceId: second.invoice.id, requestedAmount: '40.0000', sourceFingerprint: second.snapshot.sourceFingerprint }),
    ]));
    expect(approvalPayload.sourceSnapshot).toEqual(requestAttachments.sourceSnapshot);
    expect(approvalPayload.sourceDocument).toEqual({ type: 'supplier_payable', id: requestAttachments.sourceSnapshot.sourceFingerprint });
    const review = body(await f.request('manager', 'get', `/api/v1/approvals/${enc(request.approvalRequestId)}`), 'read actual payment approval').item;
    body(await f.request('manager', 'post', `/api/v1/approvals/${enc(review.id)}/decide`, { status: 'approved', confirmedReviewedContent: true,
      reviewContentVersion: review.reviewContentVersion, decisionNote: 'Approved real payee, amount, currency and stated order purpose' }), 'approve vendor payment');
    const requestPath = `/api/v1/payment-requests/${enc(request.paymentRequest.id)}`;
    let approved: any;
    for (let index = 0; index < 30; index++) { approved = body(await f.request('finance', 'get', requestPath), 'read payment decision').item;
      if (approved.status === 'Approved') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(approved).toMatchObject({ status: 'Approved', actualPayments: { paidAmount: '0.0000' } });
    const account = await createAcceptanceCashAccount(f, { currency: 'CNY', label: 'supplier-actual-bank' });
    body(await f.request('finance', 'post', `/api/v1/finance/cash-accounts/${enc(account.id)}/commands`, { requestKey: randomUUID(), expectedRevision: account.revision,
      action: 'opening', amount: '500', currency: 'CNY', occurredDate: date, bankReference: `${f.prefix}-opening`, evidenceNote: 'Actual isolated opening bank balance' }), 'record actual opening', 201);
    const paid = body(await f.request('finance', 'post', `${requestPath}/record-payment`, { ...await acceptanceCashInput(f, account.id), requestKey: randomUUID(), expectedRequestUpdatedAt: approved.updatedAt,
      amount: '100', currency: 'CNY', paymentDate: date, paymentMethod: 'TT', evidenceNote: 'Actual isolated bank deduction; not inferred from supplier approval' }), 'record actual bank payment', 201);
    for (const [invoiceId, appliedAmount] of [[recovered.invoice.id, '60'], [second.invoice.id, '40']])
      body(await f.request('finance', 'post', '/api/v1/finance/allocations', { invoiceId, voucherId: paid.voucher.id, appliedAmount, appliedDate: date }), 'apply one payment to an actual AP portion', 201);
    const firstAfter = body(await f.request('finance', 'get', payable(original.id)), 'read original AP after partial allocation');
    const secondAfter = body(await f.request('finance', 'get', payable(secondVat.id)), 'read other AP after same payment');
    expect(firstAfter.invoice.status).toBe('PartiallyPaid'); expect(secondAfter.invoice.status).toBe('PartiallyPaid');
    expect(firstAfter.receipt).toEqual(recovered.receipt); expect(firstAfter.snapshot).toEqual(recovered.snapshot);
    expect(body(await f.request('finance', 'get', `/api/v1/finance/cash-accounts/${enc(account.id)}`), 'read actual bank balance').balance).toBe('400.0000');
    const replay = body(await f.request('finance', 'post', payable(original.id, '/register'), originalCommand), 'original receipt remains exact after payment');
    expect(replay.invoice.status).toBe('Issued'); expect(replay.receipt).toEqual(recovered.receipt);
    expect(await prisma.invoice.count({ where: { sourceType: 'SupplierVatPayable', sourceId: original.id } })).toBe(1);
  }, 120_000);

  it('serializes cumulative stable-line capacity for distinct original invoices and preserves the loser as unregistered', async () => {
    const actual = await source('capacity'), approved = await contract('purchase', [actual.lineId], 'capacity-contract');
    const one = await vat('capacity-one', '60'), two = await vat('capacity-two', '60');
    const first = await command(one.id, [selected(approved, 0, '60')]), second = await command(two.id, [selected(approved, 0, '60')]);
    const results = await Promise.all([f.request('finance', 'post', payable(one.id, '/register'), first), f.request('finance', 'post', payable(two.id, '/register'), second)]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    const winner = results.find(row => row.status === 201)!.body;
    const loser = winner.receipt.vatInvoiceId === one.id ? two : one;
    expect((await prisma.vatInvoice.findUniqueOrThrow({ where: { id: loser.id } })).invoiceId).toBeNull();
    expect(await prisma.invoice.count({ where: { sourceType: 'SupplierVatPayable', sourceId: { in: [one.id, two.id] } } })).toBe(1);
    const contractRead = body(await f.request('salesOwner', 'get', `/api/v1/procurement/contracts/purchase/${enc(approved.id)}`), 'read unchanged business commitment').item;
    expect(contractRead.approvedRevision.id).toBe(approved.revisionId);
  }, 120_000);

  it('keeps old AP approval snapshot readable after amendment, rejects stale new consumption, and blocks withdrawn finance on original retry', async () => {
    const actual = await source('amend'), approved = await contract('purchase', [actual.lineId], 'amend-contract');
    const original = await vat('before-amend', '30'), originalCommand = await command(original.id, [selected(approved, 0, '30')]);
    const first = body(await f.request('finance', 'post', payable(original.id, '/register'), originalCommand), 'register before real amendment', 201);
    const draft = body(await f.request('salesOwner', 'get', `/api/v1/procurement/contracts/purchase/${enc(approved.id)}`), 'read exact approved draft').item;
    const changed = { ...draft.draft, requestKey: `${f.prefix}-real-price-amend`, expectedRevision: draft.latestRevision, basedOnRevisionId: approved.revisionId,
      reason: 'Actual vendor unit price changed; retain original AP source', lines: draft.draft.lines.map((line: any) => ({ ...line, unitPrice: '2' })) };
    const update = body(await f.request('salesOwner', 'post', `/api/v1/procurement/contracts/purchase/${enc(approved.id)}/amendments`, changed), 'save actual contract amendment');
    const submitted = body(await f.request('salesOwner', 'post', `/api/v1/procurement/contracts/purchase/${enc(approved.id)}/submit`, {
      requestKey: `${f.prefix}-amend-submit`, expectedRevision: update.item.latestRevision }), 'submit real amended supplier promise');
    const review = body(await f.request('manager', 'get', `/api/v1/approvals/${enc(submitted.commandAck.approvalId)}`), 'read amended exact approval').item;
    body(await f.request('manager', 'post', `/api/v1/approvals/${enc(review.id)}/decide`, { status: 'approved', confirmedReviewedContent: true,
      reviewContentVersion: review.reviewContentVersion, requestKey: `${f.prefix}-amend-approved`, decisionNote: 'Reviewed actual revised price; original AP stays historical' }), 'approve new supplier revision');
    const originalRead = body(await f.request('finance', 'get', payable(original.id)), 'read prior exact AP after approved amendment');
    expect(originalRead.snapshot).toEqual(first.snapshot); expect(originalRead.receipt).toEqual(first.receipt);
    const later = await vat('stale-consumption', '20');
    expect((await f.request('finance', 'post', payable(later.id, '/preview'), { amountBasis: 'net', sources: [selected(approved, 0, '20')] })).status).toBe(409);
    const currentCandidates = body(await f.request('finance', 'get', payable(later.id, `/sources?amountBasis=net&search=${enc(approved.draft.contractNumber)}`)), 'read current approved candidate after actual amendment');
    expect(currentCandidates.items.filter((row: { contractId: string }) => row.contractId === approved.id)).toEqual([
      expect.objectContaining({ contractId: approved.id, commitmentRevisionId: submitted.commandAck.revisionId, lineId: approved.lines[0].id,
        approvedLineAmount: '200.0000', registeredAmount: '30.0000', remainingAmount: '170.0000', registeredAmountBasis: 'net', selectable: true }),
    ]);
    expect(currentCandidates.items.every((row: { commitmentRevisionId: string }) => row.commitmentRevisionId !== approved.revisionId)).toBe(true);
    const grant = await prisma.userRole.findFirstOrThrow({ where: { userId: f.actors.finance.id, roleId: f.actors.finance.roleId } });
    await prisma.userRole.delete({ where: { id: grant.id } });
    expect((await f.request('finance', 'post', payable(original.id, '/register'), originalCommand)).status).toBe(403);
    await prisma.userRole.create({ data: grant });
  }, 120_000);

  it('uses actual custom finance scopes without widening L2 and rejects a mixed hidden source in a readable original VAT', async () => {
    const requester = f.actors.actualRequester;
    // This business actor really follows a separate customer. Do not widen the
    // original customer's ownership just to make the cross-customer test pass.
    const ownCustomer = await prisma.relation.create({ data: { id: `${f.prefix}-limited-customer`, code: `${f.prefix}-limited-customer`,
      name: `${f.prefix} actual requester customer`, category: 'Customer', type: 'company', isOrganization: true,
      contactInfo: '{}', tags: ['ISOLATED_ACCEPTANCE'], lastInteraction: BigInt(Date.now()), ownerId: requester.id,
      departmentId: (await prisma.userAccount.findUniqueOrThrow({ where: { id: requester.id } })).primaryDeptId,
      salesRepIds: [requester.id, f.actors.manager.id], factoryAddresses: [] } });
    await prisma.relation.update({ where: { id: f.factory.id }, data: { salesRepIds: [f.actors.salesOwner.id, requester.id] } });
    const ownFixture: GlobalBusinessHttpFixture = { ...f, customer: ownCustomer, actors: { ...f.actors, salesOwner: requester },
      request(actor, method, url, input) { return f.request(actor === 'salesOwner' ? 'actualRequester' : actor, method, url, input); } };
    const ownArchive = await createQcPassedFabricArchive(ownFixture, { key: 'limited-customer-native-source' });
    await recordExactDevelopmentConfirmation(ownFixture, ownArchive);
    const own = await source('limited-own', 'actualRequester', ownCustomer, ownArchive), other = await source('limited-other');
    const ownContract = await contract('purchase', [own.lineId], 'limited-own-contract', 'actualRequester');
    // The actual fabric group leader can follow both original sources. An
    // owner account outside that group must not manufacture the vendor contract.
    const mixedContract = await contract('purchase', [own.lineId, other.lineId], 'limited-mixed-contract', 'manager');
    const original = await vat('limited-original', '10'), mixedVat = await vat('limited-mixed', '2');
    const ownCommand = await command(original.id, [selected(ownContract, 0, '10')]);
    const mixedCommand = await command(mixedVat.id, [selected(mixedContract, 0, '1'), selected(mixedContract, 1, '1')]);
    // Current stored role and source follow-up are master fixture inputs.
    const roleId = `${f.prefix}-limited-finance`;
    await prisma.role.create({ data: { id: roleId, name: 'Explicit limited financial recorder' } });
    for (const scope of ['invoices:read', 'vat:read']) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { scope } });
      await prisma.rolePermission.create({ data: { id: `${roleId}-${permission.id}`, roleId, permissionId: permission.id } });
    }
    await prisma.userRole.deleteMany({ where: { userId: f.actors.actualRequester.id } });
    await prisma.userRole.create({ data: { id: `${roleId}-grant`, userId: f.actors.actualRequester.id, roleId } });
    // This recorder follows only their original customer. Remove the former
    // business-team sharing explicitly; merely replacing a role does not revoke
    // its independently granted customer visibility.
    await prisma.teamMember.updateMany({ where: { userId: requester.id, leftAt: null }, data: { leftAt: new Date() } });
    const candidates = body(await f.request('actualRequester', 'get', payable(original.id, '/sources?amountBasis=net&limit=1')), 'read own candidates with exactly two actual finance read grants and no procurement grants');
    expect(candidates.items).toEqual([expect.objectContaining({ contractId: ownContract.id, commitmentRevisionId: ownContract.revisionId,
      lineId: ownContract.lines[0].id, orderId: own.orderId, orderLineId: own.lineId, selectable: true })]);
    expect(candidates).toMatchObject({ hasMore: false, nextCursor: null });
    expect(Object.keys(candidates).sort()).toEqual(['hasMore', 'items', 'nextCursor', 'ok']);
    expect(candidates.items.some((row: { contractId: string }) => row.contractId === mixedContract.id)).toBe(false);
    const hiddenSearch = body(await f.request('actualRequester', 'get', payable(original.id, `/sources?amountBasis=net&search=${enc(mixedContract.draft.contractNumber)}`)), 'exclude complete mixed contract even when one row belongs to current recorder');
    expect(hiddenSearch).toMatchObject({ items: [], nextCursor: null, hasMore: false });
    const ceiling = { ...requester, token: createAuthService().signToken({ userId: requester.id, roles: [], roleIds: [], departmentIds: [], permissions: [], permissionCeiling: ['vat:read'] }) };
    expect((await f.request(ceiling, 'get', payable(original.id, '/sources?amountBasis=net'))).status).toBe(403);
    expect((await f.request('actualRequester', 'get', payable(original.id, '/sources?amountBasis=net&limit=101'))).status).toBe(400);
    // Add the independent write capability only after proving source discovery
    // with the two actual read grants. The previously issued login stays stale.
    for (const scope of ['invoices:write', 'orders:read', 'finance:read']) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { scope } });
      await prisma.rolePermission.create({ data: { id: `${roleId}-${permission.id}`, roleId, permissionId: permission.id } });
    }
    const denied = await f.request('actualRequester', 'post', payable(mixedVat.id, '/register'), mixedCommand);
    expect(denied.status, stringify(denied.body)).toBe(404);
    expect(await prisma.invoice.count({ where: { sourceType: 'SupplierVatPayable', sourceId: mixedVat.id } })).toBe(0);
    const ownRegistered = body(await f.request('actualRequester', 'post', payable(original.id, '/register'), ownCommand), 'record explicitly authorized own source', 201);
    expect(ownRegistered.receipt.actorId).toBe(f.actors.actualRequester.id);
    body(await f.request('actualRequester', 'get', payable(original.id)), 'read current own original AP');
    const roleGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: f.actors.actualRequester.id, roleId } });
    await prisma.userRole.delete({ where: { id: roleGrant.id } });
    expect((await f.request('actualRequester', 'post', payable(original.id, '/register'), ownCommand)).status).toBe(403);
    expect((await f.request('actualRequester', 'get', payable(mixedVat.id, '/sources?amountBasis=net'))).status).toBe(403);
  }, 120_000);
});
