import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipmentDocumentSource } from '../shipping/shipmentDocumentSource';
const mocked = vi.hoisted(() => ({ read: vi.fn(), lock: vi.fn(), actor: vi.fn(), number: vi.fn() }));
vi.mock('../shipping/shipmentDocumentSource', async importOriginal => ({
  ...await importOriginal<typeof import('../shipping/shipmentDocumentSource')>(),
  shipmentDocumentSourceInTx: mocked.read, lockShipmentDocumentSourcesInTx: mocked.lock, currentDocumentActor: mocked.actor,
}));
vi.mock('./tradeDocumentLifecycleService', () => ({ generateTradeDocumentNumber: mocked.number }));
import { buildBusinessShipmentCiSnapshot, validateBusinessCiSelection, writeBusinessShipmentCi } from './businessShipmentCi';

function source(): ShipmentDocumentSource {
  return { shipment: { id: 'S1' }, orders: [{ id: 'O1', status: 'Confirmed', finalContractNumber: 'SC1', currency: 'USD',
    customerRelationId: 'C1', billToName: 'Buyer', shipToName: 'Consignee', paymentInstrument: 'T/T', paymentTerms: 'Net 30', deliveryTerms: 'FOB' }],
    orderIds: ['O1'], lines: [{ id: 'SL1', orderId: 'O1', orderLineId: 'OL1', quantity: '3', unitPrice: '0.1', unit: 'PCS',
      productionBatchIds: ['B1'], originalOrderLine: { id: 'OL1', description: 'Cotton', materialCode: 'M1', specSnapshot: { width: 150 } } }],
    allocations: [{ id: 'A1', orderLineId: 'OL1', actualQty: '3', allocatedQty: '99', status: 'Confirmed' }],
    cartons: [], physical: [], batches: [], kind: 'physical', fingerprint: 'facts', allocationFingerprint: 'alloc', cartonCoverageComplete: true };
}
describe('business shipment CI authoritative snapshot', () => {
  it('uses actual shipment quantity and confirmed order price with decimal amounts', () => {
    const value = buildBusinessShipmentCiSnapshot(source(), { lineIds: ['SL1'] }, []);
    expect(value.totalAmount).toBe('0.3'); expect(value.lines[0].quantity).toBe('3');
    expect(value.contractNumber).toBe('SC1'); expect(value.deliveryTerms).toBe('FOB');
    expect(value.confirmedOrderSnapshot[0].status).toBe('Confirmed');
  });
  it('fingerprint excludes command metadata but freezes price changes', () => {
    const facts = source(), before = buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, []);
    expect(buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'], requestKey: 'key' } as any, []).sourceFingerprint).toBe(before.sourceFingerprint);
    facts.lines[0].unitPrice = '0.2';
    expect(buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, []).sourceFingerprint).not.toBe(before.sourceFingerprint);
  });
  it.each(['Pending', 'Alert'])('rejects nonconfirmed order status %s', status => {
    const facts = source(); facts.orders[0].status = status;
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
  });
  it('rejects predicted allocation and mismatch against actual allocations', () => {
    const facts = source(); facts.allocations[0].actualQty = null;
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
    facts.allocations[0].actualQty = '2';
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
  });
  it('rejects incomplete carton coverage and claim shipment substitution', () => {
    const facts = source(); facts.cartonCoverageComplete = false;
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
    facts.cartonCoverageComplete = true; facts.kind = 'claim';
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
  });
  it('requires all shipment lines in a contract package', () => {
    const facts = source(); facts.lines.push({ ...facts.lines[0], id: 'SL2' }); facts.allocations[0].actualQty = '6';
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
    expect(buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1', 'SL2'] }, []).totalAmount).toBe('0.6');
  });
  it('allows another contract package but rejects mixing packages', () => {
    const facts = source(); facts.orders.push({ ...facts.orders[0], id: 'O2', finalContractNumber: 'SC2' });
    facts.lines.push({ ...facts.lines[0], id: 'SL2', orderId: 'O2', orderLineId: 'OL2' });
    facts.allocations.push({ ...facts.allocations[0], id: 'A2', orderLineId: 'OL2' });
    expect(buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, []).contractNumber).toBe('SC1');
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1', 'SL2'] }, [])).toThrow();
  });
  it('refuses missing contractual terms and different consignee countries', () => {
    const facts = source(); facts.orders[0].paymentTerms = null;
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
    facts.orders[0].paymentTerms = 'Net 30';
    facts.orders.push({ ...facts.orders[0], id: 'O2', shipToCountry: 'Different' });
    facts.lines.push({ ...facts.lines[0], id: 'SL2', orderId: 'O2', orderLineId: 'OL2' });
    facts.allocations.push({ ...facts.allocations[0], id: 'A2', orderLineId: 'OL2' });
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1', 'SL2'] }, [])).toThrow();
  });
  it('requires registered unambiguous active LC and freezes it', () => {
    const facts = source(); facts.orders[0].paymentInstrument = 'L/C';
    const credit = { id: 'LC1', orderId: 'O1', lcNumber: 'LC-1', status: 'Issued', terms: 'Original terms' };
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [credit, { ...credit, id: 'LC2' }])).toThrow();
    expect(buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [credit]).letterOfCredit).toEqual(credit);
  });
  it.each(['30% T/T, 70% L/C', 'Ｌ／Ｃ'])('recognizes LC component in %s and refuses unknown status', instrument => {
    const facts = source(); facts.orders[0].paymentInstrument = instrument;
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [])).toThrow();
    expect(() => buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, [{ id: 'LC1', orderId: 'O1', lcNumber: 'LC-1', status: 'Unknown' }])).toThrow();
  });
  it('rejects client facts, identity overrides, duplicate and nonexistent lines', () => {
    for (const input of [{ lineIds: ['SL1'], amount: 4 }, { lineIds: ['SL1'], actorId: 'admin' }, { lineIds: ['SL1', 'SL1'] }, { lineIds: [4] }])
      expect(() => validateBusinessCiSelection(input)).toThrow();
    expect(() => buildBusinessShipmentCiSnapshot(source(), { lineIds: ['missing'] }, [])).toThrow();
  });
});

