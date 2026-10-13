import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { normalizeSupplierVatSelection, supplierVatOriginal, assertSupplierVatAmounts, assertSupplierVatCapacity } from './supplierVatPayableSource';

const selection = (overrides: Record<string, unknown> = {}) => ({ amountBasis: 'net', dueDate: '2026-11-08',
  sources: [{ contractKind: 'purchase', contractId: 'PO', commitmentRevisionId: 'REV', lineId: 'LINE', contractAmount: '100.0000' }], ...overrides });
const vat = (overrides: Record<string, unknown> = {}) => ({ id: 'VAT', vatNumber: 'actual-number', vatCode: null,
  direction: 'Input', invoiceType: 'Special', status: 'Received', relationId: 'supplier', sellerName: 'Actual supplier',
  sellerTaxNo: 'tax-id', buyerName: 'Actual buyer', buyerTaxNo: null, issueDate: '2026-10-08', netAmount: '100', taxRate: '13',
  taxAmount: '13', totalAmount: '113', currency: 'CNY', orderId: null, attachments: [{ name: 'supplier-original.pdf', externalReference: 'actual-source' }], ...overrides });
describe('supplier VAT payable exact amount basis', () => {
  it('normalizes exact decimal selections and deterministic source order', () => {
    expect(normalizeSupplierVatSelection(selection()).sources[0].contractAmount).toBe('100.0000');
    expect(normalizeSupplierVatSelection(selection()).amountBasis).toBe('net');
  });
  it.each([undefined, 'auto', 'tax-free'])('requires explicit amount basis %s', amountBasis => {
    expect(() => normalizeSupplierVatSelection(selection({ amountBasis }))).toThrow();
  });
  it('rejects duplicate stable contract lines and unknown command fields', () => {
    const s = selection(); expect(() => normalizeSupplierVatSelection({ ...s, sources: [s.sources[0], s.sources[0]] })).toThrow();
    expect(() => normalizeSupplierVatSelection({ ...s, fakeIssued: true })).toThrow();
  });
  it.each(['0', '-1', '1.00001', '1e2', 100])('rejects invalid contract amount %s', contractAmount => {
    expect(() => normalizeSupplierVatSelection(selection({ sources: [{ ...selection().sources[0], contractAmount }] }))).toThrow();
  });
  it('checks the original VAT three columns with Decimal precision', () => {
    const original = supplierVatOriginal(vat({ netAmount: '999999999999.0001', taxRate: '0', taxAmount: '0', totalAmount: '999999999999.0001' }));
    expect(original.totalAmount).toBe('999999999999.0001');
    expect(() => supplierVatOriginal(vat({ totalAmount: '113.0001' }))).toThrow();
    expect(() => supplierVatOriginal(vat({ netAmount: '100', taxAmount: '13.0201', totalAmount: '113.0201' }))).toThrow();
  });
  it('does not invent Input supplier VAT from an Output or unknown party', () => {
    expect(() => supplierVatOriginal(vat({ direction: 'Output' }))).toThrow();
    expect(() => supplierVatOriginal(vat({ relationId: null }))).toThrow();
  });
  it('net allocations equal original net; AP always remains original gross', () => {
    const original = supplierVatOriginal(vat());
    assertSupplierVatAmounts(original, normalizeSupplierVatSelection(selection()));
    expect(() => assertSupplierVatAmounts(original, normalizeSupplierVatSelection(selection({ amountBasis: 'gross' })))).toThrow();
    assertSupplierVatAmounts(original, normalizeSupplierVatSelection(selection({ amountBasis: 'gross',
      sources: [{ ...selection().sources[0], contractAmount: '113' }] })));
    expect(original.totalAmount).toBe('113.0000');
  });
  it('preserves original parties and attachment references without guessing missing tax identity', () => {
    const original = supplierVatOriginal(vat({ sellerTaxNo: null }));
    expect(original.sellerTaxNo).toBeNull(); expect(original.attachments).toEqual(vat().attachments);
  });
  it('counts old revisions against the same stable line and rejects a basis flip', () => {
    const prior = [{ amountBasis: 'net' as const, contractAmount: '60.0000' }];
    expect(assertSupplierVatCapacity('100', '40', 'net', prior)).toEqual({ registeredAmount: '60.0000', remainingAmount: '40.0000' });
    expect(() => assertSupplierVatCapacity('100', '40.0001', 'net', prior)).toThrow();
    expect(() => assertSupplierVatCapacity('100', '1', 'gross', prior)).toThrow();
    expect(new Prisma.Decimal('60').plus('40').toFixed(4)).toBe('100.0000');
  });
});
