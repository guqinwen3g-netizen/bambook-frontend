import { describe, expect, it, vi } from 'vitest';
import { createCustomsService } from './customsService';
import { createDocumentTemplateService } from './documentTemplateService';
import { appendTradeDocumentVersion, upsertDomainTradeDocument } from './tradeDocumentLifecycleService';

describe('all generic suppliers-document mutations are retired', () => {
  it.each(['create', 'update', 'delete', 'transition', 'version', 'append', 'upsert'])('%s cannot overwrite an approved original', async operation => {
    const document = { id: 'TD-native', type: 'PurchaseOrder', domain: 'procurement', status: 'Issued', sourceRef: 'supplier:purchase:PO:REV' };
    const db: any = { tradeDocument: { findFirst: vi.fn(async () => document), create: vi.fn(), update: vi.fn() },
      documentVersion: { findFirst: vi.fn(), create: vi.fn() }, auditLog: { create: vi.fn() } };
    db.$transaction = async (work: any) => work(db);
    const service = createCustomsService(db);
    const attempt = () => operation === 'create' ? service.createTradeDocument({ type: 'PurchaseOrder' }, 'actor')
      : operation === 'update' ? service.updateTradeDocument(document.id, { type: 'Other' }, 'actor')
      : operation === 'delete' ? service.deleteTradeDocument(document.id, 'actor')
      : operation === 'transition' ? service.transitionTradeDocumentStatus(document.id, 'Cancelled', 'actor')
      : operation === 'version' ? createDocumentTemplateService(db).createVersion(document.id, { content: { totalAmount: 1 } }, 'actor')
      : operation === 'append' ? appendTradeDocumentVersion(db, { documentId: document.id, content: { amount: 1 }, actorId: 'actor' })
      : upsertDomainTradeDocument(db, { domain: 'procurement', type: 'PurchaseOrder', sourceRef: 'PO', actorId: 'actor' });
    await expect(attempt()).rejects.toMatchObject({ statusCode: 409, code: 'NATIVE_SUPPLIER_DOCUMENT_REQUIRED' });
    expect(db.tradeDocument.create).not.toHaveBeenCalled(); expect(db.tradeDocument.update).not.toHaveBeenCalled();
    expect(db.documentVersion.create).not.toHaveBeenCalled(); expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
