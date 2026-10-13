import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { actor, storage, decimal } from './documentSourceStorage';
import { readShipmentDocumentSource, documentSourceFingerprint } from '../../shipping/shipmentDocumentSource';
import { assembleDocumentSetData } from '../../shipping/documentSetService';
import { readCiInvoiceSource, registerCanonicalCi, readAuthorizedCiDocument, listCiInvoiceSourcesForShipment, readHistoricalCiDocument } from '../ciInvoiceSource';
import { createCustomsService } from '../customsService';
import { generateTradeDocumentsFromShipment, renderTradeDocumentServerHtml, assertCiTradeDocumentArchive } from '../tradeDocumentLifecycleService';
import { renderServerDocument } from '../../templates/docTemplates/registry';
import { renderFinanceInvoiceDocument } from '../../templates/docTemplates/financeInvoice';
import { checkTripleConsistency } from '../tripleDocumentConsistency';
const options = { trustedActor: actor, sourceInvoiceId: 'INV', shipmentId: 'S', mode: 'register' as const };
const sourceOptions = { trustedActor: actor };
const counts = (s: ReturnType<typeof storage>) => [s.tables.tradeDocument.length, s.tables.documentVersion.length, s.tables.auditLog.length];
describe('current persisted shipment source — storage substitute only', () => {
  it('uses stable original line ID across different ordinals and split amount, plus exact carton item IDs', async () => {
    const s = storage(), result = await readShipmentDocumentSource(s.db, 'S', sourceOptions);
    expect(result.lines[0]).toMatchObject({ id: 'SL', orderLineId: 'OL', quantity: '20', unitPrice: '10', amount: '200' });
    expect(result.cartons[0].items[0]).toMatchObject({ id: 'I', shipmentLineId: 'SL', orderLineId: 'OL', quantity: '20' });
    expect(result.cartonCoverageComplete).toBe(true);
    const data = (await assembleDocumentSetData(s.db, 'S', sourceOptions)).data as any;
    expect(data.lines[0].amount).toBe('200'); expect(data.totals.amount).toBe('200'); expect(data.source.orderIds).toEqual(['O']);
  });
  it('keeps source 18,4 decimals exact, including null and zero', async () => {
    const s = storage(); s.tables.shipmentLine[0].quantity = decimal('99999999999999.9999'); s.tables.shipmentCartonItem = [];
    const result = await readShipmentDocumentSource(s.db, 'S', sourceOptions); expect(result.lines[0].quantity).toBe('99999999999999.9999');
    s.tables.shipmentLine[0].quantity = null; expect((await readShipmentDocumentSource(s.db, 'S', sourceOptions)).lines[0].quantity).toBeNull();
    s.tables.shipmentLine[0].quantity = decimal('0'); expect((await readShipmentDocumentSource(s.db, 'S', sourceOptions)).lines[0].quantity).toBe('0');
  });
  it('does not build whole-order goods when the actual shipment has no lines', async () => {
    const s = storage(); s.tables.shipmentLine = []; s.tables.shipmentCarton = []; s.tables.shipmentCartonItem = [];
    const data = (await assembleDocumentSetData(s.db, 'S', sourceOptions)).data as any;
    expect(data.lines).toEqual([]); expect(data.totals.quantity).toBeNull(); expect(data.totals.amount).toBeNull();
  });
  it.each(['foreign-item', 'excess-item', 'foreign-line', 'foreign-unit'])('rejects actual carton/line corruption %s', async fault => {
    const s = storage(); if (fault === 'foreign-item') s.tables.shipmentCartonItem[0].shipmentLineId = 'OTHER';
    if (fault === 'excess-item') s.tables.shipmentCartonItem[0].quantity = decimal('21');
    if (fault === 'foreign-line') s.tables.shipmentLine[0].orderLineId = 'MISSING';
    if (fault === 'foreign-unit') s.tables.shipmentLine[0].unit = 'yd';
    await expect(readShipmentDocumentSource(s.db, 'S', sourceOptions)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('never downgrades current modern sources to a legacy fallback when SPA is missing', async () => {
    const s = storage(); s.tables.productionBatch.push({ id: 'PB', orderId: 'O', orderLineId: 'OL', revision: 1, unit: 'm' });
    await expect(readShipmentDocumentSource(s.db, 'S', sourceOptions)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('validates every actual multi-order parent with existing fresh relation/L2, including late share withdrawal', async () => {
    const s = storage(); s.tables.userAccount[0].roles[0].roleId = 'role-sales';
    s.tables.relation.push({ id: 'FOREIGN', ownerId: 'other', salesRepIds: [], deletedAt: null });
    s.tables.order.push({ ...s.tables.order[0], id: 'O2', customerRelationId: 'FOREIGN' });
    s.tables.orderLine.push({ ...s.tables.orderLine[0], id: 'OL2', orderId: 'O2' });
    s.tables.shipmentOrderAllocation.push({ ...s.tables.shipmentOrderAllocation[0], id: 'A2', orderId: 'O2', orderLineId: 'OL2' });
    s.tables.shipmentLine.push({ ...s.tables.shipmentLine[0], id: 'SL2', orderLineId: 'OL2' });
    s.tables.teamMember.push({ id: 'TM', userId: 'u', teamId: 'T', leftAt: null });
    s.tables.teamDataGrant.push({ id: 'SHARE', teamId: 'T', entityType: 'relation', entityId: 'FOREIGN', revokedAt: null, team: { deletedAt: null } });
    expect((await readShipmentDocumentSource(s.db, 'S', sourceOptions)).orderIds).toEqual(['O','O2']);
    let triggered = false; s.setHook((model, operation) => { if (!triggered && model === 'shipmentCarton' && operation === 'findMany') { triggered = true; s.tables.teamDataGrant[0].revokedAt = new Date(); } });
    await expect(readShipmentDocumentSource(s.db, 'S', sourceOptions)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('current physical receipt scope and batch revision are exact, never foreign projection guesses', async () => {
    const s = storage(), scopeSnapshot = { orderId: 'O', scopeType: 'production_batch', productionBatchId: 'PB', revision: 1 };
    const fingerprint = documentSourceFingerprint(scopeSnapshot);
    s.tables.productionBatch.push({ id: 'PB', orderId: 'O', orderLineId: 'OL', revision: 1, unit: 'm', deletedAt: null });
    s.tables.shipmentProductionAllocation.push({ id: 'SPA', allocationId: 'A', shipmentId: 'S', orderId: 'O', orderLineId: 'OL', productionBatchId: 'PB', productionBatchRevision: 1,
      unit: 'm', plannedQty: decimal('20'), actualQty: decimal('20'), state: 'reserved', scopeSnapshot: { schemaVersion: 1, allocationVersion: 1,
        scopeType: 'production_batch', scopeKey: 'production_batch:PB', scopeFingerprint: fingerprint, scopeSnapshot,
        receiptAllocations: [{ stockReceiptId: 'SR', plannedQty: '20', actualQty: '20', unit: 'm' }] } });
    expect((await readShipmentDocumentSource(s.db, 'S', sourceOptions)).kind).toBe('physical');
    s.tables.productionBatch[0].revision = 2;
    await expect(readShipmentDocumentSource(s.db, 'S', sourceOptions)).rejects.toMatchObject({ code: 'CONFLICT' });
    s.tables.productionBatch[0].revision = 1; s.tables.shipmentProductionAllocation[0].scopeSnapshot.scopeFingerprint = 'FOREIGN';
    await expect(readShipmentDocumentSource(s.db, 'S', sourceOptions)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('honours the initiating ceiling even if current native grants are broader', async () => {
    const s = storage(); await expect(readShipmentDocumentSource(s.db, 'S', { trustedActor: { ...actor, permissionCeiling: ['shipments:read'] } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects stale expected actual source fingerprint', async () => {
    const s = storage(), before = await readShipmentDocumentSource(s.db, 'S', sourceOptions); s.tables.shipmentLine[0].quantity = decimal('21');
    await expect(readShipmentDocumentSource(s.db, 'S', { ...sourceOptions, expectedSourceFingerprint: before.fingerprint })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
describe('original Invoice CI source and canonical registration — storage substitute only', () => {
  it.each(['Issued','PartiallyPaid','Paid'])('accepts exact native Receivable %s; past due Issued remains eligible', async status => {
    const s = storage(); s.tables.invoice[0].status = status; const source = await readCiInvoiceSource(s.db, options);
    expect(source.invoice.amount).toBe('200'); expect(source.draft).toBe(false); expect(source.invoice.dueDate).toBe('2000-01-01');
  });
  it('selection GET returns all current exact eligible choices, Draft preview-only, without any writes', async () => {
    const s = storage(); s.tables.invoice.push({ ...s.tables.invoice[0], id: 'DRAFT', invoiceNumber: 'DRAFT-1', status: 'Draft' });
    s.tables.invoiceOrderAllocation.push({ ...s.tables.invoiceOrderAllocation[0], id: 'IOD', invoiceId: 'DRAFT' });
    const result = await listCiInvoiceSourcesForShipment(s.db, 'S', actor);
    expect(result.candidates.map(row => [row.sourceInvoiceId, row.canRegister])).toEqual([['DRAFT',false],['INV',true]]);
    expect(result.candidates.every(row => row.expectedSourceFingerprint.length > 20)).toBe(true); expect(counts(s)).toEqual([0,0,0]);
  });
  it('allows explicit Draft preview with label but never formal registration', async () => {
    const s = storage(); s.tables.invoice[0].status = 'Draft';
    expect((await readCiInvoiceSource(s.db, { ...options, mode: 'preview' })).draft).toBe(true);
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(counts(s)).toEqual([0,0,0]);
    expect(await renderFinanceInvoiceDocument(s.db, 'INV', { screen: true, trustedActor: actor, shipmentId: 'S' })).toContain('DRAFT PREVIEW');
  });
  it.each(['Proforma','Payable','Cancelled','missing'])('rejects ineligible original %s without numbering or finance writes', async variant => {
    const s = storage(); if (['Proforma','Payable'].includes(variant)) s.tables.invoice[0].type = variant;
    if (variant === 'Cancelled') s.tables.invoice[0].status = variant; if (variant === 'missing') s.tables.invoice = [];
    await expect(registerCanonicalCi(s.db, options)).rejects.toBeDefined(); expect(counts(s)).toEqual([0,0,0]); expect(s.calls.some(call => /invoice\.create|invoiceOrderAllocation\.create|orderShipmentBatch\.create/.test(call))).toBe(false);
  });
  it('requires exact actual financial batch; whole-order invoice cannot stand for a partial ticket', async () => {
    const s = storage(); s.tables.orderShipmentBatch[0].shipmentId = 'OTHER';
    await expect(readCiInvoiceSource(s.db, options)).rejects.toBeDefined(); s.tables.invoiceOrderAllocation[0].batchId = null;
    await expect(readCiInvoiceSource(s.db, options)).rejects.toMatchObject({ code: 'CONFLICT' });
    s.tables.shipmentLine[0].quantity = decimal('100'); s.tables.shipmentOrderAllocation[0].actualQty = decimal('100'); s.tables.shipmentCartonItem[0].quantity = decimal('100');
    expect((await readCiInvoiceSource(s.db, options)).invoice.id).toBe('INV');
  });
  it('does not select latest when two actual original invoices cover this ticket', async () => {
    const s = storage(); s.tables.invoice.push({ ...s.tables.invoice[0], id: 'INV2', invoiceNumber: 'FIN-002', createdAt: BigInt(99) });
    s.tables.invoiceOrderAllocation.push({ ...s.tables.invoiceOrderAllocation[0], id: 'IOA2', invoiceId: 'INV2' });
    await expect(readCiInvoiceSource(s.db, { trustedActor: actor, shipmentId: 'S', mode: 'register' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await readCiInvoiceSource(s.db, { ...options, sourceInvoiceId: 'INV2' })).invoice.id).toBe('INV2');
  });
  it('one actual Invoice can legitimately cover several shipment batches and original orders', async () => {
    const s = storage(); s.tables.shipment.push({ ...s.tables.shipment[0], id: 'S2', shipmentNumber: 'SH-002' });
    s.tables.shipmentOrderAllocation.push({ ...s.tables.shipmentOrderAllocation[0], id: 'A2', shipmentId: 'S2' });
    s.tables.shipmentLine.push({ ...s.tables.shipmentLine[0], id: 'SL2', shipmentId: 'S2' });
    s.tables.orderShipmentBatch.push({ ...s.tables.orderShipmentBatch[0], id: 'FB2', shipmentId: 'S2' });
    s.tables.invoiceOrderAllocation.push({ ...s.tables.invoiceOrderAllocation[0], id: 'IOA2', batchId: 'FB2' });
    const first = await registerCanonicalCi(s.db, options), second = await registerCanonicalCi(s.db, { ...options, shipmentId: 'S2' });
    expect(second.document.id).toBe(first.document.id); expect(second.created).toBe(false); expect(counts(s)).toEqual([1,1,2]);
  });
  it('writes one native document/v1/two mandatory original audits; replay returns original ID without new financial facts', async () => {
    const s = storage(), first = await registerCanonicalCi(s.db, options), replay = await registerCanonicalCi(s.db, options);
    expect(replay.document.id).toBe(first.document.id); expect(replay.document.documentNumber).toBe('FIN-001'); expect(replay.created).toBe(false);
    expect(counts(s)).toEqual([1,1,2]); expect(s.tables.documentVersion[0].content.ciSource.invoiceId).toBe('INV');
    expect(s.tables.auditLog.map(row => row.action).sort()).toEqual(['DOCUMENT_VERSION_CREATE','TRADE_DOCUMENT_CREATE']);
    expect(s.lockCalls.indexOf('Order')).toBeLessThan(s.lockCalls.indexOf('Invoice')); expect(s.lockCalls.indexOf('Invoice')).toBeLessThan(s.lockCalls.indexOf('TradeDocument'));
  });
  it.each(['originalAudit','version','partialReceipt','deletedDocument'])('does not recreate a damaged original %s', async fault => {
    const s = storage(); await registerCanonicalCi(s.db, options);
    if (fault === 'originalAudit') s.tables.auditLog.pop(); if (fault === 'version') s.tables.documentVersion = [];
    if (fault === 'partialReceipt') delete s.tables.documentVersion[0].content.ciSource; if (fault === 'deletedDocument') s.tables.tradeDocument[0].deletedAt = BigInt(99);
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(s.tables.tradeDocument).toHaveLength(1);
  });
  it('cannot replace a physically missing document when original creation audit remains', async () => {
    const s = storage(); await registerCanonicalCi(s.db, options); s.tables.tradeDocument = [];
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(s.tables.tradeDocument).toEqual([]);
  });
  it('rolls back document/version/all audits if mandatory original audit storage throws', async () => {
    const s = storage(); s.setHook((model, operation, result) => { if (model === 'auditLog' && operation === 'create' && result.action === 'TRADE_DOCUMENT_CREATE') throw Error('MANDATORY_AUDIT_UNAVAILABLE'); });
    await expect(registerCanonicalCi(s.db, options)).rejects.toThrow('MANDATORY_AUDIT_UNAVAILABLE'); expect(counts(s)).toEqual([0,0,0]);
  });
  it('after all original INSERTs, external native grant withdrawal rolls back all records', async () => {
    const s = storage(); let triggered = false; s.setHook((model, operation, result) => { if (!triggered && model === 'auditLog' && operation === 'create' && result.action === 'TRADE_DOCUMENT_CREATE') { triggered = true; s.revoke('invoices:read'); } });
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(triggered).toBe(true); expect(counts(s)).toEqual([0,0,0]);
  });
  it('after all native INSERTs, actual shared relation L2 withdrawal rolls back document/version/all audits', async () => {
    const s = storage(); s.tables.userAccount[0].roles[0].roleId = 'role-sales'; s.tables.relation[0].ownerId = 'other';
    s.tables.teamMember.push({ id: 'TM', userId: 'u', teamId: 'T', leftAt: null });
    s.tables.teamDataGrant.push({ id: 'SHARE', teamId: 'T', entityType: 'relation', entityId: 'R', revokedAt: null, team: { deletedAt: null } });
    let triggered = false; s.setHook((model, operation, result) => { if (!triggered && model === 'auditLog' && operation === 'create' && result.action === 'TRADE_DOCUMENT_CREATE') { triggered = true; s.tables.teamDataGrant[0].revokedAt = new Date(); } });
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(triggered).toBe(true); expect(counts(s)).toEqual([0,0,0]);
  });
  it('reuses actual Sample before Order/Line before physical and financial parent locks', async () => {
    const s = storage(); s.tables.sample.push({ id: 'SS', sourceOrderId: 'O', type: 'ship', deletedAt: null, status: 'approved', productAssetId: null });
    await registerCanonicalCi(s.db, options);
    expect(s.lockCalls.indexOf('Sample')).toBeGreaterThanOrEqual(0); expect(s.lockCalls.indexOf('Sample')).toBeLessThan(s.lockCalls.indexOf('Order'));
    expect(s.lockCalls.indexOf('Order')).toBeLessThan(s.lockCalls.indexOf('OrderLine')); expect(s.lockCalls.indexOf('Shipment')).toBeLessThan(s.lockCalls.indexOf('OrderShipmentBatch'));
    expect(s.lockCalls.indexOf('OrderShipmentBatch')).toBeLessThan(s.lockCalls.indexOf('Invoice'));
  });
  it('after original replay read, external grant withdrawal denies returning that original document', async () => {
    const s = storage(); await registerCanonicalCi(s.db, options); let triggered = false;
    s.setHook((model, operation) => { if (!triggered && model === 'tradeDocument' && operation === 'findUnique') { triggered = true; s.revoke('customs:write'); } });
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(counts(s)).toEqual([1,1,2]);
  });
  it('legacy linked history stays previewable with native access, without fabricating new source/audits', async () => {
    const s = storage(); s.tables.tradeDocument.push({ id: 'OLD', type: 'CommercialInvoice', documentNumber: 'FIN-001', sourceInvoiceId: 'INV', shipmentId: 'S', status: 'Draft', deletedAt: null });
    const originalSet = (await assembleDocumentSetData(s.db, 'S')).data;
    s.tables.documentVersion.push({ id: 'OLDV', documentId: 'OLD', version: 1, content: { documentSet: originalSet } });
    expect((await readAuthorizedCiDocument(s.db, 'OLD', { trustedActor: actor, mode: 'preview' })).source.invoice.id).toBe('INV');
    expect(await renderTradeDocumentServerHtml(s.db, s.tables.tradeDocument[0], { screen: true, trustedActor: actor })).toContain('FIN-001'); expect(counts(s)).toEqual([1,1,0]);
  });
  it('existing CI history preserves original snapshot after actual Shipment/batch changes and cancelled original Invoice', async () => {
    const s = storage(), registered = await registerCanonicalCi(s.db, options);
    s.tables.invoice[0].status = 'Cancelled'; s.tables.invoice[0].amount = decimal('999'); s.tables.shipment[0].status = 'Cancelled';
    s.tables.orderShipmentBatch[0].status = 'cancelled'; s.tables.shipmentLine[0].quantity = decimal('99');
    const history = await readHistoricalCiDocument(s.db, registered.document.id, { trustedActor: actor });
    expect(history.currentInvoice.status).toBe('Cancelled'); expect(history.sourceSnapshot!.invoice.amount).toBe('200');
    const html = await renderTradeDocumentServerHtml(s.db, registered.document, { screen: true, trustedActor: actor });
    expect(html).toContain('HISTORICAL COPY'); expect(html).toContain('原票已取消'); expect(html).toContain('200.00'); expect(html).not.toContain('999.00');
    await expect(registerCanonicalCi(s.db, options)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(renderFinanceInvoiceDocument(s.db, 'INV', { trustedActor: actor, shipmentId: 'S' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(counts(s)).toEqual([1,1,2]);
  });
  it.each(['invoice-missing','invoice-read-revoked','account-disabled','snapshot-damaged'])('history stays fail-closed for %s', async fault => {
    const s = storage(), registered = await registerCanonicalCi(s.db, options);
    if (fault === 'invoice-missing') s.tables.invoice = []; if (fault === 'invoice-read-revoked') s.revoke('invoices:read');
    if (fault === 'account-disabled') s.tables.userAccount[0].status = 'disabled';
    if (fault === 'snapshot-damaged') s.tables.documentVersion[0].content.ciSourceSnapshot.shipmentSources[0].lines[0].quantity = '999';
    await expect(readHistoricalCiDocument(s.db, registered.document.id, { trustedActor: actor })).rejects.toBeDefined(); expect(counts(s)).toEqual([1,1,2]);
  });
  it('identifiable original Orders remain L2-protected in historical reads after financial allocations are moved', async () => {
    const s = storage(), registered = await registerCanonicalCi(s.db, options); s.tables.userAccount[0].roles[0].roleId = 'role-sales';
    s.tables.relation[0].ownerId = 'other'; s.tables.invoiceOrderAllocation = []; s.tables.invoice[0].orderId = null; s.tables.shipment[0].orderId = null;
    await expect(readHistoricalCiDocument(s.db, registered.document.id, { trustedActor: actor })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('unlinked legacy historyscreen uses only original version and current original TD/source authority', async () => {
    const s = storage(), set = (await assembleDocumentSetData(s.db, 'S')).data;
    const doc = { id: 'OLD', type: 'CommercialInvoice', documentNumber: 'OLD-CI', sourceInvoiceId: null, shipmentId: 'S', orderId: 'O', status: 'Cancelled', deletedAt: null };
    s.tables.tradeDocument.push(doc); s.tables.documentVersion.push({ id: 'OLDV', documentId: 'OLD', version: 1, content: { documentSet: set } });
    s.revoke('invoices:read'); s.tables.shipment[0].status = 'Cancelled';
    const html = await renderTradeDocumentServerHtml(s.db, doc, { screen: true, trustedActor: actor });
    expect(html).toContain('HISTORICAL COPY'); expect(html).toContain('原财务来源未核验');
    await expect(renderTradeDocumentServerHtml(s.db, doc, { trustedActor: actor })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(counts(s)).toEqual([1,1,0]);
  });
  it('native existing file keeps historical readability after current source cancellation, but damaged file source proof rejects', async () => {
    const s = storage(), registered = await registerCanonicalCi(s.db, options), document = s.tables.tradeDocument[0];
    document.filePath = 'trade-documents/ci-EXISTING.pdf'; document.fileName = 'FIN-001-v1.pdf';
    const frozenSource = s.tables.documentVersion[0].content.ciSourceSnapshot;
    s.tables.auditLog.push({ id: 'FILE-AUD', action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: document.id,
      detail: { filePath: document.filePath, fileName: document.fileName, sourceInvoiceId: 'INV', sourceFingerprint: frozenSource.fingerprint, sourceSnapshot: frozenSource, sha: 'a'.repeat(64), fileSize: 10 } });
    s.tables.invoice[0].status = 'Cancelled'; s.tables.shipment[0].status = 'Cancelled'; s.tables.orderShipmentBatch[0].status = 'cancelled';
    await expect(assertCiTradeDocumentArchive(s.db, document, actor)).resolves.toBeUndefined();
    s.tables.auditLog[2].detail.sourceFingerprint = 'DAMAGED'; await expect(assertCiTradeDocumentArchive(s.db, document, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
describe('public CI bypass gates use original helpers — storage substitute only', () => {
  it('manual CI create cannot stand alone and another document cannot be edited into CI', async () => {
    const s = storage(), service = createCustomsService(s.db);
    await expect(service.createTradeDocument({ type: 'CommercialInvoice', totalAmount: 1 }, 'u')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    s.tables.tradeDocument.push({ id: 'OTHER', type: 'PackingList', status: 'Draft', deletedAt: null });
    await expect(service.updateTradeDocument('OTHER', { type: 'CommercialInvoice' }, 'u')).rejects.toMatchObject({ code: 'CONFLICT' }); expect(s.tables.tradeDocument[0].type).toBe('PackingList');
  });
  it('from-shipment no-source or ambiguous CI cannot fall back to standalone CI numbering', async () => {
    const s = storage(); s.tables.invoice = [];
    await expect(generateTradeDocumentsFromShipment(s.db, { shipmentId: 'S', types: ['CommercialInvoice','PackingList'], actorId: 'u', trustedActor: actor })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(counts(s)).toEqual([0,0,0]);
  });
  it('from-shipment registers canonical source with original Invoice number, skips the original later', async () => {
    const s = storage(), params = { shipmentId: 'S', types: ['CommercialInvoice' as const], actorId: 'u', trustedActor: actor, sourceInvoiceId: 'INV' };
    expect((await generateTradeDocumentsFromShipment(s.db, params)).created[0].documentNumber).toBe('FIN-001');
    expect((await generateTradeDocumentsFromShipment(s.db, params)).skipped[0].documentNumber).toBe('FIN-001'); expect(counts(s)).toEqual([1,1,2]);
  });
  it('raw registry CI never consumes a caller documentSet amount', async () => {
    const s = storage(); await expect(renderServerDocument(s.db, 'CI', { totals: { amount: 1 } })).rejects.toMatchObject({ code: 'CONFLICT' });
    const html = await renderServerDocument(s.db, 'CI', { totals: { amount: 1 } }, { screen: true }, { id: '', type: 'CommercialInvoice', sourceRef: null, sourceInvoiceId: 'INV', shipmentId: 'S', trustedActor: actor });
    expect(html).toContain('200.00'); expect(html).not.toContain('1,000.00');
  });
  it('CI renderer preserves actual 18,4 monetary digits and ignores the whole-order line net value', async () => {
    const s = storage(); s.tables.invoice[0].amount = decimal('99999999999999.9999');
    const html = await renderFinanceInvoiceDocument(s.db, 'INV', { trustedActor: actor, shipmentId: 'S' });
    expect(html).toContain('99,999,999,999,999.9999'); expect(html).toContain('POINT NINE NINE NINE NINE'); expect(html).not.toContain('1,000.00');
  });
  it('triple-document check never replaces missing original Invoice money with old CI snapshot amount', async () => {
    const s = storage(); s.tables.tradeDocument.push({ id: 'OLD', type: 'CommercialInvoice', shipmentId: 'S', status: 'Draft', documentNumber: 'OLD-CI', totalAmount: decimal('999'), currency: 'USD', sourceInvoiceId: null });
    const result = await checkTripleConsistency(s.db, 'S', { trustedActor: actor }); expect(result!.internal.invoiceAmount).toBeNull();
    expect(result!.internal.invoiceCurrency).toBeNull(); expect(result!.discrepancies.some(row => row.field === 'commercialInvoice.sourceInvoiceId')).toBe(true);
  });
});
