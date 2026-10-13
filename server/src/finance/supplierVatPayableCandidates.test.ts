import { describe, expect, it } from 'vitest';
import { normalizeSupplierVatCandidateQuery, supplierVatCandidateCapacity, decodeSupplierVatCandidateCursor,
  encodeSupplierVatCandidateCursor } from './supplierVatPayableCandidates';

describe('bounded explicit supplier VAT candidate query', () => {
  it('requires a declared basis and applies a bounded default page without assuming tax conversion', () => {
    expect(normalizeSupplierVatCandidateQuery({ amountBasis: 'net', search: '  PO-123  ' })).toEqual({ amountBasis: 'net', search: 'PO-123', limit: 25, cursor: null });
    expect(normalizeSupplierVatCandidateQuery({ amountBasis: 'gross', limit: '100' }).limit).toBe(100);
  });
  it.each([{}, { amountBasis: 'auto' }, { amountBasis: ['net'] }, { amountBasis: 'net', limit: '101' },
    { amountBasis: 'net', limit: '0' }, { amountBasis: 'net', limit: '-1' }, { amountBasis: 'net', limit: '2.5' },
    { amountBasis: 'net', limit: ['2'] }, { amountBasis: 'net', search: ['PO'] }, { amountBasis: 'net', search: 'x'.repeat(101) },
    { amountBasis: 'net', cursor: ['token'] }, { amountBasis: 'net', cursor: '!invalid' }, { amountBasis: 'net', supplierId: 'override' }])
  ('rejects ambiguous, unbounded or caller-overridden input %j', query => {
    expect(() => normalizeSupplierVatCandidateQuery(query)).toThrow();
  });
  it('round trips only a complete bounded cursor with current frozen source identity', () => {
    const cursor = { version: 1 as const, binding: 'a'.repeat(64), contractKind: 'purchase' as const, contractId: 'PO', lineId: 'line',
      commitmentRevisionId: 'rev', commitmentFingerprint: 'b'.repeat(64) };
    expect(decodeSupplierVatCandidateCursor(encodeSupplierVatCandidateCursor(cursor))).toEqual(cursor);
    expect(() => decodeSupplierVatCandidateCursor(Buffer.from(JSON.stringify({ ...cursor, commitmentFingerprint: null })).toString('base64url'))).toThrow();
    expect(() => decodeSupplierVatCandidateCursor(Buffer.from(JSON.stringify({ ...cursor, injected: true })).toString('base64url'))).toThrow();
  });
});

describe('read-only capacity retains the actual registered amount basis', () => {
  it('uses no assumed basis before the first registration', () => {
    expect(supplierVatCandidateCapacity('100.0000', 'gross', [])).toEqual({ registeredAmount: '0.0000', remainingAmount: '100.0000', registeredAmountBasis: null, selectable: true });
  });
  it('reports an explicit basis conflict without converting values', () => {
    expect(supplierVatCandidateCapacity('100.0000', 'gross', [{ amountBasis: 'net', contractAmount: '60' }])).toMatchObject({
      registeredAmount: '60.0000', remainingAmount: '40.0000', registeredAmountBasis: 'net', selectable: false, unavailableReason: expect.stringMatching(/基准/) });
  });
  it.each(['100', '110'])('retains exhausted or exceeded original capacity %s as unavailable', amount => {
    expect(supplierVatCandidateCapacity('100', 'net', [{ amountBasis: 'net', contractAmount: amount }])).toMatchObject({
      registeredAmount: `${amount}.0000`, remainingAmount: amount === '100' ? '0.0000' : '-10.0000', registeredAmountBasis: 'net', selectable: false });
  });
  it('rejects internally inconsistent mixed basis history instead of summing unlike units', () => {
    expect(() => supplierVatCandidateCapacity('100', 'net', [{ amountBasis: 'net', contractAmount: '1' }, { amountBasis: 'gross', contractAmount: '1' }])).toThrow();
  });
});
