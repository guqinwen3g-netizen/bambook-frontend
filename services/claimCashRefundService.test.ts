import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkedBankReturnHistory, createClaimCashRefundClient, normalizedBankReturn, receiptMatchesReturn, validBankReturn, validBankReturnAcknowledgement, type BankReturnHistory, type BankReturnInput, type ReturnReceipt } from './claimCashRefundService';
const canonical = (value: unknown) => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const payload = (): BankReturnInput => ({ expectedVersion: 1, returnedPrincipal: '12.9999', receivedNet: '10.9999', bankFee: '2', feeBearer: 'SHA', actualDate: '2026-10-02', actualMethod: 'TT', bankReference: 'INBOUND', evidenceIds: ['PRIVATE_RETURN_FILE'] });
function ack(body = payload()) {
  const wire = { ...body, clientRequestId: 'stable-return' }, parameters = { schemaVersion: 1, command: normalizedBankReturn(body, wire.clientRequestId),
    requestEnvelope: { schemaVersion: 1, action: 'return', originalClientRequestId: wire.clientRequestId, originalPayload: wire, originalParameterHash: hash(wire) } };
  return { refund: { id: 'R1', creditNoteId: 'CN1', status: 'Paid' }, cashReturn: { id: 'RET1', creditNoteId: 'CN1', refundId: 'R1', customerRelationId: 'C1', currency: 'USD',
    receiptVoucherId: 'RECEIPT1', actorId: 'finance', requestId: wire.clientRequestId, auditId: 'AUDIT1', currentVersionId: 'V1', currentVersionFingerprint: 'a'.repeat(64),
    returnedPrincipal: '12.9999', receivedNet: '10.9999', bankFee: '2', feeBearer: 'SHA', actualDate: body.actualDate, actualMethod: body.actualMethod, bankReference: body.bankReference,
    parameters, parametersHash: hash(parameters), createdAt: '123' }, receiptVoucher: { id: 'RECEIPT1', type: 'Receipt', status: 'reconciled', amount: '12.9999', currency: 'USD', customerRelationId: 'C1' }, settlementEventId: 'SETTLEMENT1' };
}
const identity = { actorId: 'finance', refundId: 'R1', noteId: 'CN1', customerId: 'C1', currency: 'USD' };
const history = (): BankReturnHistory => ({ refund: { id: 'R1', creditNoteId: 'CN1', customerRelationId: 'C1', status: 'Paid', amount: '25', currency: 'USD' },
  creditNote: { id: 'CN1', currency: 'USD', openAmount: '37.9999' }, items: [ack().cashReturn], paidPrincipal: '25', returnedPrincipalTotal: '12.9999', remainingReturnable: '12.0001',
  reservedAmount: '7', availableToSettle: '30.9999', currentVersion: 1, meaning: 'recorded_bank_return_only' });
