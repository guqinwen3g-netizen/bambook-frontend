import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ id: 'sales', endpoint: 'https://ci.invalid/api', token: 'private-test-token',
  scopes: ['products:read', 'products:write', 'invoices:read', 'invoices:write'] as string[] }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true,
  user: { id: auth.id, roles: [], roleIds: [], permissions: auth.scopes } }), hasPermission: (scope: string) => auth.scopes.includes(scope), subscribe: () => () => {} }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: auth.endpoint }), getAuthHeaders: () => ({ Authorization: `Bearer ${auth.token}` }),
  buildApiUrl: (path: string, endpoint: string) => `${endpoint}${path}` } }));
import { developmentCiContext, developmentCiService as service } from './developmentCiService';
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: any) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fields = { issueDate: '2026-10-07', dueDate: null, paymentTerms: '', note: 'Development', billTo: { name: 'Buyer', address: '' },
  exporter: { nameEn: 'Seller', addressEn: '', beneficiary: '', bankName: '', swiftCode: '', bankAddress: '', usdAccountNumber: '' } };
const command = { action: 'save' as const, requestKey: 'original-key', billingItemId: 'bill', expectedVersion: 0, expectedSourceFingerprint: 'a'.repeat(64), fields };
const acknowledgement = () => ({ replayed: false, receipt: { actorId: 'sales', action: 'save', requestKey: command.requestKey,
  caseId: 'case', billingItemId: 'bill', documentId: 'doc', versionId: 'version', version: 1, auditId: 'audit',
  commandHash: hash({ ...command, documentId: null }) }, document: { document: { id: 'doc' }, version: { id: 'version', version: 1, documentId: 'doc' },
  snapshot: { sourceFingerprint: command.expectedSourceFingerprint, issuedAt: null } } });
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { auth.id = 'sales'; auth.token = 'private-test-token'; auth.endpoint = 'https://ci.invalid/api';
  auth.scopes = ['products:read', 'products:write', 'invoices:read', 'invoices:write']; vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => vi.unstubAllGlobals());
describe('Development CI client original source and command acknowledgements', () => {
  it('binds exact normalized original command/hash/actor/version and sends JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(json(acknowledgement()));
    expect((await service.command('case', command)).receipt.documentId).toBe('doc');
    expect(fetch).toHaveBeenCalledWith('https://ci.invalid/api/v1/development/case/ci-commands', expect.objectContaining({ method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }), body: JSON.stringify(command) }));
  });
  it('retains exact retry payload after unknown receipt and accepts the original acknowledgement', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ ...acknowledgement(), replayed: true }));
    await expect(service.command('case', command)).rejects.toMatchObject({ status: 0 }); await service.command('case', command);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(vi.mocked(fetch).mock.calls[1][1]?.body);
  });
  it.each(['actor', 'hash', 'version', 'source', 'document'])('rejects an unrelated %s acknowledgement', async kind => {
    const data = acknowledgement();
    if (kind === 'actor') data.receipt.actorId = 'other'; if (kind === 'hash') data.receipt.commandHash = 'f'.repeat(64);
    if (kind === 'version') data.document.version.version = 2; if (kind === 'source') data.document.snapshot.sourceFingerprint = 'b'.repeat(64);
    if (kind === 'document') data.document.document.id = 'other';
    vi.mocked(fetch).mockResolvedValue(json(data)); await expect(service.command('case', command)).rejects.toMatchObject({ status: 0 });
  });
  it('checks live session after delayed body decoding', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => { auth.id = 'other'; return acknowledgement(); } } as any);
    await expect(service.command('case', command)).rejects.toMatchObject({ status: 403 });
  });
  it('does not store the bearer credential in the pending-command storage identity', () => {
    expect(developmentCiContext().storageKey).not.toContain(auth.token); expect(developmentCiContext().key).toContain(auth.token);
  });
  it('refuses missing monetary readback rather than displaying zero', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ caseId: 'case', items: [{ documentId: 'doc', versionId: 'v', amount: '100', receipts: [], invoice: { appliedAmount: null, openAmount: null } }], legacy: [] }));
    await expect(service.projection('case')).rejects.toMatchObject({ status: 0 });
  });
  it('recovers the original registration source receipt even after settlement and another authorized retry key', async () => {
    const receipt = { documentId: 'doc', versionId: 'v', invoiceId: 'ar', requestKey: 'first-register', auditId: 'audit',
      commandHash: hash({ documentId: 'doc', versionId: 'v', requestKey: 'first-register' }) };
    vi.mocked(fetch).mockResolvedValue(json({ replayed: true, receipt, invoice: { id: 'ar', sourceType: 'BusinessDevelopmentCI', sourceId: 'v', status: 'Paid' } }));
    expect((await service.register('doc', { requestKey: 'second-register', expectedVersionId: 'v' })).receipt).toEqual(receipt);
  });
  it('reads HTML for an in-page sandboxed original preview', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<!doctype html><h1>COMMERCIAL INVOICE</h1>', { headers: { 'Content-Type': 'text/html' } }));
    expect(await service.preview('case', 'doc', 2)).toContain('COMMERCIAL INVOICE');
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/ci/doc/preview.html?version=2');
  });
  it('validates an exact supplemental cost selection and its original request receipt after retry', async () => {
    const command = { requestKey: 'supplement-key', expectedSourceFingerprint: 'a'.repeat(64), costRecordIds: ['late-2', 'late-1'], amount: '030.00', waivedAmount: '0', currency: 'USD', note: ' Later agreed fee ' };
    const receipt = { operation: 'create_development_supplemental_billing', actorId: 'sales', caseId: 'case', billingItemId: 'second-billing',
      requestKey: command.requestKey, expectedSourceFingerprint: command.expectedSourceFingerprint, costRecordIds: ['late-1', 'late-2'], auditId: 'audit',
      commandHash: hash({ ...command, costRecordIds: ['late-1', 'late-2'], amount: '30.0000', waivedAmount: '0.0000', note: 'Later agreed fee' }) };
    const data = { replayed: true, receipt, billingItem: { id: 'second-billing', sourceType: 'DevelopmentCase', sourceId: 'case', status: 'invoiced' } };
    vi.mocked(fetch).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(data));
    await expect(service.supplement('case', command)).rejects.toMatchObject({ status: 0 });
    expect((await service.supplement('case', command)).receipt).toEqual(receipt);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(vi.mocked(fetch).mock.calls[1][1]?.body);
    vi.mocked(fetch).mockResolvedValue(json({ ...data, receipt: { ...receipt, costRecordIds: ['another-cost'] } }));
    await expect(service.supplement('case', command)).rejects.toMatchObject({ status: 0 });
  });
  it('does not convert unknown supplemental source facts into an empty selectable range', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ caseId: 'case', canSupplement: true, costs: null, occupiedCount: 1, sourceFingerprint: 'a'.repeat(64), issued: [] }));
    await expect(service.uncoveredCosts('case')).rejects.toMatchObject({ status: 0 });
  });
});
