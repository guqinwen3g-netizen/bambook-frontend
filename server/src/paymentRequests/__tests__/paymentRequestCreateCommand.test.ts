import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createPaymentRequestService } from '../paymentRequestService';
import { ciHash } from '../../development/developmentCiSource';
import { businessError } from '../../shared/errorCodes';

const authority = vi.hoisted(() => ({ active: true, visible: true,
  scopes: ['finance:payment_request:create', 'invoices:read'], notifications: 0, originals: new Map<string, any>() }));
vi.mock('../../sequence/sequenceService', () => ({ createSequenceService: () => ({ nextNumber: async () => 'PAYR-20261008-001' }) }));
vi.mock('../../notifications/notificationService', () => ({ createNotificationService: () => ({ sendToUser: async () => { authority.notifications++; } }) }));
vi.mock('../../finance/financeSourceAccess', () => ({ createFinanceSourceAccess: async (_tx: unknown, actor: any, scopes: string[]) => {
  const check = () => {
    if (!actor?.userId) throw businessError('UNAUTHORIZED', 'Actual actor required');
    if (!authority.active) throw businessError('ACCOUNT_DISABLED', 'Disabled');
    if (scopes.some(scope => !authority.scopes.includes(scope) || actor.permissionCeiling && !actor.permissionCeiling.includes(scope)))
      throw businessError('FORBIDDEN', 'Current grant or ceiling denied');
  };
  check();
  return { actor, all: true, invoice: async () => authority.visible, finish: async () => check() };
} }));
vi.mock('../../finance/supplierVatPayableSource', () => ({ SUPPLIER_VAT_PAYABLE_SOURCE: 'SupplierVatPayable',
  readSupplierVatPayableSource: async (_tx: unknown, id: string) => authority.originals.get(id) }));

const actor: any = { userId: 'actual-finance', roles: ['finance'], departmentIds: ['finance'],
  permissions: ['finance:payment_request:create', 'invoices:read'], permissionCeiling: ['finance:payment_request:create', 'invoices:read'] };
const key = '81d261db-f7b1-4eae-b273-b94510e56afc';
const body = { requestKey: key, supplierId: 'SUPPLIER', supplierName: 'Supplier', totalAmount: '120.0000', currency: 'CNY',
  sourceType: 'supplier_payable' as const, requestDate: '2026-10-08', paymentCategory: 'normal',
  payableSelections: [{ invoiceId: 'AP-1', requestedAmount: '40.0000', expectedSourceFingerprint: '1'.repeat(64) },
    { invoiceId: 'AP-2', requestedAmount: '80.0000', expectedSourceFingerprint: '2'.repeat(64) }] };