beforeEach(() => vi.stubGlobal('crypto', webcrypto)); afterEach(() => vi.unstubAllGlobals());
describe('actual bank-return client receipts, independent decimal checks and exact request acknowledgement', () => {
  it('uses explicit independent gross/net/fee, never infers them from OUR/BEN/SHA or binary rounding', () => {
    for (const feeBearer of ['OUR', 'BEN', 'SHA']) expect(validBankReturn({ ...payload(), feeBearer })).toBe(true);
    expect(validBankReturn({ ...payload(), receivedNet: '12.9999' })).toBe(false);
    expect(validBankReturn({ ...payload(), feeBearer: null })).toBe(false);
    expect(validBankReturn({ ...payload(), receivedNet: '12.9999', bankFee: '0', feeBearer: null })).toBe(true);
    expect(validBankReturn({ ...payload(), returnedPrincipal: '0', receivedNet: '0', bankFee: '0' })).toBe(false);
    expect(validBankReturn({ ...payload(), returnedPrincipal: '12.99999' })).toBe(false);
    expect(validBankReturn({ ...payload(), actualDate: '2026-02-30' })).toBe(false);
  });
  it('reads the real paid parent and signed monetary sums; unknown, foreign, duplicate and guessed-zero balances fail', () => {
    expect(checkedBankReturnHistory(history(), 'CN1', 'R1', 'USD').remainingReturnable).toBe('12.0001');
    for (const changed of [{ availableToSettle: null }, { remainingReturnable: '0' }, { returnedPrincipalTotal: '0' }, { currentVersion: 0 }, { items: [ack().cashReturn, ack().cashReturn] }])
      expect(() => checkedBankReturnHistory({ ...history(), ...changed } as any, 'CN1', 'R1', 'USD')).toThrow();
    expect(() => checkedBankReturnHistory(history(), 'CN-other', 'R1', 'USD')).toThrow();
    expect(() => checkedBankReturnHistory({ ...history(), refund: { ...history().refund, status: 'Cancelled' } }, 'CN1', 'R1', 'USD')).toThrow();
  });
  it('accepts exact immutable returned fact and rejects altered actor, body, source or a payout voucher even if HTTP said success', async () => {
    await expect(validBankReturnAcknowledgement(ack(), 'stable-return', payload(), identity)).resolves.toBe(true);
    await expect(validBankReturnAcknowledgement(ack(), 'stable-return', { ...payload(), bankReference: 'different-bank-flow' }, identity)).resolves.toBe(false);
    await expect(validBankReturnAcknowledgement(ack(), 'stable-return', payload(), { ...identity, actorId: 'other' })).resolves.toBe(false);
    await expect(validBankReturnAcknowledgement({ ...ack(), receiptVoucher: { ...ack().receiptVoucher, type: 'Disbursement' } }, 'stable-return', payload(), identity)).resolves.toBe(false);
    await expect(validBankReturnAcknowledgement({ ...ack(), cashReturn: { ...ack().cashReturn, parametersHash: 'f'.repeat(64) } }, 'stable-return', payload(), identity)).resolves.toBe(false);
    await expect(validBankReturnAcknowledgement({ ...ack(), cashReturn: { ...ack().cashReturn, refundId: 'other' } }, 'stable-return', payload(), identity)).rejects.toThrow();
  });
  it('matches a human-selected real receipt by all explicit facts; no amount-first selection, stale field or unknown net/proof can qualify it', () => {
    const candidate: ReturnReceipt = { id: 'RECEIPT', voucherNumber: 'PV-1', customerRelationId: 'C1', currency: 'USD', type: 'Receipt', status: 'unreconciled', amount: '12.9999',
      bankFee: '2', feeBearer: 'SHA', paymentDate: '2026-10-02', paymentMethod: 'TT', invoiceId: null, appliedAmount: null, paymentReference: 'INBOUND', receivedNet: '10.9999', evidenceIds: ['PRIVATE_RETURN_FILE'] };
    expect(receiptMatchesReturn(candidate, payload(), 'C1', 'USD')).toBe(true);
    for (const changed of [{ customerRelationId: 'other' }, { currency: 'EUR' }, { appliedAmount: '0' }, { invoiceId: 'invoice' }, { paymentReference: null },
      { receivedNet: null }, { bankFee: null }, { paymentMethod: 'Cash' }, { evidenceIds: ['PAYOUT_FILE'] }, { feeBearer: null }])
      expect(receiptMatchesReturn({ ...candidate, ...changed }, payload(), 'C1', 'USD')).toBe(false);
  });
  it('fetches only the dedicated locked-parent candidates, never a company-wide finance list or browser-created association', async () => {
    const request = vi.fn(async () => ({ refundId: 'R1', creditNoteId: 'CN1', customerRelationId: 'C1', currency: 'USD', meaning: 'unallocated_receipts_require_bank_fact_match', items: [] }));
    await createClaimCashRefundClient(request as any).receipts('R1', 'CN1', 'C1', 'USD');
    expect(request).toHaveBeenCalledExactlyOnceWith('/v1/credit-note-refunds/R1/return-receipts');
    request.mockResolvedValueOnce({ refundId: 'R1', creditNoteId: 'CN-other', customerRelationId: 'C1', currency: 'USD', meaning: 'unallocated_receipts_require_bank_fact_match', items: [] });
    await expect(createClaimCashRefundClient(request as any).receipts('R1', 'CN1', 'C1', 'USD')).rejects.toThrow(/来源/);
  });
});
