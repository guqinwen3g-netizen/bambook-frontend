import { beforeEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
vi.mock('../allocationService', async (original) => ({ ...await original<any>(), applyAllocation: vi.fn() }));
vi.mock('../../events/businessEventBus', async (original) => ({ ...await original<any>(), publishBusinessEvent: vi.fn().mockResolvedValue(undefined) }));
import { applyAllocation } from '../allocationService';
import { appendReceiptAllocation } from '../allocationMutationService';
let total: number; let receipts: Map<string, any>; let tx: any; let prisma: any;
beforeEach(() => {
 total = 0; receipts = new Map();
 // Ordinary receipt allocations have no CN cash-refund voucher linkage.
 tx = { $queryRawUnsafe: vi.fn(async () => []), creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, invoiceAllocation: { findUnique: vi.fn(async () => total ? { appliedAmount: String(total) } : null) }, auditLog: { findUnique: vi.fn(async ({where}: any) => receipts.get(where.id)), create: vi.fn(async ({data}: any) => { receipts.set(data.id, data); return data; }) } };
 prisma = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) };
 vi.mocked(applyAllocation).mockReset().mockImplementation(async (_p, _tx, p) => {
  if (Number(p.appliedAmount) > 100) throw Object.assign(new Error('exceeds remaining'), { code: 'AMOUNT_EXCEEDS_VOUCHER_REMAINING' });
  total = Number(p.appliedAmount);
  return { allocationId: 'A', newInvoiceStatus: 'PartiallyPaid', newVoucherStatus: total === 100 ? 'reconciled' : 'partially_reconciled', voucherAppliedAmount: new Prisma.Decimal(total), auditId: 'audit', thirdPartyPayment: null } as any;
 });
});
const claim = (amount: number, requestId: string) => appendReceiptAllocation({ prisma, invoiceId: 'I', voucherId: 'V', amount, actorId: 'U', requestId, validate: async () => {} });
it('60 then 40 appends to 100; retry after settlement returns original result', async () => {
 expect((await claim(60, 'first')).ok).toBe(true);
 expect((await claim(40, 'second')).ok).toBe(true);
 expect(total).toBe(100);
 expect((await claim(40, 'second')).data?.replayed).toBe(true);
 expect(total).toBe(100);
 expect(applyAllocation).toHaveBeenCalledTimes(2);
 expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
});
it('same request with different payload is rejected', async () => {
 await claim(60, 'first');
 expect((await claim(40, 'first')).error?.code).toBe('CONFLICT');
 expect(total).toBe(60);
});
it('remaining balance violation is rejected without a receipt', async () => {
 await claim(60, 'first');
 expect((await claim(50, 'second')).error?.code).toBe('AMOUNT_EXCEEDS_VOUCHER_REMAINING');
 expect(total).toBe(60); expect(receipts.size).toBe(1);
});
it('SSI conflict returns retryable conflict and identical request can retry', async () => {
 prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('race'), {code:'P2034'}));
 expect((await claim(60, 'first')).error?.code).toBe('CONFLICT');
 expect(total).toBe(0);
 expect((await claim(60, 'first')).ok).toBe(true);
 expect(total).toBe(60);
});
it('concurrent duplicate finds committed receipt instead of appending again', async () => {
 await claim(60, 'first');
 prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('race'), {code:'P2002'}));
 expect((await claim(60, 'first')).data?.replayed).toBe(true);
 expect(total).toBe(60);
});
it('rejects nonpositive delta before transaction', async () => {
 expect((await claim(-10, 'negative')).error?.code).toBe('INVALID_AMOUNT');
 expect(prisma.$transaction).not.toHaveBeenCalled();
});
