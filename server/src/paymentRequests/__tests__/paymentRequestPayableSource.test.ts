import { describe, expect, it, vi } from 'vitest';
import { createPaymentRequestService } from '../paymentRequestService';
import { Prisma } from '@prisma/client';
import { assertApprovalReviewReadyForDecision } from '../../approvals/approvalReviewDetailService';
import { recordSupplierActualPayment } from '../supplierPaymentExecutionService';
import { assertPaymentRequestPayableRead, hasPaymentRequestPayableBasis } from '../paymentRequestPayableSource';
import { assertAllocationFacts } from '../../finance/allocationService';

const state = vi.hoisted(() => ({ originals: new Map<string, any>(), visible: true, vouchers: [] as any[], receipts: new Map<string, any>() }));

vi.mock('../../sequence/sequenceService', () => ({ createSequenceService: () => ({ nextNumber: async () => 'PAYR-20261008-001' }) }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: async () => 'AUD-PAYR' }));
vi.mock('../../notifications/notificationService', () => ({ createNotificationService: () => ({ sendToUser: async () => undefined }) }));
vi.mock('../../finance/financeSourceAccess', () => ({ createFinanceSourceAccess: async (_tx: unknown, actor: any) => ({
  actor, all: true, invoice: async () => state.visible, customer: async () => true, order: async () => true,
  source: async () => true, voucher: async () => true, finish: async () => undefined,
}) }));
vi.mock('../../finance/supplierVatPayableSource', () => ({ SUPPLIER_VAT_PAYABLE_SOURCE: 'SupplierVatPayable',
  readSupplierVatPayableSource: async (_tx: unknown, id: string) => state.originals.get(id) ?? Promise.reject(Error('Original AP unavailable')),
}));
vi.mock('../../finance/financeCommandReceipt', () => ({ beginFinanceCommand: async (_tx: unknown, _actor: unknown, _kind: unknown, input: any) =>
  state.receipts.has(input.requestKey) ? { replayed: true, receipt: state.receipts.get(input.requestKey) }
    : { replayed: false, commit: async (receipt: any) => { state.receipts.set(input.requestKey, receipt); return receipt; } } }));
vi.mock('../../finance/paymentVoucherMutationService', () => ({ VALID_VOUCHER_CATEGORIES: ['normal', 'advance', 'deposit', 'sample_express', 'customer_reimburse', 'business_cost'],
  createPaymentVoucher: async ({ input }: any) => {
    const voucher = { ...input, id: `PAY-${state.vouchers.length + 1}`, voucherNumber: `PAY-${state.vouchers.length + 1}`,
      cashEntryId: `ENTRY-${state.vouchers.length + 1}`, amount: String(input.amount), attachments: { ...input.attachments, paymentRequestId: input.paymentRequestId } };
    state.vouchers.push(voucher); return { ok: true, data: { voucher } };
  } }));
vi.mock('../../finance/companyCashAccountService', () => ({ assertVoucherCashUse: async () => undefined }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: async () => undefined }));