describe('business CI transactional producer', () => {
  const actor = { userId: 'U1' } as any;
  let tx: any, db: any, facts: ShipmentDocumentSource, command: any;
  beforeEach(() => {
    vi.resetAllMocks(); facts = source();
    mocked.actor.mockResolvedValue(actor); mocked.read.mockResolvedValue(facts); mocked.lock.mockResolvedValue([facts]); mocked.number.mockResolvedValue('CI-1');
    command = { lineIds: ['SL1'], requestKey: 'request-1', expectedSourceFingerprint: buildBusinessShipmentCiSnapshot(facts, { lineIds: ['SL1'] }, []).sourceFingerprint };
    tx = { $queryRaw: vi.fn(), letterOfCredit: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(({ data }) => data) },
      tradeDocument: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(({ data }) => data),
        findUnique: vi.fn(), update: vi.fn().mockImplementation(({ where, data }) => ({ id: where.id, ...data })), count: vi.fn().mockResolvedValue(0) },
      documentVersion: { create: vi.fn().mockImplementation(({ data }) => data), findFirst: vi.fn() },
      invoice: { findFirst: vi.fn().mockResolvedValue(null) } };
    db = { $transaction: vi.fn().mockImplementation(fn => fn(tx)) };
  });
  it('creates independent draft without reading finance contents', async () => {
    const result = await writeBusinessShipmentCi(db, 'S1', command, actor, 'draft');
    expect(result.item.sourceInvoiceId).toBeNull(); expect(result.item.sourceRef).toMatch(/^business-ci:v1:shipment:S1:/);
    expect(result.item.totalAmount).toBe('0.3'); expect(tx.invoice.findFirst).not.toHaveBeenCalled();
    expect(tx.auditLog.create.mock.calls[0][0].data.createdAt).toBeInstanceOf(Date);
    expect(mocked.actor).toHaveBeenCalledWith(tx, actor, ['customs:write', 'shipments:read', 'orders:read']);
  });
  it('fails before creation if fresh permissions or source fingerprint changes', async () => {
    mocked.actor.mockRejectedValueOnce(new Error('FORBIDDEN'));
    await expect(writeBusinessShipmentCi(db, 'S1', command, actor, 'draft')).rejects.toThrow('FORBIDDEN');
    await expect(writeBusinessShipmentCi(db, 'S1', { ...command, expectedSourceFingerprint: '0'.repeat(64) }, actor, 'draft')).rejects.toThrow();
    expect(tx.tradeDocument.create).not.toHaveBeenCalled();
  });
  it('replays same key and rejects a reused key for different inputs', async () => {
    const result = await writeBusinessShipmentCi(db, 'S1', command, actor, 'draft');
    tx.auditLog.findUnique.mockResolvedValue(tx.auditLog.create.mock.calls[0][0].data);
    tx.tradeDocument.findUnique.mockResolvedValue(result.item);
    expect((await writeBusinessShipmentCi(db, 'S1', command, actor, 'draft')).replayed).toBe(true);
    expect(tx.tradeDocument.create).toHaveBeenCalledTimes(1);
    await expect(writeBusinessShipmentCi(db, 'S1', { ...command, expectedSourceFingerprint: '0'.repeat(64) }, actor, 'draft')).rejects.toThrow();
  });
  it('issues immutable next version and checks financial number only', async () => {
    const draft = await writeBusinessShipmentCi(db, 'S1', command, actor, 'draft');
    tx.tradeDocument.findUnique.mockResolvedValue(draft.item);
    tx.documentVersion.findFirst.mockResolvedValue(tx.documentVersion.create.mock.calls[0][0].data);
    const result = await writeBusinessShipmentCi(db, 'S1', { ...command, requestKey: 'issue-1' }, actor, 'issue', draft.item.id);
    expect(result.item.status).toBe('Issued');
    const issued = tx.documentVersion.create.mock.calls[1][0].data;
    expect(issued.version).toBe(2); expect(issued.content.commercialInvoiceSnapshot.issuedBy).toBe('U1');
    expect(tx.invoice.findFirst).toHaveBeenCalledWith({ where: { invoiceNumber: 'CI-1' }, select: { id: true } });
  });
  it('blocks historical finance CI and stale draft instead of reinterpreting them', async () => {
    tx.tradeDocument.findUnique.mockResolvedValue({ status: 'Draft', type: 'CommercialInvoice', domain: 'customs', shipmentId: 'S1', sourceInvoiceId: 'INV1', sourceRef: 'invoice:INV1' });
    await expect(writeBusinessShipmentCi(db, 'S1', command, actor, 'issue', 'legacy')).rejects.toThrow();
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    const draft = await writeBusinessShipmentCi(db, 'S1', command, actor, 'draft');
    tx.tradeDocument.findUnique.mockResolvedValue(draft.item);
    tx.documentVersion.findFirst.mockResolvedValue({ version: 1, content: { commercialInvoiceSnapshot: { wrong: true } } });
    await expect(writeBusinessShipmentCi(db, 'S1', { ...command, requestKey: 'issue-1' }, actor, 'issue', draft.item.id)).rejects.toThrow();
    expect(tx.tradeDocument.update).not.toHaveBeenCalled();
  });
});
