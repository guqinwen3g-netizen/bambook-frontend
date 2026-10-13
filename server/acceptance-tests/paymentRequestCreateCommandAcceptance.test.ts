/** Dedicated isolated PG/HTTP batch. All business conclusions below are earned
 * by real producers; fixture writes configure only actors and master authority. */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createQcPassedFabricArchive, recordExactDevelopmentConfirmation,
  type GlobalBusinessHttpFixture } from './globalBusinessFixtures';
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
import { ciHash } from '../src/development/developmentCiSource';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, archive: Awaited<ReturnType<typeof createQcPassedFabricArchive>>, loseAck: string | null = null;
let hooks: Function[] = [];
const date = '2026-10-08', enc = encodeURIComponent, requests = '/api/v1/payment-requests';
function body(response: { status: number; body: any }, label: string, status = 200): any {
  expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(status); return response.body;
}
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_target, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      const result: any = await (prisma.$transaction as (...args: unknown[]) => Promise<unknown>).apply(prisma, args);
      if (loseAck && result?.data?.financeCommand?.kind === 'payment_request.create' && result.data.financeCommand.requestKey === loseAck) {
        loseAck = null; throw Error('Committed AP application acknowledgement lost');
      }
      return result;
    };
    const value = Reflect.get(prisma, key); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `ap-command-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_k: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma: client, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrdersRouter(options)); app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options)); app.use('/api/v1/approvals', createApprovalRouter({ prisma: client, requireAuth: true }));
    app.use('/api/v1/procurement', createProcurementRouter(options)); app.use('/api/v1/finance', createFinanceRouter(options));
    app.use(requests, createPaymentRequestRouter({ prisma: client, requireAuth: true }));
  } });
  await prisma.factoryProfile.create({ data: { id: `${f.factory.id}-profile`, relationId: f.factory.id, specialties: ['fabric'],
    createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  archive = await createQcPassedFabricArchive(f, { key: 'actual-ap-command-source' }); await recordExactDevelopmentConfirmation(f, archive);
  await createOrderMainApprovalService(prisma).replaceAuthorityConfig({ businessLine: 'fabric', userIds: [f.actors.manager.id], actorId: f.actors.superAdmin.id });
  const user = await prisma.userAccount.findUniqueOrThrow({ where: { id: f.actors.salesOwner.id }, select: { primaryDeptId: true } });
  await prisma.department.update({ where: { id: user.primaryDeptId! }, data: { headId: f.actors.manager.id } });
  const url = '/api/v1/procurement/contracts/approval-authority/purchase/fabric';
  const current = body(await f.request('admin', 'get', url), 'read actual supplier authority').item;
  body(await f.request('admin', 'put', url, { requestKey: `${f.prefix}-supplier-authority`, expectedConfigVersion: current.version,
    userIds: [f.actors.manager.id], reason: 'Explicit isolated company policy; no invented paid or approved fact' }), 'configure supplier authority');
  const existing = new Set(approvalEventBus.listeners('resolved'));
  registerPaymentRequestApprovalHook({ prisma: client }); hooks = approvalEventBus.listeners('resolved').filter(listener => !existing.has(listener));
}, 120_000);
afterAll(async () => { for (const hook of hooks) approvalEventBus.off('resolved', hook as (...args: any[]) => void); await f?.close(); await prisma.$disconnect(); });

async function actualPayables(label: string) {
  const created = body(await f.request('salesOwner', 'post', '/api/v2/orders', { poNumber: null, customer: f.customer.name, customerRelationId: f.customer.id,
    product: `Accurate AP ${label}`, type: 'fabric', businessLine: 'fabric', quantity: '1000', unit: 'M', status: 'Pending', dueDate: '2099-01-01', quoteAmount: '2500',
    ownerId: f.actors.salesOwner.id, salesPerson: f.actors.salesOwner.name, sourceCaseId: archive.caseId, millRelationId: f.factory.id, millName: f.factory.name,
    currency: 'CNY', paymentInstrument: 'T/T', paymentTerms: 'TT 30 days', deliveryTerms: 'FOB', finalContractNumber: `${f.prefix}-${label}-buyer`,
    billToRelationId: f.customer.id, billToName: f.customer.name, billToAddress: 'Isolated billing', consigneeRelationId: f.customer.id,
    consigneeName: f.customer.name, shipToName: f.customer.name, shipToAddress1: 'Isolated destination', shipToCountry: 'GB' }), 'create native source').order;
  const line = body(await f.request('salesOwner', 'post', '/api/v1/order-lines', { orderId: created.id, itemNo: label, description: 'Exact AP source',
    materialCode: `${f.prefix}-${label}`, quantity: '1000', unit: 'M', unitPrice: '2.5' }), 'create actual contract line').line;
  body(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(line.id)}/version`, { confirmedSourceType: 'Asset', confirmedSourceId: archive.assetId }), 'bind actual confirmed archive');
  const submitted = body(await f.request('salesOwner', 'post', `/api/v2/orders/${enc(created.id)}/submit-main-approval`, {}), 'submit main approval', 201).item;
  const review = body(await f.request('manager', 'get', `/api/v1/approvals/${enc(submitted.id)}`), 'review exact main proof').item;
  body(await f.request('manager', 'post', `/api/v1/approvals/${enc(review.id)}/decide`, { status: 'approved', confirmedReviewedContent: true,
    reviewContentVersion: review.reviewContentVersion, decisionNote: 'Actual source and commercial terms checked' }), 'approve actual order');
  const contractUrl = '/api/v1/procurement/contracts/purchase';
  const purchase = body(await f.request('salesOwner', 'post', contractUrl, { requestKey: `${f.prefix}-${label}-purchase`, contractNumber: `${f.prefix}-${label}-supplier`,
    supplierRelationId: f.factory.id, currency: 'CNY', paymentTerms: 'TT 30 days', orderDate: date,
    mainDeliveryLocation: { kind: 'external', name: 'Actual receiving organization', address: 'Declared receiving address' },
    lines: [{ orderLineId: line.id, kind: 'Material', category: 'Fabric', description: 'Actual supplier fabric', quantity: '100', unit: 'M', unitPrice: '3', requestedDeliveryDate: '2099-01-01' }] }), 'create supplier contract', 201);
  const contractId = purchase.commandAck.contractId;
  const submittedPurchase = body(await f.request('salesOwner', 'post', `${contractUrl}/${enc(contractId)}/submit`, {
    requestKey: `${f.prefix}-${label}-purchase-submit`, expectedRevision: 1 }), 'submit supplier contract');
  const purchaseReview = body(await f.request('manager', 'get', `/api/v1/approvals/${enc(submittedPurchase.commandAck.approvalId)}`), 'read supplier original proof').item;
  body(await f.request('manager', 'post', `/api/v1/approvals/${enc(purchaseReview.id)}/decide`, { status: 'approved', confirmedReviewedContent: true,
    reviewContentVersion: purchaseReview.reviewContentVersion, requestKey: `${f.prefix}-${label}-purchase-decide`, decisionNote: 'Actual vendor and price reviewed' }), 'approve supplier source');
  const result: any[] = [];
  for (const [index, net] of ['100', '40'].entries()) {
    const tax = new Prisma.Decimal(net).mul('0.13');
    const original = body(await f.request('finance', 'post', '/api/v1/finance/vat-invoices', { requestKey: randomUUID(), vatNumber: `${f.prefix}-${label}-VAT-${index}`,
      direction: 'Input', invoiceType: 'Special', sellerName: f.factory.name, buyerName: 'Isolated company', issueDate: date,
      netAmount: net, taxRate: '13', taxAmount: tax.toFixed(4), totalAmount: new Prisma.Decimal(net).plus(tax).toFixed(4), currency: 'CNY', relationId: f.factory.id }), 'register actual supplier original', 201);
    const url = `/api/v1/finance/supplier-vat-payables/${enc(original.id)}`;
    const selection = { amountBasis: 'net', sources: [{ contractKind: 'purchase', contractId,
      commitmentRevisionId: submittedPurchase.commandAck.revisionId, lineId: purchase.item.draft.lines[0].id, contractAmount: net }] };
    const preview = body(await f.request('finance', 'post', `${url}/preview`, selection), 'read actual source capacity');
    result.push(body(await f.request('finance', 'post', `${url}/register`, { ...selection, requestKey: randomUUID(),
      expectedVatUpdatedAt: preview.vatUpdatedAt, expectedSourceFingerprint: preview.sourceFingerprint }), 'register exact original AP', 201));
  }
  return result;
}
function application(ap: any[], requestKey = randomUUID()) {
  return { requestKey, supplierId: f.factory.id, supplierName: f.factory.name, totalAmount: '100', currency: 'CNY',
    paymentCategory: 'normal', requestDate: date, expectedPaymentDate: '2026-11-08', sourceType: 'supplier_payable',
    payableSelections: ap.map((item, index) => ({ invoiceId: item.invoice.id, requestedAmount: index ? '40.0000' : '60.0000', expectedSourceFingerprint: item.snapshot.sourceFingerprint })),
    remark: 'Actual original AP selection; approval and observed bank payment are separate' };
}
const commandAuditId = (actorId: string, requestKey: string) => `finance_command_${ciHash({ actorId, kind: 'payment_request.create', requestKey })}`;