function fixture() {
  const requests: any[] = [], approvals: any[] = [], audits: any[] = [], allocations: any[] = [];
  const invoices = ['AP-1', 'AP-2'].map((id, index) => ({ id, type: 'Payable', sourceType: 'SupplierVatPayable', sourceId: `VAT-${index + 1}`,
    invoiceNumber: id, amount: new Prisma.Decimal(index ? '80' : '40'), currency: 'CNY', customerRelationId: 'SUPPLIER', status: 'Issued', deletedAt: null }));
  for (const [index, invoice] of invoices.entries()) authority.originals.set(invoice.sourceId, { invoice,
    vatInvoice: { id: invoice.sourceId, status: 'Received' }, snapshot: { sourceFingerprint: String(index + 1).repeat(64),
      vatOriginal: { vatNumber: `V-${index + 1}`, sellerName: 'Supplier' }, sources: [{ contractNumber: `P-${index + 1}` }] } });
  const db: any = { $queryRaw: vi.fn(async () => []),
    paymentRequest: { findFirst: async () => null, findUnique: async ({ where }: any) => requests.find(row => row.id === where.id),
      findMany: async () => requests,
      create: vi.fn(async ({ data }: any) => { const row = { ...data, payeeType: 'Supplier', deletedAt: null,
        createdAt: new Date('2026-10-08T00:18:00Z'), updatedAt: new Date('2026-10-08T00:18:00Z') }; requests.push(row); return row; }) },
    approvalRequest: { findUnique: async ({ where }: any) => approvals.find(row => row.id === where.id) },
    auditLog: { findUnique: async ({ where }: any) => audits.find(row => row.id === where.id),
      create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
    invoice: { findFirst: async ({ where }: any) => invoices.find(row => row.id === where.id) },
    invoiceAllocation: { findMany: async ({ where }: any) => allocations.filter(row => row.invoiceId === where.invoiceId) },
    creditNoteAllocation: { findMany: async () => [] }, paymentVoucher: { findMany: async () => [{ id: 'PAID-VOUCHER' }] } };
  // This models serialized storage; the independent PG acceptance earns the
  // real advisory-lock concurrency guarantee rather than inferring it here.
  let tail = Promise.resolve();
  db.$transaction = (run: any) => { const next = tail.then(() => run(db)); tail = next.catch(() => undefined); return next; };
  const approvalCreateService: any = { createBusinessApproval: vi.fn(async (input: any) => {
    const row = { ...input, client: undefined, id: `APR-${approvals.length + 1}`, reviewerId: 'actual-approver', status: 'pending' };
    approvals.push(row); return row;
  }) };
  const service = createPaymentRequestService({ prisma: db, approvalCreateService });
  const create = (change: any = {}) => service.createPaymentRequest({ ...body, applicantId: actor.userId, actor, ...change } as any);
  return { db, requests, approvals, audits, allocations, invoices, approvalCreateService, create };
}
beforeEach(() => { authority.active = authority.visible = true; authority.scopes = ['finance:payment_request:create', 'invoices:read'];
  authority.notifications = 0; authority.originals.clear(); });

describe('accurate AP application creation original command', () => {
  it('recovers the original Pending receipt after real later payment/allocation state without reserving the AP twice', async () => {
    const f = fixture(), first = await f.create();
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect((first.data as any).financeCommand).toMatchObject({ kind: 'payment_request.create', actorId: actor.userId,
      requestKey: key, targetId: first.data.paymentRequest.id, commandHash: ciHash({ kind: 'payment_request.create', input: body }) });
    expect(first.data.paymentRequest.createdAt).toBeInstanceOf(Date);
    expect(first.data.paymentRequest.updatedAt).toBeInstanceOf(Date);
    expect(first.data.paymentRequest.totalAmount).toBeInstanceOf(Prisma.Decimal);
    f.requests[0].status = 'Paid'; f.requests[0].updatedAt = new Date('2026-10-09T00:00:00Z');
    f.approvals[0].status = 'approved';
    for (const invoice of f.invoices) { invoice.status = 'Paid'; f.allocations.push({ invoiceId: invoice.id, voucherId: 'PAID-VOUCHER', appliedAmount: String(invoice.amount) }); }
    authority.originals.get('VAT-1').vatInvoice.status = 'RedFlushed';
    const replay = await f.create();
    expect(replay).toMatchObject({ ok: true, data: { replayed: true, paymentRequest: { status: 'Pending' } } });
    expect(replay.ok && replay.data.paymentRequest).toEqual(first.data.paymentRequest);
    expect(f.db.paymentRequest.create).toHaveBeenCalledTimes(1);
    expect(f.approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
    expect(f.audits.filter(row => row.action === 'finance_command_committed')).toHaveLength(1);
    expect(authority.notifications).toBe(1);
  });

  it('rejects a same-key changed selection before creating another approval or application', async () => {
    const f = fixture(); expect((await f.create()).ok).toBe(true);
    const payableSelections = body.payableSelections.map(row => ({ ...row, requestedAmount: row.invoiceId === 'AP-1' ? '39.0000' : '81.0000' }));
    expect(await f.create({ payableSelections })).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } });
    expect(f.db.paymentRequest.create).toHaveBeenCalledTimes(1); expect(f.approvalCreateService.createBusinessApproval).toHaveBeenCalledTimes(1);
  });

  it('rechecks current create scope, account status, credential ceiling and actual original L2 before returning an old receipt', async () => {
    for (const deny of ['grant', 'disabled', 'ceiling', 'source']) {
      authority.scopes = ['finance:payment_request:create', 'invoices:read']; authority.active = authority.visible = true;
      const f = fixture(); expect((await f.create()).ok).toBe(true);
      const change: any = {};
      if (deny === 'grant') authority.scopes = ['invoices:read'];
      if (deny === 'disabled') authority.active = false;
      if (deny === 'source') authority.visible = false;
      if (deny === 'ceiling') change.actor = { ...actor, permissionCeiling: ['invoices:read'] };
      expect(await f.create(change)).toMatchObject({ ok: false, error: { code: deny === 'disabled' ? 'ACCOUNT_DISABLED' : deny === 'source' ? 'NOT_FOUND' : 'FORBIDDEN' } });
      expect(f.db.paymentRequest.create).toHaveBeenCalledTimes(1);
    }
  });

  it('does not let simultaneous same-key intents leave two applications or approval tasks', async () => {
    const f = fixture(), responses = await Promise.all([f.create(), f.create(), f.create()]);
    expect(responses.every(response => response.ok)).toBe(true);
    expect(new Set(responses.map(response => response.ok && response.data.paymentRequest.id)).size).toBe(1);
    expect(f.db.$queryRaw.mock.calls.some(([sql]: any) => sql.text.includes('pg_advisory_xact_lock') && sql.text.includes('::text'))).toBe(true);
    expect(f.db.paymentRequest.create).toHaveBeenCalledTimes(1); expect(authority.notifications).toBe(1);
  });

  it('hashes only the actual public command, retaining raw values while business fields use their normal validation', async () => {
    const f = fixture(), changed = { supplierName: ' Supplier ', remark: ' Actual evidence ', currency: ' CNY ' };
    const result = await f.create({ ...changed, clientSuppliedReviewerId: 'not-an-authority' });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect((result.data as any).financeCommand.commandHash).toBe(ciHash({ kind: 'payment_request.create', input: { ...body, ...changed } }));
    expect(result.data.paymentRequest.supplierName).toBe('Supplier'); expect(result.data.paymentRequest.currency).toBe('CNY');
  });

  it('keeps legacy no-key AP and non-AP creation compatible while refusing a missing actual actor on the new command', async () => {
    const missing = fixture();
    expect(await missing.create({ actor: undefined })).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(missing.db.paymentRequest.create).not.toHaveBeenCalled();
    const oldAp = fixture(), old = await oldAp.create({ requestKey: undefined });
    expect(old.ok).toBe(true); expect(old.ok && (old.data as any).financeCommand).toBeUndefined();
    const other = fixture(), legacy = await other.create({ sourceType: 'other', payableSelections: undefined, actor: undefined });
    expect(legacy.ok).toBe(true); expect(legacy.ok && (legacy.data as any).financeCommand).toBeUndefined();
  });
});
