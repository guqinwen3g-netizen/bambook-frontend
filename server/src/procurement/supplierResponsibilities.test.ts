import { describe, expect, it } from 'vitest';
import type { SupplierContractTx, SupplierSourceProof } from './supplierContractAccess';
import { normalizeSupplierContractDraft } from './supplierContractPolicy';
import { assertSupplierLineResponsibilities } from './supplierContractStore';

const source: SupplierSourceProof = { orderId: 'O', orderLineId: 'L', businessLine: 'garment', mainApprovalId: 'A', mainApprovalFingerprint: 'a'.repeat(64), commercialFingerprint: 'f',
  commercial: { order: { id: 'O' }, line: { fulfillmentMode: 'cmt', cmtIncludedItems: ['Button'] } } };
const draft = (extra: Record<string, unknown> = {}) => normalizeSupplierContractDraft('purchase', { supplierRelationId: 'S', currency: 'CNY', orderDate: '2026-10-07',
  lines: [{ orderLineId: 'L', kind: 'Material', category: 'Trimmings', description: 'Actual trim', quantity: '1', unit: 'PC', unitPrice: '2',
    costItemName: 'Zipper', includedInCmtPrice: false, cmtIncludedItemsReviewed: ['Button'], ...extra }] });
describe('garment purchase responsibility', () => {
  it('permits an explicitly reviewed CMT item outside the recorded included scope', async () => {
    await expect(assertSupplierLineResponsibilities({} as SupplierContractTx, draft(), [source])).resolves.toBeUndefined();
  });
  it.each([{ costItemName: 'Button' }, { includedInCmtPrice: true }])('rejects actual included costs rather than claiming CMT always forbids procurement', async input => {
    await expect(assertSupplierLineResponsibilities({} as SupplierContractTx, draft(input), [source])).rejects.toMatchObject({ code: 'CMT_INCLUDED_COST' });
  });
  it('requires current explicit included-scope review and keeps fabric on its internal business path', async () => {
    await expect(assertSupplierLineResponsibilities({} as SupplierContractTx, draft({ cmtIncludedItemsReviewed: [] }), [source])).rejects.toMatchObject({ code: 'CMT_SCOPE_REVIEW_REQUIRED' });
    await expect(assertSupplierLineResponsibilities({} as SupplierContractTx, draft({ category: 'Fabric' }), [source])).rejects.toMatchObject({ code: 'INTERNAL_FABRIC_SOURCE_REQUIRED' });
  });
});
