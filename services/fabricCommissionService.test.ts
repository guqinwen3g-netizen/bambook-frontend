// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fabricCommissionService as service, fabricCommissionReceiptParty, fabricSupplyTermsError, isFabricCommissionInvoice } from './fabricCommissionService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';

const m = vi.hoisted(() => ({ actor: 'BUSINESS', scopes: ['orders:read', 'orders:write', 'invoices:read', 'invoices:write'], endpoint: 'https://test.invalid', listeners: new Set<() => void>() }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true, user: { id: m.actor, permissions: m.scopes, roles: [], permissionCeiling: m.scopes } }),
  hasPermission: (scope: string) => m.scopes.includes(scope), subscribe: (listener: () => void) => { m.listeners.add(listener); return () => { m.listeners.delete(listener); }; } }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: m.endpoint }), getAuthHeaders: () => ({ Authorization: `Bearer ${m.actor}` }),
  buildApiUrl: (path: string, endpoint = m.endpoint) => `${endpoint}/api${path}` } }));
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function source(orderId = 'ORDER') {
  const facts = { schemaVersion: 1, sourceType: 'FabricCommissionCI', orderId, orderNumber: 'SO-REAL', poNumber: null, customerId: 'CUSTOMER', currency: 'USD',
    approvalId: 'APPROVAL', approvalAuditId: 'APPROVAL-AUDIT', approvalFingerprint: 'a'.repeat(64),
    financialLines: [{ id: 'LINE', orderId, specSnapshot: { GSM: '150', density: 'Actual source' }, fabricSupplyMode: 'commission', fabricCommissionRate: '5', fabricCommissionSupplierId: 'SUPPLIER' }],
    branches: [{ id: 'BATCH', orderLineId: 'LINE', revision: 2, actualQuantity: '100.0000', shippedQuantity: '100.0000', unit: 'M' }],
    shipments: [{ shipmentId: 'SHIP', shipmentLineId: 'SHIP-LINE', orderLineId: 'LINE', quantity: '100.0000', unit: 'M', state: 'shipped', atd: '2026-10-08' }],
    departureEvents: [{ id: 'ATD', shipmentId: 'SHIP', atd: '2026-10-08', commandHash: 'b'.repeat(64) }],
    groups: [{ supplierId: 'SUPPLIER', party: { id: 'SUPPLIER', name: 'Actual supplier', address: null, taxId: null }, goodsAmount: '1000.0000', commissionAmount: '50.0000',
      lines: [{ orderLineId: 'LINE', description: 'Actual cotton', actualQuantity: '100.0000', unit: 'M', unitPrice: '10.0000', actualGoodsAmount: '1000.0000', rate: '5', commissionAmount: '50.0000', shipmentLineIds: ['SHIP-LINE'] }] }] };
  return { ...facts, sourceFingerprint: hash(facts) };
}
function original() {
  const facts = source(), receipt = { settlementId: 'SETTLEMENT', orderId: facts.orderId, sourceFingerprint: facts.sourceFingerprint, auditId: 'SETTLEMENT', requestKey: 'ORIGINAL',
    documents: [{ supplierId: 'SUPPLIER', documentId: 'DOC', versionId: 'VERSION', documentNumber: 'CI-ORIGINAL', amount: '50.0000', currency: 'USD' }] };
  return { document: { id: 'DOC', orderId: 'ORDER', documentNumber: 'CI-ORIGINAL', domain: 'finance', type: 'CommercialInvoice', status: 'Issued', totalAmount: '50', currency: 'USD', relationId: 'SUPPLIER', sourceRef: 'fabric-commission:v1:ORDER:SUPPLIER', issueDate: '2026-10-08' },
    version: { id: 'VERSION', documentId: 'DOC', version: 1 }, snapshot: { schemaVersion: 1, sourceType: 'FabricCommissionCI', settlementId: 'SETTLEMENT', source: facts, supplierId: 'SUPPLIER', issueDate: '2026-10-08', dueDate: null, issuedAt: '1791418680000', issuedBy: 'BUSINESS', exporterSnapshot: {} }, group: facts.groups[0], receipt };
}
function acknowledgement(kind: string, input: Record<string, unknown>, result: Record<string, unknown>) {
  return { ...result, financeCommand: { protocolVersion: 1, actorId: m.actor, kind, requestKey: input.requestKey, commandHash: hash({ kind, input }),
    auditId: result.auditId, targetId: kind.endsWith('register') ? 'INVOICE' : null, resultHash: hash(result), resultSnapshot: result } };
}
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
function settleAck(init?: RequestInit) {
  const input = { orderId: 'ORDER', ...JSON.parse(String(init?.body)) }, doc = original();
  return acknowledgement('fabric_commission.settle', input, { receipt: { ...doc.receipt, requestKey: input.requestKey }, documents: [doc], auditId: 'SETTLEMENT', replayed: false });
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn()); vi.stubGlobal('crypto', webcrypto); m.actor = 'BUSINESS'; m.endpoint = 'https://test.invalid'; m.scopes = ['orders:read', 'orders:write', 'invoices:read', 'invoices:write']; });
afterEach(() => vi.unstubAllGlobals());

