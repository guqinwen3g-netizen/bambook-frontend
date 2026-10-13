import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
const auth = vi.hoisted(() => ({ getAuthState: vi.fn(), hasPermission: vi.fn(), subscribe: vi.fn() }));
const api = vi.hoisted(() => ({ getStoredConfig: vi.fn(), getAuthHeaders: vi.fn(), buildApiUrl: vi.fn() }));
vi.mock('./authService', () => auth); vi.mock('./apiService', () => ({ apiService: api }));
import { paymentRequestService as service } from './paymentRequestService';
import { listPendingFinanceCommands, retryPendingFinanceCommand } from './financeCommandRecovery';
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const response = (value: any, status = 200) => ({ ok: status < 400, status, json: async () => value });
const selected = { invoiceId: 'AP', requestedAmount: '40.0001', expectedSourceFingerprint: 'a'.repeat(64) };
const input: any = { supplierId: 'SUP', supplierName: '供应商', currency: 'CNY', totalAmount: '40.0001', sourceType: 'supplier_payable', payableSelections: [selected], expectedPaymentDate: '2026-10-09' };
function storage(): Storage { const rows = new Map<string, string>(); return { get length() { return rows.size; }, getItem: key => rows.get(key) ?? null,
  setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); }, clear: () => rows.clear(), key: index => [...rows.keys()][index] ?? null }; }
beforeEach(() => { vi.resetAllMocks(); auth.getAuthState.mockReturnValue({ isAuthenticated: true, user: { id: 'FIN', roles: ['finance'], permissions: ['finance:payment_request:create', 'invoices:read'] } });
  auth.hasPermission.mockReturnValue(true); api.getStoredConfig.mockReturnValue({ cloudEndpoint: 'https://native.invalid/api' }); api.getAuthHeaders.mockReturnValue({ Authorization: 'Bearer FIN' });
  api.buildApiUrl.mockImplementation((path, base) => base + path); vi.stubGlobal('localStorage', storage()); vi.stubGlobal('crypto', { randomUUID, subtle: webcrypto.subtle }); });
afterEach(() => vi.unstubAllGlobals());
it('binds exact AP selections to the original request and recovers after a lost acknowledgement without another approval intent', async () => {
  const writes: any[] = []; let committed: any;
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body); writes.push(body);
    if (!committed) {
      const paymentRequest = { id: 'PR', requestNumber: 'PAYR-1', supplierId: 'SUP', supplierName: '供应商', currency: 'CNY', totalAmount: '40.0001', status: 'Pending', approvalRequestId: 'APR', createdAt: '2026-10-08T00:18:00.000Z' };
      const resultSnapshot = { paymentRequest, approvalRequestId: 'APR', auditId: 'AUDIT' };
      committed = { ...resultSnapshot, financeCommand: { protocolVersion: 1, actorId: 'FIN', kind: 'payment_request.create', requestKey: body.requestKey,
        commandHash: hash({ kind: 'payment_request.create', input: body }), auditId: 'AUDIT', targetId: 'PR', resultSnapshot, resultHash: hash(resultSnapshot) } };
      throw Error('committed; ACK lost');
    }
    return response(committed);
  }));
  await expect(service.createPaymentRequest(input)).rejects.toThrow('ACK lost');
  await expect(service.createPaymentRequest({ ...input, payableSelections: [{ ...selected, requestedAmount: '41' }] })).rejects.toThrow('原请求');
  expect(writes).toHaveLength(1);
  expect(await retryPendingFinanceCommand(listPendingFinanceCommands()[0])).toMatchObject({ id: 'PR', approvalRequestId: 'APR' });
  expect(writes[1]).toEqual(writes[0]); expect(writes[0]).toMatchObject(input); expect(listPendingFinanceCommands()).toEqual([]);
});
it('rejects a candidate page containing another supplier or currency rather than offering it for selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ items: [{ invoiceId: 'AP', vatInvoiceId: 'VAT', invoiceNumber: 'INV', vatNumber: '0123', supplierId: 'OTHER',
    supplierName: '另一供应商', currency: 'CNY', contractNumbers: ['PO'], sourceFingerprint: 'a'.repeat(64), invoiceAmount: '100', appliedAmount: '0', remainingAmount: '100', reservedAmount: '0', availableAmount: '100' }], hasMore: false, nextCursor: null })));
  await expect(service.listPayableCandidates({ supplierId: 'SUP', currency: 'CNY' })).rejects.toThrow('清单尚未核实');
});
it.each(['list', 'detail', 'preview'])('rejects a slow prior actor %s read', async lane => {
  let finish!: (value: any) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const reading = lane === 'list' ? service.listPaymentRequests() : lane === 'detail' ? service.getPaymentRequest('PR') : service.getPaymentRequestPreviewHtml('PR');
  auth.getAuthState.mockReturnValue({ isAuthenticated: true, user: { id: 'FIN-B', roles: ['finance'], permissions: ['finance:payment_request:create', 'invoices:read'] } });
  finish({ ...response({ item: { id: 'PR', supplierName: 'A-private' }, items: [{ id: 'PR', supplierName: 'A-private' }] }), text: async () => 'A-private-preview' });
  await expect(reading).rejects.toThrow();
});
