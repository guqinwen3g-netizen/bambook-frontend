import { beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  currentDocumentActor: vi.fn(),
  authorizedDocumentOrders: vi.fn(),
  documentSourceFingerprint: vi.fn((value: unknown) => JSON.stringify(value)),
  isBusinessShipmentCi: vi.fn((document: any) => document?.type === 'CommercialInvoice'
    && document?.sourceInvoiceId == null && document?.sourceRef?.startsWith('business-ci:v1:shipment:') === true),
  readBusinessShipmentCiVersionInTx: vi.fn(),
  createInvoice: vi.fn(),
}));

vi.mock('../../shipping/shipmentDocumentSource', () => ({
  currentDocumentActor: seams.currentDocumentActor,
  authorizedDocumentOrders: seams.authorizedDocumentOrders,
  documentSourceFingerprint: seams.documentSourceFingerprint,
}));
vi.mock('../../customs/businessShipmentCiSnapshot', () => ({
  BUSINESS_SHIPMENT_CI_PREFIX: 'business-ci:v1:shipment:',
  isBusinessShipmentCi: seams.isBusinessShipmentCi,
  readBusinessShipmentCiVersionInTx: seams.readBusinessShipmentCiVersionInTx,
}));
vi.mock('../invoiceMutationService', () => ({ createInvoice: seams.createInvoice }));

import { registerIssuedBusinessCiReceivable, listPendingBusinessCiReceivables } from '../businessCiReceivableService';

const actor: any = { userId: 'finance-1', roles: ['finance'], permissions: ['invoices:read', 'invoices:write'] };
const normalLines = [
  { id: 'line-1', orderId: 'order-1', fabricSupplyMode: 'finished_purchase', fabricCommissionRate: null, fabricCommissionSupplierId: null },
  { id: 'line-2', orderId: 'order-2', fabricSupplyMode: 'finished_purchase', fabricCommissionRate: null, fabricCommissionSupplierId: null },
];
const orderLineDelegate = () => ({ findMany: vi.fn().mockResolvedValue(normalLines) });
function nativeSource(documentId: string, versionId = `v-${documentId}`) {
  const document = { id: documentId, type: 'CommercialInvoice', domain: 'customs', status: 'Issued',
    documentNumber: `CI-${documentId}`, shipmentId: `ship-${documentId}`, sourceInvoiceId: null,
    sourceRef: `business-ci:v1:shipment:ship-${documentId}:package`, issueDate: '2026-10-06', deletedAt: null };
  const snapshot = { protocolVersion: 1, sourceKind: 'shipment', shipmentId: `ship-${documentId}`, issuedAt: '1791234567890',
    issueDate: '2026-10-06', totalAmount: '125.50', currency: 'USD', customerRelationId: 'customer-1',
    parties: { billTo: { name: 'Example Buyer' } }, orderIds: ['order-1', 'order-2'], contractNumber: 'SC-1',
    lines: normalLines.map((line, index) => ({ ...line, orderLineId: line.id, amount: index === 0 ? '100.50' : '25.00' })) };
  const version = { id: versionId, documentId, version: 2 };
  return { document, version, latestVersion: version, snapshot };
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.currentDocumentActor.mockResolvedValue(actor);
  seams.authorizedDocumentOrders.mockResolvedValue([
    { id: 'order-1', code: 'SO-1', poNumber: 'PO-1' }, { id: 'order-2', code: 'SO-2', poNumber: 'PO-2' },
  ]);
  seams.readBusinessShipmentCiVersionInTx.mockImplementation(async (_tx: any, id: string) => nativeSource(id));
  seams.createInvoice.mockResolvedValue({ ok: true, data: { invoice: { id: 'AR-1', invoiceNumber: 'CI-doc-1', type: 'Receivable',
    status: 'Issued', amount: '125.50', currency: 'USD', sourceType: 'BusinessShipmentCI' }, replayed: false } });
});

describe('Finance registration of logistics-issued CI', () => {
  it('creates one receivable from the exact CI total and per-order shipment amounts', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), orderLine: orderLineDelegate(), invoice: { findFirst: vi.fn().mockResolvedValue(null) } };
    const prisma: any = { ...tx, $transaction: vi.fn(async (work: any) => work(tx)) };
    const result = await registerIssuedBusinessCiReceivable(prisma, 'doc-1', actor, actor.userId, '127.0.0.1');

    expect(result).toMatchObject({ invoice: { id: 'AR-1' }, replayed: false });
    expect(seams.createInvoice).toHaveBeenCalledOnce();
    const call = seams.createInvoice.mock.calls[0][0];
    expect(call.input).toMatchObject({ invoiceNumber: 'CI-doc-1', type: 'Receivable', status: 'Issued', amount: '125.50',
      currency: 'USD', customerRelationId: 'customer-1', customerName: 'Example Buyer', orderId: null,
      sourceType: 'BusinessShipmentCI', sourceId: 'v-doc-1',
      orderAllocations: [
        { orderId: 'order-1', allocatedAmount: '100.5' }, { orderId: 'order-2', allocatedAmount: '25' },
      ] });
    expect(call.businessCiRegistration).toMatchObject({ documentId: 'doc-1', versionId: 'v-doc-1' });
    expect(call.actor).toEqual(actor);
    expect(tx.orderLine.findMany).toHaveBeenCalledWith({ where: { id: { in: ['line-1', 'line-2'] } } });
  });

  it('retries idempotently when that issued version is already recorded', async () => {
    const existing = { id: 'AR-1', invoiceNumber: 'CI-doc-1', amount: '125.50', currency: 'USD', customerRelationId: 'customer-1', deletedAt: null };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), orderLine: orderLineDelegate(), invoice: { findFirst: vi.fn().mockResolvedValue(existing) } };
    const prisma: any = { ...tx, $transaction: vi.fn(async (work: any) => work(tx)) };
    const result = await registerIssuedBusinessCiReceivable(prisma, 'doc-1', actor, actor.userId);
    expect(result).toEqual({ invoice: existing, replayed: true });
    expect(seams.createInvoice).not.toHaveBeenCalled();
  });

  it('lists pending issued CIs after filtering registered sources, then paginates the pending list', async () => {
    const docs = ['doc-1', 'doc-2', 'doc-3'].map(id => nativeSource(id).document);
    const prisma: any = {
      tradeDocument: { findMany: vi.fn().mockResolvedValue(docs) },
      documentVersion: { findMany: vi.fn().mockResolvedValue(docs.map(doc => ({ id: `v-${doc.id}`, documentId: doc.id }))) },
      invoice: { findMany: vi.fn().mockResolvedValue([{ sourceId: 'v-doc-1' }]) },
      orderLine: orderLineDelegate(),
      $transaction: vi.fn(async (work: any) => work({})),
    };
    seams.readBusinessShipmentCiVersionInTx.mockImplementation(async (_tx: any, id: string) => nativeSource(id));

    const page = await listPendingBusinessCiReceivables(prisma, actor, { offset: 1, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ documentId: 'doc-3', documentNumber: 'CI-doc-3', amount: '125.50', currency: 'USD' });
    expect(seams.readBusinessShipmentCiVersionInTx).toHaveBeenCalledTimes(2);
  });
});