const actor = { userId: 'finance-operator', roles: ['finance'], permissions: ['finance:payment_request:create', 'invoices:read'], departmentIds: ['finance'] };
function fixture() {
  state.visible = true; state.originals.clear(); state.vouchers = []; state.receipts.clear();
  const invoices = ['AP-1', 'AP-2'].map((id, index) => ({ id, sourceType: 'SupplierVatPayable', sourceId: `VAT-${index + 1}`,
    invoiceNumber: `SVAT-VAT-${index + 1}`,
    type: 'Payable', amount: new Prisma.Decimal(index ? '80.0000' : '40.0000'), currency: 'CNY',
    customerRelationId: 'SUP-1', status: 'Issued', deletedAt: null }));
  for (const [index, invoice] of invoices.entries()) state.originals.set(invoice.sourceId, { invoice,
    snapshot: { sourceFingerprint: String(index + 1).repeat(64), orderIds: ['ORDER-1'], vatOriginal: { vatCode: null, vatNumber: `SUPPLIER-VAT-${index + 1}`, sellerName: 'Supplier One' },
      sources: [{ contractNumber: `SUPPLIER-CONTRACT-${index + 1}` }] }, vatInvoice: { id: invoice.sourceId, status: 'Received' } });
  const approvalCreateService: any = { createBusinessApproval: vi.fn(async () => ({ id: 'APR-1', reviewerId: 'finance-approver' })) };
  let created: any;
  const prisma: any = {
    $queryRaw: vi.fn(async () => []),
    paymentRequest: { create: vi.fn(async ({ data }: any) => { created = { ...data, updatedAt: new Date('2026-10-08T00:00:00Z') }; return created; }),
      findUnique: vi.fn(async () => created),
      updateMany: vi.fn(async ({ data }: any) => { created = { ...created, ...data }; return { count: 1 }; }),
      findMany: vi.fn(async () => []) },
    invoice: { findFirst: vi.fn(async ({ where }: any) => invoices.find(row => row.id === where.id) ?? null),
      findUnique: vi.fn(async ({ where }: any) => invoices.find(row => row.id === where.id) ?? null) },
    invoiceAllocation: { findMany: vi.fn(async () => []) }, creditNoteAllocation: { findMany: vi.fn(async () => []) },
    paymentVoucher: { findMany: vi.fn(async () => state.vouchers), findUnique: vi.fn(async ({ where }: any) => state.vouchers.find(row => row.id === where.id)) },
    relation: { findFirst: vi.fn(async () => ({ id: 'SUP-1' })) },
    creditNoteRefund: { findUnique: vi.fn(async () => null) },
  };
  prisma.$transaction = async (run: (tx: any) => Promise<unknown>) => run(prisma);
  const service = createPaymentRequestService({ prisma, approvalCreateService });
  return { prisma, approvalCreateService, service, invoices, get created() { return created; } };
}

const selected = [{ invoiceId: 'AP-2', requestedAmount: '80', expectedSourceFingerprint: '2'.repeat(64) },
  { invoiceId: 'AP-1', requestedAmount: '40', expectedSourceFingerprint: '1'.repeat(64) }];
async function submitted(selections = selected, totalAmount = '120.0000') {
  const f = fixture();
  const result = await f.service.createPaymentRequest({ supplierId: 'SUP-1', supplierName: 'Supplier One', totalAmount,
    currency: 'CNY', paymentCategory: 'normal', requestDate: '2026-10-08', sourceType: 'supplier_payable',
    applicantId: actor.userId, actor, payableSelections: selections } as any);
  expect(result.ok).toBe(true);
  const approval = { id: 'APR-1', actionType: 'finance:payment_request', targetType: 'PaymentRequest', targetId: f.created.id,
    requesterId: actor.userId, reviewerId: 'finance-approver', status: 'pending', payload: f.approvalCreateService.createBusinessApproval.mock.calls[0][0].payload };
  return { ...f, approval };
}
const actualInput = { requestKey: 'a4ea3d19-9b53-4fc1-8b9e-669c088ec217', expectedRequestUpdatedAt: '2026-10-08T00:00:00.000Z',
  amount: '60.0000', currency: 'CNY', paymentDate: '2026-10-08', paymentMethod: 'TT', bankReference: 'PURE-ACTUAL-BANK',
  companyAccountId: 'CASH-1', expectedAccountRevision: 1, actualAccountAmount: '60.0000', bankFee: '0', feeBearer: 'OUR' };

