import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { normalizeCashRefundReturn, readCashReturnProof } from '../claimCashRefundReturnFact';
import { assertNotCashRefundVoucher } from '../claimCashRefundFact';

const valid = () => ({ clientRequestId: 'actual-inbound-1', expectedVersion: 1, returnedPrincipal: '12.9999', receivedNet: '10.9999', bankFee: '2',
  feeBearer: 'SHA', actualDate: '2026-10-02', actualMethod: 'TT', bankReference: 'inbound-bank-reference', evidenceIds: ['evidence-2', 'evidence-1'] });
/** Independent arithmetic/entry guard checks. These storage substitutes are NOT
 * evidence of bank verification, genuine PostgreSQL atomicity or concurrency;
 * BANKR private-PG cases retain those separate assertions. */
describe('explicit bank-return principal, original-byte purpose and actual FK isolation', () => {
  it.each(['OUR', 'BEN', 'SHA'])('records %s without inferring principal or net: all three actual amounts must independently agree', feeBearer => {
    const body = { ...valid(), feeBearer };
    expect(normalizeCashRefundReturn(body)).toMatchObject({ returnedPrincipal: '12.9999', receivedNet: '10.9999', bankFee: '2', feeBearer,
      evidenceIds: ['evidence-1', 'evidence-2'], receiptVoucherId: null });
    expect(() => normalizeCashRefundReturn({ ...body, receivedNet: '12.9999' })).toThrow(/本金/);
  });
  it('permits no-fee actual net with explicitly unknown bearer; a charged fee with unknown bearer remains pending manual reconciliation', () => {
    expect(normalizeCashRefundReturn({ ...valid(), receivedNet: '12.9999', bankFee: '0', feeBearer: null })).toMatchObject({ feeBearer: null, bankFee: '0' });
    expect(() => normalizeCashRefundReturn({ ...valid(), feeBearer: null })).toThrow(/承担/);
    expect(() => normalizeCashRefundReturn({ ...valid(), feeBearer: '' })).toThrow(/承担/);
  });
  it.each([
    { returnedPrincipal: '0', receivedNet: '0', bankFee: '0' }, { receivedNet: '-1' }, { bankFee: '-1' },
    { returnedPrincipal: '1e2' }, { receivedNet: 'NaN' }, { returnedPrincipal: '12.99999' },
    { bankFee: '0.00001' }, { returnedPrincipal: '100000000000000' }, { currency: 'EUR' },
    { expectedVersion: 0 }, { actualDate: '2026-02-30' }, { evidenceIds: [] }, { evidenceIds: ['same', 'same'] },
    { actualMethod: 'guess' }, { bankReference: '' }, { receiptVoucherId: '' }, { feeBearer: 'UNKNOWN' },
  ])('rejects incomplete, unrepresentable, mixed or silently rounded bank facts %#', change => {
    expect(() => normalizeCashRefundReturn({ ...valid(), ...change } as any)).toThrow();
  });
  it('preserves four-decimal monetary evidence instead of a binary floating sum', () => {
    const facts = normalizeCashRefundReturn({ ...valid(), returnedPrincipal: '0.0003', receivedNet: '0.0001', bankFee: '0.0002' });
    expect(facts.returnedPrincipal).toBe('0.0003'); expect(new Prisma.Decimal(facts.receivedNet).plus(facts.bankFee).toString()).toBe('0.0003');
  });
  it('requires a refund-specific inbound proof; original payout or unrelated file is not receipt proof', async () => {
    const findMany = vi.fn(async () => []), tx = { creditNoteRefundEvidence: { findMany } };
    await expect(readCashReturnProof(tx, 'paid-refund', ['payout-proof'])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(findMany).toHaveBeenCalledWith({ where: { refundId: 'paid-refund', purpose: 'PaymentReturnProof', id: { in: ['payout-proof'] } } });
  });
  it('checks the true return receipt FK after its row lock, never permits notes or an unreconciled projection to override it', async () => {
    const order: string[] = [], tx = { $queryRawUnsafe: vi.fn(async () => { order.push('lock'); return []; }),
      creditNoteRefundReturn: { findUnique: vi.fn(async () => { order.push('return-fk'); return { id: 'actual-return' }; }) },
      creditNoteRefund: { findUnique: vi.fn(async () => null) } };
    await expect(assertNotCashRefundVoucher(tx, 'receipt')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(order).toEqual(['lock', 'return-fk']); expect(tx.creditNoteRefund.findUnique).not.toHaveBeenCalled();
  });
  it('keeps an ordinary Receipt without a refund/return FK available for its existing allocation workflow', async () => {
    const tx = { $queryRawUnsafe: vi.fn(async () => []), creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, creditNoteRefund: { findUnique: vi.fn(async () => null) } };
    await expect(assertNotCashRefundVoucher(tx, 'ordinary-receipt')).resolves.toBeUndefined();
    expect(tx.creditNoteRefund.findUnique).toHaveBeenCalledWith({ where: { paymentVoucherId: 'ordinary-receipt' } });
  });
});
