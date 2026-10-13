import { describe, expect, it, vi } from 'vitest';
import { renderServerDocument } from '../registry';
import type { ApprovalSignDocumentSnapshot } from '../../../approvals/approvalSignDocumentSnapshotService';
import { assembleQuotationDocData } from '../quotation';
import { QUOTATION_TEMPLATE_VERSION } from '../quotation';

const data = (customer: string) => ({ order: { id: 'o1', poNumber: 'PO-1', customer, status: 'Confirmed',
  dueDate: null, currency: 'USD', orderAmount: 12, deliveryTerms: 'FOB', paymentTerms: '30 days',
  salesContractNumber: null, finalContractNumber: null, shipToAddress: null, createdAt: 0 },
  customer: null, lines: [] });
const snapshot: ApprovalSignDocumentSnapshot = { schemaVersion: 1, kind: 'OrderConfirmation', sourceRef: 'o1',
  sourceIds: ['o1'], exporterProfileSource: { configId: 'global::company.exporterProfile', version: 0, updatedAt: null, isDefault: true }, templateVersion: 'oc-template-v1', exporterProfile: { nameEn: 'Frozen seller', addressEn: 'Frozen address' },
  data: data('Frozen customer'), exactSource: {}, sourceFingerprint: 'a'.repeat(64), contentFingerprint: 'b'.repeat(64) };