it('keeps unknown terms unknown and rejects an incomplete commission draft before creating an order', () => {
  expect(fabricSupplyTermsError({})).toBeNull();
  for (const rate of [null, '', '0', '-1', '101', '5.00001', '0.05%']) expect(fabricSupplyTermsError({ fabricSupplyMode: 'commission', fabricCommissionRate: rate, fabricCommissionSupplierId: 'SUPPLIER' })).toContain('佣金率');
  expect(fabricSupplyTermsError({ fabricSupplyMode: 'commission', fabricCommissionRate: '5' })).toContain('付款供应商');
  expect(fabricSupplyTermsError({ fabricSupplyMode: 'commission', fabricCommissionRate: '0.0001', fabricCommissionSupplierId: 'SUPPLIER' })).toBeNull();
});
it('recognizes only a complete native commission AR as the locked supplier receipt party', () => {
  const native = { id: 'AR', sourceType: 'FabricCommissionCI', sourceId: 'VERSION', type: 'Receivable', status: 'PartiallyPaid', orderId: 'ORDER', customerRelationId: 'SUPPLIER', customerName: 'Actual supplier', currency: 'USD' };
  expect(fabricCommissionReceiptParty(native)).toEqual({ invoiceId: 'AR', versionId: 'VERSION', orderId: 'ORDER', supplierId: 'SUPPLIER', supplierName: 'Actual supplier', currency: 'USD' });
  expect(isFabricCommissionInvoice(native)).toBe(true); expect(fabricCommissionReceiptParty({ ...native, sourceType: 'BusinessShipmentCI' })).toBeNull();
  expect(fabricCommissionReceiptParty({ ...native, sourceId: null })).toBeNull(); expect(fabricCommissionReceiptParty({ ...native, customerRelationId: null })).toBeNull();
  expect(fabricCommissionReceiptParty({ ...native, type: 'Payable' })).toBeNull();
});

