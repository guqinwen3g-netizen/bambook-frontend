import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
const auth = vi.hoisted(() => ({ getAuthState: vi.fn(), hasPermission: vi.fn(), subscribe: vi.fn(), listeners: new Set<() => void>() }));
const api = vi.hoisted(() => ({ getStoredConfig: vi.fn(), getAuthHeaders: vi.fn(), buildApiUrl: vi.fn() }));
vi.mock('./authService', () => auth); vi.mock('./apiService', () => ({ apiService: api }));
import { supplierVatPayableService as service } from './supplierVatPayableService';
import { listPendingFinanceCommands, retryPendingFinanceCommand } from './financeCommandRecovery';
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const response = (value: any, status = 200) => ({ ok: status < 400, status, json: async () => value });
const selection: any = { amountBasis: 'net', dueDate: '2026-11-08', sources: [{ contractKind: 'purchase', contractId: 'PO', commitmentRevisionId: 'REV', lineId: 'L', contractAmount: '100' }] };
const preview: any = { vatUpdatedAt: '2', sourceFingerprint: 'a'.repeat(64), capacities: [{ contractKind: 'purchase', contractId: 'PO', lineId: 'L', approvedLineAmount: '100', registeredAmount: '0', remainingAmount: '100' }],
  snapshot: { schemaVersion: 1, sourceType: 'SupplierVatPayable', vatOriginal: { id: 'VAT', vatNumber: '0123', relationId: 'SUP', sellerName: '供应商', currency: 'CNY', netAmount: '100', taxAmount: '13', totalAmount: '113' },
    ...selection, sources: selection.sources.map((line: any) => ({ ...line, contractAmount: '100.0000', contractNumber: 'PO-1', orderId: 'O', orderLineId: 'OL', approvedLineAmount: '100' })), orderIds: ['O'], sourceFingerprint: 'a'.repeat(64) } };
let user: any;
function storage(): Storage { const data = new Map<string, string>(); return { get length() { return data.size; }, getItem: key => data.get(key) ?? null,
  setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, clear: () => data.clear(), key: index => [...data.keys()][index] ?? null }; }
beforeEach(() => {
  vi.resetAllMocks(); user = { isAuthenticated: true, user: { id: 'FIN', roles: ['finance'], permissions: ['invoices:read', 'invoices:write', 'vat:read'] } };
  auth.getAuthState.mockImplementation(() => user); auth.hasPermission.mockImplementation(scope => user.user.permissions.includes(scope));
  auth.subscribe.mockImplementation(listener => { auth.listeners.add(listener); return () => auth.listeners.delete(listener); });
  api.getStoredConfig.mockReturnValue({ cloudEndpoint: 'https://native.invalid/api' }); api.getAuthHeaders.mockImplementation(() => ({ Authorization: `Bearer ${user.user.id}` }));
  api.buildApiUrl.mockImplementation((path, base) => base + path); vi.stubGlobal('localStorage', storage()); vi.stubGlobal('crypto', { randomUUID, subtle: webcrypto.subtle });
});
afterEach(() => vi.unstubAllGlobals());
it('registers exact previewed original VAT and source without posting a self-reported invoice or internal VAT id', async () => {
  let body: any;
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any = {}) => {
    body = JSON.parse(init.body);
    const invoice = { id: 'AP', invoiceNumber: 'SVAT-VAT', type: 'Payable', status: 'Issued', amount: '113', currency: 'CNY', sourceType: 'SupplierVatPayable', sourceId: 'VAT' };
    const resultSnapshot = { invoice, auditId: 'AUDIT' };
    return response({ invoice, financeCommand: { protocolVersion: 1, actorId: 'FIN', kind: 'supplier_vat_payable.register', requestKey: body.requestKey,
      commandHash: hash({ kind: 'supplier_vat_payable.register', input: { vatInvoiceId: 'VAT', ...body } }), auditId: 'AUDIT', targetId: 'AP', resultSnapshot, resultHash: hash(resultSnapshot) } });
  }));
  expect(await service.register('VAT', selection, preview)).toMatchObject({ id: 'AP', amount: '113' });
  expect(body).toMatchObject({ ...selection, sources: [{ ...selection.sources[0], contractAmount: '100.0000' }], expectedVatUpdatedAt: '2', expectedSourceFingerprint: 'a'.repeat(64) });
  expect(body).not.toHaveProperty('vatInvoiceId'); expect(body).not.toHaveProperty('invoice'); expect(listPendingFinanceCommands()).toEqual([]);
});
it('retains the original VAT version and selected line across lost ACK, rejects replacing the selection, and restores its original receipt', async () => {
  const writes: any[] = []; let receipt: any;
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body); writes.push(body);
    if (!receipt) {
      const invoice = { id: 'AP', invoiceNumber: 'SVAT-VAT', type: 'Payable', status: 'Issued', amount: '113', currency: 'CNY' }, resultSnapshot = { invoice, auditId: 'AUDIT' };
      receipt = { invoice, financeCommand: { protocolVersion: 1, actorId: 'FIN', kind: 'supplier_vat_payable.register', requestKey: body.requestKey,
        commandHash: hash({ kind: 'supplier_vat_payable.register', input: { vatInvoiceId: 'VAT', ...body } }), auditId: 'AUDIT', targetId: 'AP', resultSnapshot, resultHash: hash(resultSnapshot) } };
      throw Error('committed; acknowledgement lost');
    }
    return response(receipt);
  }));
  await expect(service.register('VAT', selection, preview)).rejects.toThrow('lost');
  await expect(service.register('VAT', { ...selection, dueDate: '2026-12-01' }, preview)).rejects.toThrow('重新核对');
  expect(writes).toHaveLength(1); expect(await retryPendingFinanceCommand(listPendingFinanceCommands()[0])).toMatchObject({ id: 'AP' });
  expect(writes[1]).toEqual(writes[0]); expect(listPendingFinanceCommands()).toEqual([]);
});
it('rejects a response from a prior account before showing approved supplier lines', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { user = { ...user, user: { ...user.user, id: 'OTHER' } }; return response({ ok: true, ...preview }); }));
  await expect(service.preview('VAT', selection)).rejects.toThrow('账号');
});
it('rejects malformed candidate rows instead of treating unknown capacity as zero', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ok: true, items: [{ contractKind: 'purchase', contractId: 'PO', remainingAmount: null }], hasMore: false, nextCursor: null })));
  await expect(service.sources('VAT', { amountBasis: 'net' })).rejects.toThrow('清单未核实');
});
it('keeps a slow preview stale after the account changes A -> B -> A between response boundaries', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const original = user; user = { ...user, user: { ...user.user, id: 'OTHER' } }; auth.listeners.forEach(listener => listener());
    user = original; auth.listeners.forEach(listener => listener()); return response({ ok: true, ...preview });
  }));
  await expect(service.preview('VAT', selection)).rejects.toThrow('账号');
});