describe('accurate supplier AP payment requests', () => {
  it('does not identify a legitimate quotation amendment snapshot as a supplier AP basis', () => {
    expect(hasPaymentRequestPayableBasis(null, { sourceSnapshot: { sourceType: 'QuotationAmendment', quotationId: 'Q-1' } })).toBe(false);
    expect(hasPaymentRequestPayableBasis(null, { sourceDocument: { type: 'supplier_payable' } })).toBe(true);
    expect(hasPaymentRequestPayableBasis({ attachments: { sourceSnapshot: { sourceType: 'damaged-original' } } })).toBe(true);
  });
  it('the supplier payable path cannot submit without selecting its real AP originals', async () => {
    const { service, prisma, approvalCreateService } = fixture();
    const result = await service.createPaymentRequest({ supplierId: 'SUP-1', supplierName: 'Supplier One',
      totalAmount: '120.0000', currency: 'CNY', paymentCategory: 'normal', requestDate: '2026-10-08',
      sourceType: 'supplier_payable', applicantId: actor.userId, actor } as any);
    expect(result).toMatchObject({ ok: false, error: { code: 'PAYMENT_REQUEST_AP_REQUIRED', statusCode: 409 } });
    expect(prisma.paymentRequest.create).not.toHaveBeenCalled();
    expect(approvalCreateService.createBusinessApproval).not.toHaveBeenCalled();
  });

  it('freezes both exact original APs and their requested amounts into the approval, rather than treating them as attachments', async () => {
    const { service, prisma, approvalCreateService } = fixture();
    const result = await service.createPaymentRequest({ supplierId: 'SUP-1', supplierName: 'Supplier One',
      totalAmount: '120.0000', currency: 'CNY', paymentCategory: 'normal', requestDate: '2026-10-08',
      sourceType: 'supplier_payable', applicantId: actor.userId, actor,
      payableSelections: [{ invoiceId: 'AP-2', requestedAmount: '80', expectedSourceFingerprint: '2'.repeat(64) },
        { invoiceId: 'AP-1', requestedAmount: '40', expectedSourceFingerprint: '1'.repeat(64) }] } as any);
    expect(result.ok).toBe(true);
    const snapshot = prisma.paymentRequest.create.mock.calls[0][0].data.attachments.sourceSnapshot;
    expect(snapshot).toMatchObject({ schemaVersion: 1, sourceType: 'SupplierVatPayablePayment', supplierId: 'SUP-1', currency: 'CNY',
      totalAmount: '120.0000', entries: [{ invoiceId: 'AP-1', vatInvoiceId: 'VAT-1', invoiceAmount: '40.0000', requestedAmount: '40.0000', sourceFingerprint: '1'.repeat(64) },
        { invoiceId: 'AP-2', vatInvoiceId: 'VAT-2', invoiceAmount: '80.0000', requestedAmount: '80.0000', sourceFingerprint: '2'.repeat(64) }] });
    expect(snapshot.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.entries[0].originalDocument).toMatchObject({ invoiceNumber: 'SVAT-VAT-1', vatNumber: 'SUPPLIER-VAT-1', supplierName: 'Supplier One', contractNumbers: ['SUPPLIER-CONTRACT-1'] });
    expect(approvalCreateService.createBusinessApproval.mock.calls[0][0].payload.sourceSnapshot).toEqual(snapshot);
  });

  it('rechecks the exact original AP source before approval rather than approving a stale frozen attachment', async () => {
    const f = await submitted();
    state.originals.get('VAT-1').snapshot.sourceFingerprint = 'e'.repeat(64);
    await expect((assertApprovalReviewReadyForDecision as any)(f.prisma, f.approval, actor)).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_AP_CHANGED', statusCode: 409 });
  });

  it('refuses a red-flushed original for new approval, but keeps its original authorized history readable', async () => {
    const f = await submitted();
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    state.originals.get('VAT-1').vatInvoice.status = 'RedFlushed';
    await expect((assertApprovalReviewReadyForDecision as any)(f.prisma, f.approval, actor)).rejects.toMatchObject({
      code: 'PAYMENT_REQUEST_AP_CHANGED', statusCode: 409 });
    await expect(assertPaymentRequestPayableRead(f.prisma, f.created, actor)).resolves.toBeUndefined();
  });

  it('checks fresh source visibility on direct service reads and fails closed without an actor', async () => {
    const f = await submitted();
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    await expect(f.service.getPaymentRequest(f.created.id)).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    state.visible = false;
    await expect(f.service.getPaymentRequest(f.created.id, undefined, actor as any)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    f.prisma.paymentRequest.findMany.mockResolvedValue([f.created]);
    await expect(f.service.listPaymentRequests({ actor: actor as any })).resolves.toEqual({ items: [] });
  });

  it('keeps a legitimate contract advance without selected APs available', async () => {
    const f = fixture();
    const result = await f.service.createPaymentRequest({ supplierId: 'SUP-1', supplierName: 'Supplier One', totalAmount: '10',
      currency: 'CNY', paymentCategory: 'advance', requestDate: '2026-10-08', sourceType: 'other', applicantId: actor.userId } as any);
    expect(result.ok).toBe(true);
    expect(f.created.attachments?.sourceSnapshot).toBeUndefined();
  });

  it('does not accept caller-authored AP snapshots or a generic source label to avoid validating selected originals', async () => {
    const f = fixture();
    const base: any = { supplierId: 'SUP-1', supplierName: 'Supplier One', totalAmount: '120', currency: 'CNY',
      paymentCategory: 'normal', requestDate: '2026-10-08', sourceType: 'other', applicantId: actor.userId, actor };
    expect(await f.service.createPaymentRequest({ ...base, attachments: { sourceSnapshot: { sourceType: 'SupplierVatPayablePayment' } } }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', statusCode: 400 } });
    const wrong = selected.map(row => ({ ...row, expectedSourceFingerprint: 'e'.repeat(64) }));
    expect(await f.service.createPaymentRequest({ ...base, payableSelections: wrong }))
      .toMatchObject({ ok: false, error: { code: 'PAYMENT_REQUEST_AP_CHANGED', statusCode: 409 } });
    expect(f.prisma.paymentRequest.create).not.toHaveBeenCalled();
  });

  it('retains the original actual-payment acknowledgement after a later red flush while rechecking current source access', async () => {
    const f = await submitted(); f.created.status = 'Approved'; f.approval.status = 'approved';
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    const params = { prisma: f.prisma, actor: actor as any, actorId: actor.userId, paymentRequestId: f.created.id, input: actualInput };
    const first = await recordSupplierActualPayment(params);
    expect(first.ok).toBe(true);
    state.originals.get('VAT-1').vatInvoice.status = 'RedFlushed';
    expect(await recordSupplierActualPayment(params)).toMatchObject({ ok: true, data: { replayed: true, voucher: { id: 'PAY-1' } } });
    expect(state.vouchers).toHaveLength(1);
    state.visible = false;
    expect(await recordSupplierActualPayment(params)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', statusCode: 404 } });
    expect(state.vouchers).toHaveLength(1);
  });

  it('does not approve an AP whose unallocated balance was consumed by a later credit', async () => {
    const f = await submitted();
    f.prisma.creditNoteAllocation.findMany.mockImplementation(async ({ where }: any) => where.invoiceId === 'AP-1' ? [{ appliedAmount: '1' }] : []);
    await expect((assertApprovalReviewReadyForDecision as any)(f.prisma, f.approval, actor)).rejects.toMatchObject({ code: 'PAYMENT_REQUEST_AP_CHANGED', statusCode: 409 });
  });

  it('does not reserve the same outstanding AP amount twice in independent valid requests', async () => {
    const f = await submitted();
    f.prisma.paymentRequest.findMany.mockResolvedValue([f.created]);
    expect(await f.service.createPaymentRequest({ supplierId: 'SUP-1', supplierName: 'Supplier One', totalAmount: '120',
      currency: 'CNY', paymentCategory: 'normal', requestDate: '2026-10-08', sourceType: 'supplier_payable',
      applicantId: actor.userId, actor, payableSelections: selected } as any))
      .toMatchObject({ ok: false, error: { code: 'PAYMENT_REQUEST_AP_CHANGED', statusCode: 409 } });
    expect(f.prisma.paymentRequest.create).toHaveBeenCalledTimes(1);
  });

  it('allows the remaining real payment after its first cash payment has been accurately allocated without settling APs by request status', async () => {
    const f = await submitted(); f.created.status = 'Approved'; f.approval.status = 'approved';
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    const params = { prisma: f.prisma, actor: actor as any, actorId: actor.userId, paymentRequestId: f.created.id };
    expect(await recordSupplierActualPayment({ ...params, input: actualInput })).toMatchObject({ ok: true, data: { remainingAmount: '60.0000' } });
    const firstAllocations = [{ invoiceId: 'AP-1', voucherId: 'PAY-1', appliedAmount: '40' }, { invoiceId: 'AP-2', voucherId: 'PAY-1', appliedAmount: '20' }];
    f.prisma.invoiceAllocation.findMany.mockImplementation(async ({ where }: any) => firstAllocations.filter(row => row.invoiceId === where.invoiceId));
    const current = await f.prisma.paymentRequest.findUnique({ where: { id: f.created.id } });
    expect(await recordSupplierActualPayment({ ...params, input: { ...actualInput, requestKey: 'b4ea3d19-9b53-4fc1-8b9e-669c088ec217', expectedRequestUpdatedAt: current.updatedAt.toISOString() } }))
      .toMatchObject({ ok: true, data: { paidAmount: '120.0000', remainingAmount: '0.0000', paymentRequest: { status: 'Paid' } } });
    expect(state.vouchers).toHaveLength(2);
    expect(f.invoices.map(row => row.status)).toEqual(['Issued', 'Issued']);
  });

  it('rejects a new actual payment if an approved original AP source has changed', async () => {
    const f = await submitted(); f.created.status = 'Approved'; f.approval.status = 'approved';
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    state.originals.get('VAT-1').snapshot.sourceFingerprint = 'e'.repeat(64);
    const result = await recordSupplierActualPayment({ prisma: f.prisma, actor: actor as any, actorId: actor.userId,
      paymentRequestId: f.created.id, input: actualInput });
    expect(result).toMatchObject({ ok: false, error: { code: 'PAYMENT_REQUEST_AP_CHANGED', statusCode: 409 } });
    expect(state.vouchers).toHaveLength(0);
  });

  it('cannot allocate an AP-authorized actual payment to an original outside its approved set', async () => {
    const f = await submitted(); f.created.status = 'Approved'; f.approval.status = 'approved';
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    const paid = await recordSupplierActualPayment({ prisma: f.prisma, actor: actor as any, actorId: actor.userId,
      paymentRequestId: f.created.id, input: actualInput });
    expect(paid.ok).toBe(true);
    f.invoices.push({ ...f.invoices[0], id: 'AP-UNSELECTED', sourceId: 'VAT-OTHER' });
    await expect(assertAllocationFacts(f.prisma, 'AP-UNSELECTED', state.vouchers[0].id, '10')).rejects.toMatchObject({
      code: 'CONFLICT', statusCode: 409 });
  });

  it('limits AP allocations across the request vouchers to each frozen approved amount', async () => {
    const selections = selected.map(row => ({ ...row, requestedAmount: row.invoiceId === 'AP-1' ? '20' : '40' }));
    const f = await submitted(selections, '60'); f.created.status = 'Approved'; f.approval.status = 'approved';
    f.prisma.approvalRequest = { findUnique: async () => f.approval };
    const paid = await recordSupplierActualPayment({ prisma: f.prisma, actor: actor as any, actorId: actor.userId,
      paymentRequestId: f.created.id, input: actualInput });
    expect(paid.ok).toBe(true);
    await expect(assertAllocationFacts(f.prisma, 'AP-1', state.vouchers[0].id, '21')).rejects.toMatchObject({
      code: 'CONFLICT', statusCode: 409 });
    await expect(assertAllocationFacts(f.prisma, 'AP-1', state.vouchers[0].id, '20')).resolves.toBeDefined();
  });
});
