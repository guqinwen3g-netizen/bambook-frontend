import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { freezePaymentRequestPayables, listPaymentRequestPayableCandidates } from '../paymentRequestPayableSource';

const sources = vi.hoisted(() => new Map<string, any>());
vi.mock('../../finance/financeSourceAccess', () => ({ createFinanceSourceAccess: async (_tx: unknown, actor: any, scopes: string[]) => {
  if (!actor?.userId) throw Object.assign(Error('Actual actor required'), { code: 'UNAUTHORIZED' });
  if (scopes.some(scope => !actor.permissions.includes(scope) || actor.permissionCeiling && !actor.permissionCeiling.includes(scope)))
    throw Object.assign(Error('Current scope denied'), { code: 'FORBIDDEN' });
  return { actor, invoice: async (invoice: any) => invoice.id !== 'AP-02', finish: async () => undefined };
} }));
vi.mock('../../finance/supplierVatPayableSource', () => ({ SUPPLIER_VAT_PAYABLE_SOURCE: 'SupplierVatPayable',
  readSupplierVatPayableSource: async (_tx: unknown, id: string) => sources.get(id) }));
const actor: any = { userId: 'actual-recorder', roles: ['sales'], departmentIds: ['fabric'], permissions: ['finance:payment_request:create', 'invoices:read'] };
async function fixture() {
  sources.clear();
  const invoices = Array.from({ length: 6 }, (_v, index) => ({ id: `AP-0${index + 1}`, sourceType: 'SupplierVatPayable', sourceId: `VAT-${index + 1}`,
    invoiceNumber: `SVAT-${index + 1}`, type: 'Payable', customerRelationId: 'SUPPLIER', currency: 'CNY',
    amount: new Prisma.Decimal(index === 0 ? '100' : '20'), status: 'Issued', deletedAt: null }));
  for (const [index, invoice] of invoices.entries()) sources.set(invoice.sourceId, { invoice,
    vatInvoice: { status: index === 2 ? 'RedFlushed' : 'Received' }, snapshot: { sourceFingerprint: String(index + 1).repeat(64),
      vatOriginal: { vatNumber: `SUPPLIER-ORIGINAL-${index + 1}`, vatCode: null, sellerName: 'Current supplier' },
      sources: [{ contractNumber: `CONTRACT-${index + 1}` }] } });
  const requests: any[] = [];
  const db: any = { $queryRaw: async () => [],
    invoice: { findFirst: async ({ where }: any) => invoices.find(row => row.id === where.id), findMany: async ({ where, take }: any) =>
      invoices.filter(row => row.customerRelationId === where.customerRelationId && row.currency === where.currency && (!where.id?.gt || row.id > where.id.gt)).slice(0, take) },
    invoiceAllocation: { findMany: async ({ where }: any) => where.invoiceId === 'AP-01' ? [{ voucherId: 'OTHER', appliedAmount: '10' }]
      : where.invoiceId === 'AP-04' ? [{ voucherId: 'OTHER', appliedAmount: '20' }] : [] },
    creditNoteAllocation: { findMany: async ({ where }: any) => where.invoiceId === 'AP-01' ? [{ appliedAmount: '5' }] : [] },
    paymentRequest: { findMany: async () => requests }, paymentVoucher: { findMany: async () => [] } };
  const snapshot = await freezePaymentRequestPayables(db, { actor, applicantId: actor.userId, supplierId: 'SUPPLIER', currency: 'CNY', totalAmount: '20',
    selections: [{ invoiceId: 'AP-01', requestedAmount: '20', expectedSourceFingerprint: '1'.repeat(64) }] });
  requests.push({ id: 'RESERVED', status: 'Pending', attachments: { sourceSnapshot: snapshot } });
  return db;
}
describe('actual visible AP payment candidates', () => {
  it('pages only visible valid originals with positive unreserved capacity, using the same credits and live reservations as submission', async () => {
    const db = await fixture();
    const first = await listPaymentRequestPayableCandidates(db, actor, { supplierId: 'SUPPLIER', currency: 'CNY', limit: 1 });
    expect(first).toMatchObject({ hasMore: true, nextCursor: 'AP-01', items: [{ invoiceId: 'AP-01', vatInvoiceId: 'VAT-1',
      invoiceAmount: '100.0000', appliedAmount: '15.0000', remainingAmount: '85.0000', reservedAmount: '20.0000', availableAmount: '65.0000',
      vatNumber: 'SUPPLIER-ORIGINAL-1', contractNumbers: ['CONTRACT-1'] }] });
    expect('total' in first).toBe(false);
    const second = await listPaymentRequestPayableCandidates(db, actor, { supplierId: 'SUPPLIER', currency: 'CNY', cursor: first.nextCursor, limit: 2 });
    expect(second.items.map(item => item.invoiceId)).toEqual(['AP-05', 'AP-06']);
    expect(second).toMatchObject({ nextCursor: null, hasMore: false });
  });
  it('searches source labels after L2 filtering and fails closed for missing current identity or scope', async () => {
    const db = await fixture(), query = { supplierId: 'SUPPLIER', currency: 'CNY', search: 'contract-6' };
    expect((await listPaymentRequestPayableCandidates(db, actor, query)).items.map(item => item.invoiceId)).toEqual(['AP-06']);
    expect(await listPaymentRequestPayableCandidates(db, actor, { ...query, search: 'SUPPLIER-ORIGINAL-2' })).toEqual({ items: [], nextCursor: null, hasMore: false });
    await expect(listPaymentRequestPayableCandidates(db, null, query)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(listPaymentRequestPayableCandidates(db, { ...actor, permissionCeiling: ['invoices:read'] }, query)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
