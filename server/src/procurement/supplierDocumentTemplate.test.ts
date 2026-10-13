import { describe, expect, it } from 'vitest';
import { normalizeSupplierContractDraft, supplierFingerprint, supplierJson } from './supplierContractPolicy';
import { renderSupplierCommitmentBody } from '../templates/docTemplates/processingContract';
import type { ServerSupplierContractDocumentData } from '../templates/docTemplates/types';

function fixture(): ServerSupplierContractDocumentData {
  const draft = normalizeSupplierContractDraft('purchase', { supplierRelationId: 'SUP', currency: 'CNY', paymentTerms: 'T/T', orderDate: '2026-10-07',
    mainDeliveryLocation: { kind: 'external', name: 'Receiver', address: '<script>destination</script>' },
    lines: [{ id: 'PL', orderLineId: 'OL', kind: 'Material', category: 'Fabric', description: '<img onerror="attack()">', specification: 'Exact independent spec',
      quantity: '90071992547409.0999', unit: 'M', unitPrice: '1', requestedDeliveryDate: '2099-01-01' }] });
  const snapshot = supplierJson({ ...draft, schemaVersion: 1, businessOwnerId: 'BUS', supplierParty: { name: '<script>supplier</script>' }, basedOnRevisionId: null, changeReason: null,
    sourceProofs: [{ orderId: 'ORDER', orderLineId: 'OL', businessLine: 'fabric', mainApprovalId: 'APP', mainApprovalFingerprint: 'a'.repeat(64), commercialFingerprint: 'c'.repeat(64),
      commercial: { order: { code: 'FAB-001', poNumber: 'External PO independent' } } }] });
  return { supplierContractDocumentProtocol: 1, document: { contractId: 'PO', contractKind: 'purchase', number: 'PUR-001', revisionId: 'REV', revision: 3,
    contentFingerprint: supplierFingerprint(snapshot), approvedAt: '1', historical: false, snapshot, sourceRef: 'supplier:purchase:PO:REV' } };
}
describe('supplier formal document templates', () => {
  it('preserves exact Decimal strings, independent internal/external references, approved revision and escaped real content', () => {
    const html = renderSupplierCommitmentBody(fixture(), {}, 'purchase');
    expect(html).toContain('90071992547409.0999'); expect(html).toContain('PUR-001-R3'); expect(html).toContain('FAB-001'); expect(html).toContain('External PO independent');
    expect(html).toContain('购货单价'); expect(html).toContain('REV'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img onerror');
  });
  it('refuses another contract type or a snapshot with a changed approved fingerprint', () => {
    expect(() => renderSupplierCommitmentBody(fixture(), {}, 'processing')).toThrow('准确不可变批准依据');
    const data = fixture(); data.document.contentFingerprint = 'f'.repeat(64);
    expect(() => renderSupplierCommitmentBody(data, {}, 'purchase')).toThrow('准确不可变批准依据');
  });
});