describe('native exact AP application original-key recovery and candidates', () => {
  it('recovers a committed unknown ACK, retains its original creation receipt after actual payment and two-AP allocation, and refuses changed content', async () => {
    const ap = await actualPayables('original'), command = application(ap), url = `${requests}/payable-candidates?supplierId=${enc(f.factory.id)}&currency=CNY`;
    const candidates = body(await f.request('salesOwner', 'get', `${url}&search=${enc(`${f.prefix}-original-VAT-0`)}`), 'actual selectable source labels');
    expect(candidates.items).toHaveLength(1); expect(candidates.items[0]).toMatchObject({ invoiceId: ap[0].invoice.id, availableAmount: '113.0000' });
    expect('total' in candidates).toBe(false);
    loseAck = command.requestKey;
    expect((await f.request('salesOwner', 'post', requests, command)).status).toBe(500);
    const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: commandAuditId(f.actors.salesOwner.id, command.requestKey) } });
    const original = (audit.detail as any).receipt;
    const recovered = body(await f.request('salesOwner', 'post', requests, command), 'recover original committed application', 201);
    expect(recovered).toMatchObject({ replayed: true, paymentRequest: { status: 'Pending' }, financeCommand: { kind: 'payment_request.create',
      actorId: f.actors.salesOwner.id, commandHash: ciHash({ kind: 'payment_request.create', input: command }), targetId: recovered.paymentRequest.id } });
    expect(recovered.paymentRequest).toEqual(original.paymentRequest); expect(recovered.approvalRequestId).toBe(original.approvalRequestId);
    const reserved = body(await f.request('salesOwner', 'get', url), 'read exact outstanding reservation');
    expect(reserved.items.find((row: any) => row.invoiceId === ap[0].invoice.id)).toMatchObject({ reservedAmount: '60.0000', availableAmount: '53.0000' });
    const changed = { ...command, payableSelections: command.payableSelections.map((item, index) => ({ ...item, requestedAmount: index ? '41.0000' : '59.0000' })) };
    expect((await f.request('salesOwner', 'post', requests, changed)).status).toBe(409);
    const review = body(await f.request('manager', 'get', `/api/v1/approvals/${enc(recovered.approvalRequestId)}`), 'read exact payment approval').item;
    body(await f.request('manager', 'post', `/api/v1/approvals/${enc(review.id)}/decide`, { status: 'approved', confirmedReviewedContent: true,
      reviewContentVersion: review.reviewContentVersion, decisionNote: 'Actual two originals, payee and amount checked' }), 'independent payment approval');
    const path = `${requests}/${enc(recovered.paymentRequest.id)}`;
    let approved: any;
    for (let index = 0; index < 30; index++) { approved = body(await f.request('finance', 'get', path), 'read current payment decision').item;
      if (approved.status === 'Approved') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(approved.status).toBe('Approved'); expect(approved.actualPayments.paidAmount).toBe('0.0000');
    const account = await createAcceptanceCashAccount(f, { currency: 'CNY', label: 'ap-original-command' });
    body(await f.request('finance', 'post', `/api/v1/finance/cash-accounts/${enc(account.id)}/commands`, { requestKey: randomUUID(), expectedRevision: account.revision,
      action: 'opening', amount: '500', currency: 'CNY', occurredDate: date, evidenceNote: 'Actual verified opening before all movements' }), 'record verified opening', 201);
    const paid = body(await f.request('finance', 'post', `${path}/record-payment`, { ...await acceptanceCashInput(f, account.id), requestKey: randomUUID(),
      expectedRequestUpdatedAt: approved.updatedAt, amount: '100', currency: 'CNY', paymentDate: date, paymentMethod: 'TT', evidenceNote: 'Actual supplier bank debit' }), 'record observed bank payment', 201);
    for (const [index, item] of ap.entries()) body(await f.request('finance', 'post', '/api/v1/finance/allocations', {
      invoiceId: item.invoice.id, voucherId: paid.voucher.id, appliedAmount: index ? '40' : '60', appliedDate: date }), 'allocate actual payment to exact AP', 201);
    expect(body(await f.request('finance', 'get', path), 'read actual fully paid request').item.status).toBe('Paid');
    const late = body(await f.request('salesOwner', 'post', requests, command), 'recover original after consumed capacity', 201);
    expect(late.paymentRequest).toEqual(original.paymentRequest); expect(late.financeCommand).toEqual(recovered.financeCommand);
    expect(await prisma.approvalRequest.count({ where: { targetType: 'PaymentRequest', targetId: recovered.paymentRequest.id } })).toBe(1);
    expect(await prisma.paymentRequest.count({ where: { approvalRequestId: recovered.approvalRequestId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'finance_command_committed', transactionId: command.requestKey, actorId: f.actors.salesOwner.id } })).toBe(1);
  }, 120_000);

  it('serializes one original application and notification, and rechecks old-token ceiling, live disabled status, grants and source L2', async () => {
    const ap = await actualPayables('parallel'), command = application(ap);
    const responses = await Promise.all([f.request('salesOwner', 'post', requests, command), f.request('salesOwner', 'post', requests, command), f.request('salesOwner', 'post', requests, command)]);
    const received = responses.map(response => body(response, 'same-key parallel original command', 201));
    expect(new Set(received.map(item => item.paymentRequest.id)).size).toBe(1);
    expect(received.filter(item => item.replayed === true)).toHaveLength(2);
    const requestId = received[0].paymentRequest.id;
    expect(await prisma.approvalRequest.count({ where: { targetType: 'PaymentRequest', targetId: requestId } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'payment_request_submitted', metadata: { path: ['paymentRequestId'], equals: requestId } } })).toBe(1);
    const limited = { ...f.actors.salesOwner, token: createAuthService().signToken({ userId: f.actors.salesOwner.id, roles: ['sales'], roleIds: [], departmentIds: [],
      permissions: [], permissionCeiling: ['invoices:read'] }) };
    expect((await f.request(limited, 'post', requests, command)).status).toBe(403);
    expect(body(await f.request('salesOutsider', 'get', `${requests}/payable-candidates?supplierId=${enc(f.factory.id)}&currency=CNY`), 'other actual sales source L2').items).toEqual([]);
    await prisma.userAccount.update({ where: { id: f.actors.salesOwner.id }, data: { status: 'disabled' } });
    expect((await f.request('salesOwner', 'post', requests, command)).status).toBe(401);
    await prisma.userAccount.update({ where: { id: f.actors.salesOwner.id }, data: { status: 'active' } });
    await prisma.userRole.deleteMany({ where: { userId: f.actors.salesOwner.id } });
    expect((await f.request('salesOwner', 'post', requests, command)).status).toBe(403);
    expect(await prisma.paymentRequest.count({ where: { approvalRequestId: received[0].approvalRequestId } })).toBe(1);
  }, 120_000);
});