it('reads the exact whole-order source and rejects mismatched source content', async () => {
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, settled: false, source: source(), sourceFingerprint: source().sourceFingerprint }));
  expect((await service.read('ORDER')).settled).toBe(false);
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, settled: false, source: source('OTHER'), sourceFingerprint: source('OTHER').sourceFingerprint }));
  await expect(service.read('ORDER')).rejects.toThrow('来源');
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, settled: false, source: { ...source(), currency: 'CNY' }, sourceFingerprint: source().sourceFingerprint }));
  await expect(service.read('ORDER')).rejects.toThrow('指纹');
});
it('retains the original key, source and content after a lost ACK, including a later read-only retry', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(Error('ACK disconnected'));
  await expect(service.settle('ORDER', { expectedSourceFingerprint: source().sourceFingerprint, dueDate: null, note: 'actual terms' })).rejects.toThrow('ACK disconnected');
  const pending = service.pendingSettlement('ORDER')!;
  expect(pending.payload.input.note).toBe('actual terms');
  m.scopes = ['orders:read'];
  vi.mocked(fetch).mockImplementation(async (_url, init) => response({ ok: true, ...settleAck(init) }));
  const result = await service.retrySettlement('ORDER');
  expect(result.receipt.requestKey).toBe(pending.requestId); expect(service.pendingSettlement('ORDER')).toBeNull();
  const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
  expect(sent).toEqual({ ...pending.payload.input, requestKey: pending.requestId });
});
it('keeps an unresolved intent on forbidden retry or an ACK for another key', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ ok: false, error: { message: 'revoked' } }, 403));
  await expect(service.settle('ORDER', { expectedSourceFingerprint: source().sourceFingerprint })).rejects.toThrow('revoked');
  const key = service.pendingSettlement('ORDER')!.requestId;
  vi.mocked(fetch).mockImplementation(async (_url, init) => response({ ok: true, ...settleAck({ ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body)), requestKey: crypto.randomUUID() }) }) }));
  await expect(service.retrySettlement('ORDER')).rejects.toThrow('回执');
  expect(service.pendingSettlement('ORDER')!.requestId).toBe(key);
});
it('rejects altered command content and scopes recovery to the actual actor and endpoint', async () => {
  vi.mocked(fetch).mockRejectedValue(Error('unknown'));
  await expect(service.settle('ORDER', { expectedSourceFingerprint: source().sourceFingerprint })).rejects.toThrow('unknown');
  await expect(service.settle('ORDER', { expectedSourceFingerprint: 'c'.repeat(64) })).rejects.toThrow('原内容');
  expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  m.actor = 'OTHER'; expect(service.pendingSettlement('ORDER')).toBeNull();
  m.actor = 'BUSINESS'; m.endpoint = 'https://other.invalid'; expect(service.pendingSettlement('ORDER')).toBeNull();
});
it('does not start a new settlement or expose stale data without the actual scope', async () => {
  m.scopes = ['orders:read'];
  await expect(service.settle('ORDER', { expectedSourceFingerprint: source().sourceFingerprint })).rejects.toThrow('权限');
  expect(service.pendingSettlement('ORDER')).toBeNull(); expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  vi.mocked(fetch).mockImplementation(async () => { m.actor = 'OTHER'; return response({ ok: true, settled: false, source: source(), sourceFingerprint: source().sourceFingerprint }); });
  await expect(service.read('ORDER')).rejects.toThrow('变化');
});
it('does not publish a slow source after an observed A to B to A identity transition', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  const pending = service.read('ORDER');
  m.actor = 'OTHER'; m.listeners.forEach(listener => listener()); m.actor = 'BUSINESS'; m.listeners.forEach(listener => listener());
  finish(response({ ok: true, settled: false, source: source(), sourceFingerprint: source().sourceFingerprint }));
  await expect(pending).rejects.toThrow('变化');
});
it('observes same-tab saveConfig endpoint events so a slow A to B to A source cannot revive', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  const pending = service.read('ORDER');
  m.endpoint = 'https://other.invalid'; window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT)); m.endpoint = 'https://test.invalid'; window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT));
  finish(response({ ok: true, settled: false, source: source(), sourceFingerprint: source().sourceFingerprint }));
  await expect(pending).rejects.toThrow('变化');
});
it('registers only the exact original version, payer, commission amount and source', async () => {
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, ...original(), invoice: null }));
  const doc = await service.document('DOC');
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const input = { documentId: 'DOC', ...JSON.parse(String(init?.body)) };
    return response({ ok: true, ...acknowledgement('fabric_commission.register', input, { ...original(), invoice: { id: 'INVOICE', invoiceNumber: 'CI-ORIGINAL', type: 'Receivable', status: 'Issued', amount: '50', currency: 'USD', customerRelationId: 'SUPPLIER', customerName: 'Actual supplier', sourceType: 'FabricCommissionCI', sourceId: 'VERSION', orderId: 'ORDER' }, auditId: 'AR-AUDIT', replayed: false }) });
  });
  expect((await service.register(doc)).invoice.customerRelationId).toBe('SUPPLIER');
  expect(service.pendingRegistrations()).toHaveLength(0);
});
it('keeps a registration after an ACK that disguises goods value or another version', async () => {
  vi.mocked(fetch).mockResolvedValue(response({ ok: true, ...original(), invoice: null }));
  const doc = await service.document('DOC');
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const input = { documentId: 'DOC', ...JSON.parse(String(init?.body)) };
    return response({ ok: true, ...acknowledgement('fabric_commission.register', input, { ...original(), invoice: { id: 'INVOICE', invoiceNumber: 'CI-ORIGINAL', type: 'Receivable', status: 'Issued', amount: '1000', currency: 'USD', customerRelationId: 'CUSTOMER', customerName: 'Buyer', sourceType: 'FabricCommissionCI', sourceId: 'OTHER-VERSION', orderId: 'ORDER' }, auditId: 'AR-AUDIT', replayed: false }) });
  });
  await expect(service.register(doc)).rejects.toThrow('原票'); expect(service.pendingRegistrations()).toHaveLength(1);
});