describe('approved document snapshot rendering', () => {
  it('renders the exact quotation source verified by the signer instead of an earlier independently loaded body', async () => {
    const quotation = assembleQuotationDocData({ id: 'q1', quotationNumber: 'QT-1', status: 'Approved', currency: 'USD',
      totalAmount: '12', issueDate: '2026-10-05', customerName: 'Reviewed customer', lines: [] });
    const earlier = { ...quotation, qt: { ...quotation.qt, customerName: 'Earlier customer', totalAmount: 99 } };
    const prisma: any = { systemConfig: { findUnique: vi.fn().mockResolvedValue(null) } };
    const html = await renderServerDocument(prisma, 'QUOT', earlier, {},
      { id: 'q1', type: 'Quotation', sourceRef: 'q1', signer: { quotationData: quotation } });
    expect(html).toContain('Reviewed customer');
    expect(html).not.toContain('Earlier customer');
    await expect(renderServerDocument(prisma, 'QUOT', earlier, {},
      { id: 'q2', type: 'Quotation', sourceRef: 'q2', signer: { quotationData: quotation } }))
      .rejects.toThrow('签署报价与当前单据来源不一致');
  });
  it('renders signed customer and exporter from the verified snapshot instead of later live values', async () => {
    const prisma: any = { systemConfig: { findUnique: vi.fn().mockRejectedValue(new Error('must not read live exporter')) } };
    const html = await renderServerDocument(prisma, 'OC', data('Later customer'), {},
      { id: 'o1', type: 'OrderConfirmation', sourceRef: 'o1', signer: { documentSnapshot: snapshot } });
    expect(html).toContain('Frozen customer');
    expect(html).toContain('Frozen seller');
    expect(html).not.toContain('Later customer');
    expect(prisma.systemConfig.findUnique).not.toHaveBeenCalled();
  });
  it('refuses a signed snapshot belonging to another source', async () => {
    await expect(renderServerDocument({} as any, 'OC', data('Later customer'), {},
      { id: 'o2', type: 'OrderConfirmation', sourceRef: 'o2', signer: { documentSnapshot: snapshot } }))
      .rejects.toThrow('签署快照与当前单据来源不一致');
  });
  it('renders an officially signed quotation only from its frozen document and seller profile', async () => {
    const prisma: any = { systemConfig: { findUnique: vi.fn().mockRejectedValue(new Error('must not read live seller profile')) } };
    const frozenQuote = { qt: { id: 'q1', quotationNumber: 'QT-FROZEN', status: '', currency: 'USD', totalAmount: 12.345,
      issueDate: '2026-10-05', validUntil: '2026-11-05', deliveryTerms: 'Frozen delivery term', paymentTerms: 'Frozen payment term',
      salesperson: 'Frozen salesperson', inquiryRef: 'INQ-FROZEN', notes: 'Frozen remark', customerName: 'Frozen buyer', customerCode: 'B-1' },
      lines: [{ lineNumber: 1, fabricCode: 'FAB-1', description: 'Frozen fabric', quantity: 3, unit: 'M', unitPrice: 4.1234,
        amount: 12.345, notes: null, imageUrl: null }] };
    const signedQuote: ApprovalSignDocumentSnapshot = { schemaVersion: 1, kind: 'Quotation', sourceRef: 'q1', sourceIds: ['q1'],
      templateVersion: QUOTATION_TEMPLATE_VERSION, clauses: { version: QUOTATION_TEMPLATE_VERSION, entries: [
        { no: 1, title: 'Delivery 交货', body: 'Frozen delivery term' }, { no: 2, title: 'Payment 付款', body: 'Frozen payment term' },
        { no: 3, title: 'Validity 有效期', body: '2026-10-05 ~ 2026-11-05' }, { no: 4, title: 'Remarks 备注', body: 'Frozen remark' },
      ] } as any,
      exporterProfile: { nameEn: 'Frozen quote seller', addressEn: 'Frozen quote address' },
      exporterProfileSource: { configId: 'global::company.exporterProfile', version: 9, updatedAt: '2026-10-01T00:00:00.000Z', isDefault: false },
      data: frozenQuote, exactSource: { quotation: { totalAmount: '12.345', lines: [{ unitPrice: '4.1234' }] } },
      sourceFingerprint: 'a'.repeat(64), contentFingerprint: 'b'.repeat(64) };
    const html = await renderServerDocument(prisma, 'QUOT', { ...frozenQuote, qt: { ...frozenQuote.qt, quotationNumber: 'QT-LIVE',
      customerName: 'Live buyer', deliveryTerms: 'Live delivery' } }, {},
      { id: 'q1', type: 'Quotation', sourceRef: 'q1', signer: { documentSnapshot: signedQuote } });
    expect(html).toContain('QT-FROZEN');
    expect(html).toContain('Frozen quote seller');
    expect(html).toContain('Frozen buyer');
    expect(html).toContain('Frozen delivery term');
    expect(html).not.toContain('QT-LIVE');
    expect(html).not.toContain('Live buyer');
    expect(prisma.systemConfig.findUnique).not.toHaveBeenCalled();
  });

  it('refreshes live seller data between unsigned quotation renders but never reads it for a signed snapshot', async () => {
    // Give this regression a fresh module-level SystemConfig service singleton.
    vi.resetModules();
    const { renderServerDocument: render } = await import('../registry');
    const configRow = (nameEn: string, addressEn: string, version: number) => ({
      id: 'global::company.exporterProfile', scope: 'global', key: 'company.exporterProfile', group: 'company',
      label: 'Exporter profile', valueType: 'json', value: { nameEn, addressEn }, encrypted: false, version,
      updatedBy: null, auditReason: null, description: null, meta: null, createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: BigInt(version),
    });
    const prisma: any = { systemConfig: { findUnique: vi.fn()
      .mockResolvedValueOnce(configRow('Seller at first render', 'First address', 1))
      .mockResolvedValueOnce(configRow('Seller at second render', 'Second address', 2)) } };
    const quoteData = assembleQuotationDocData({ id: 'q-live', quotationNumber: 'QT-LIVE', status: 'Draft', currency: 'USD',
      totalAmount: '12.345', issueDate: '2026-10-05', customerName: 'Buyer', lines: [] });

    const firstUnsigned = await render(prisma, 'QUOT', quoteData, {},
      { id: 'q-live', type: 'Quotation', sourceRef: 'q-live' });
    const secondUnsigned = await render(prisma, 'QUOT', quoteData, {},
      { id: 'q-live', type: 'Quotation', sourceRef: 'q-live' });
    expect(firstUnsigned).toContain('Seller at first render');
    expect(secondUnsigned).toContain('Seller at second render');
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(2);

    const frozenQuote = assembleQuotationDocData({ id: 'q-frozen', quotationNumber: 'QT-FROZEN', status: 'Approved', currency: 'USD',
      totalAmount: '12.345', issueDate: '2026-10-05', customerName: 'Frozen buyer', lines: [] });
    const signedSnapshot: ApprovalSignDocumentSnapshot = { schemaVersion: 1, kind: 'Quotation', sourceRef: 'q-frozen',
      sourceIds: ['q-frozen'], templateVersion: QUOTATION_TEMPLATE_VERSION,
      clauses: { version: QUOTATION_TEMPLATE_VERSION, entries: [], quantityTolerance: '0%', generalClause: '' },
      exporterProfile: { nameEn: 'Frozen signed seller', addressEn: 'Frozen signed address' },
      exporterProfileSource: { configId: 'global::company.exporterProfile', version: 0, updatedAt: null, isDefault: true },
      data: frozenQuote, exactSource: {}, sourceFingerprint: 'a'.repeat(64), contentFingerprint: 'b'.repeat(64) };
    const signed = await render(prisma, 'QUOT', quoteData, {},
      { id: 'q-frozen', type: 'Quotation', sourceRef: 'q-frozen', signer: { documentSnapshot: signedSnapshot } });
    expect(signed).toContain('Frozen signed seller');
    expect(signed).not.toContain('Seller at second render');
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(2);
  });
});
