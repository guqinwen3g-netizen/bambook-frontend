import { describe, expect, it, vi } from 'vitest';
import { createCommissionPayable, getOrderCommission, commissionPayableAnchorSequence } from '../commissionPayableService';
import { createInvoice } from '../../finance/invoiceMutationService';
vi.mock('../../finance/invoiceMutationService', () => ({ createInvoice: vi.fn() }));

// Storage-contract controls; they do not prove a native Invoice was committed.
// Native producer, cancellation and two real Order prefixes are tested in PG.
function fixture(extra: any[] = []) {
  const invoices = extra.map(row => ({ id: row.sourceId, invoiceNumber: row.sourceId, type: 'Payable', sourceType: 'CommissionPayable', orderId: 'OrderA', status: 'Issued',
    currency: 'USD', amount: 25, issueDate: '2026-10-01', deletedAt: null, ...row }));
  const invoiceQueries: any[] = [];
  const database: any = {
    userAccount: { findFirst: vi.fn(async () => ({ id: 'actual-actor', status: 'active', deletedAt: null })),
      findUnique: vi.fn(async () => ({ id: 'actual-actor', status: 'active', deletedAt: null, primaryDeptId: null,
        roles: [{ departmentId: null, role: { id: 'role-finance', permissions: [{ permission: { scope: 'pricing:write' } }] } }] })) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'OrderA' }]),
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
    order: { findFirst: vi.fn(async ({ where }) => ['OrderA', 'OrderA-suffix'].includes(where.id) ? { id: where.id } : null) },
    pricingCalculation: { findMany: vi.fn(async () => [{ id: 'pricing', orderId: 'OrderA', deletedAt: null, status: 'Confirmed', commissionAmount: 1, quantity: 100, commissionRuleId: 'rule' }]) },
    commissionRule: { findMany: vi.fn(async () => [{ id: 'rule', rate: 5, intermediaryRelationId: 'real-intermediary', intermediaryName: 'Actual intermediary', isActive: true, deletedAt: null }]) },
    invoice: { findMany: vi.fn(async args => {
      invoiceQueries.push(args);
      return invoices.filter(row => row.id !== args.where.id?.not && row.type === args.where.type && row.sourceType === args.where.sourceType && args.where.OR.some((branch: any) =>
        typeof branch.sourceId === 'string' ? row.sourceId === branch.sourceId : row.sourceId.startsWith(branch.sourceId.startsWith)));
    }) } };
  database.$transaction = vi.fn(async (work: any) => work(database));
  vi.mocked(createInvoice).mockReset(); vi.mocked(createInvoice).mockImplementation(async ({ input }: any) => {
    const invoice = { ...input, id: 'native-seam', invoiceNumber: 'INV-native-seam', deletedAt: null };
    invoices.push(invoice); return { ok: true, data: { invoice } } as any;
  });
  return { database, invoices, invoiceQueries };
}
describe('commission Payable exact Order namespace and legacy guard', () => {
  it('neighboring prefix never contributes another Order balance', async () => {
    const f = fixture([{ sourceId: 'OrderA#1' }, { sourceId: 'OrderA-suffix#999', orderId: 'OrderA-suffix', amount: 999 }]);
    const result = await getOrderCommission(f.database, 'OrderA'); expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected exact namespace');
    expect(result.data.invoicedAmount).toBe(25); expect(result.data.uninvoicedAmount).toBe(75); expect(result.data.payableInvoices.map(row => row.id)).toEqual(['OrderA#1']);
    expect(f.invoiceQueries[0].where.OR).toEqual([{ sourceId: 'OrderA' }, { sourceId: { startsWith: 'OrderA#' } }]);
  });
  it('cancelled own anchor retains next sequence while a foreign cancelled prefix cannot affect it', async () => {
    const f = fixture([{ sourceId: 'OrderA#1', status: 'Cancelled' }, { sourceId: 'OrderA-suffix#999', orderId: 'OrderA-suffix', status: 'Cancelled' }]);
    const result = await createCommissionPayable(f.database, { orderId: 'OrderA' }, 'actual-actor'); expect(result.ok).toBe(true);
    expect(createInvoice).toHaveBeenCalledTimes(1); expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actual-actor', input: expect.objectContaining({ orderId: 'OrderA', sourceId: 'OrderA#2', amount: 100 }) }));
    expect(f.invoices.find(row => row.sourceId === 'OrderA-suffix#999')!.status).toBe('Cancelled');
  });
  it.each(['OrderA', 'OrderA#01', 'OrderA#0', 'OrderA#1-tail', 'OrderA#9007199254740992'])('unverified %s blocks both read and creation without rewriting history', async sourceId => {
    const f = fixture([{ sourceId }]), before = JSON.parse(JSON.stringify(f.invoices));
    for (const result of [await getOrderCommission(f.database, 'OrderA'), await createCommissionPayable(f.database, { orderId: 'OrderA' }, 'actual-actor')]) expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(createInvoice).not.toHaveBeenCalled(); expect(f.invoices).toEqual(before);
  });
  it('declared Invoice Order and canonical sequence must both agree with the namespace', () => {
    expect(commissionPayableAnchorSequence('OrderA', { orderId: 'OrderA-suffix', sourceId: 'OrderA#1' })).toBeNull();
    expect(commissionPayableAnchorSequence('OrderA', { orderId: 'OrderA', sourceId: 'OrderA#12' })).toBe(12);
    expect(commissionPayableAnchorSequence('OrderA', { orderId: 'OrderA', sourceId: 'OrderA-suffix#12' })).toBeNull();
  });
});
