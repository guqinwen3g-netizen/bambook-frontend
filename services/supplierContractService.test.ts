// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ actorId: 'BUYER', endpoint: 'https://supplier.invalid/api', permissions: ['procurement:read', 'procurement:write'], ceiling: undefined as string[] | undefined }));
vi.mock('./authService', () => ({ getAuthState: () => ({ isAuthenticated: true, user: { id: state.actorId, roles: ['sales'], permissions: state.permissions, permissionCeiling: state.ceiling } }) }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: state.endpoint }), getAuthHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.actorId }),
  buildApiUrl: (path: string, endpoint = state.endpoint) => endpoint + path } }));
import { supplierCapability, supplierContractService, supplierSession, verifySupplierCommand, type SupplierIntent } from './supplierContractService';
const intent = (action: SupplierIntent['action'] = 'fulfillments'): SupplierIntent => ({ kind: 'purchase', id: 'PO1', action, body: { approvedRevisionId: 'REV1', lines: [{ lineId: 'PL1', quantity: '90071992547409.125', unit: 'M' }] } });
function reply(input: SupplierIntent, key: string) {
  return { ok: true, item: { contractId: 'PO1', contractKind: 'purchase', approvedRevisionId: 'REV1', facts: [{ id: 'FACT1', quantity: '90071992547409.125', unit: 'M' }] },
    commandAck: { schemaVersion: 1, requestKey: key, operation: 'record_fulfillment', contractKind: 'purchase', contractId: input.id, receiptId: 'RECEIPT1', revisionId: 'REV1', factIds: ['FACT1'] } };
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { localStorage.clear(); state.actorId = 'BUYER'; state.endpoint = 'https://supplier.invalid/api'; state.permissions = ['procurement:read', 'procurement:write']; state.ceiling = undefined; });
afterEach(() => vi.unstubAllGlobals());
describe('native supplier command acknowledgement and recovery', () => {
  it('preserves exact decimal strings and clears only a verified original receipt', async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); sent.push(body); return response(reply(intent(), body.requestKey)); }));
    const result = await supplierContractService.command(intent());
    expect((sent[0].lines as Array<{ quantity: string }>)[0].quantity).toBe('90071992547409.125');
    expect(result.commandAck.factIds).toEqual(['FACT1']); expect(supplierContractService.pending()).toEqual([]);
  });
  it('an unknown result survives remount and retries the same immutable body/key', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(Error('connection interrupted')).mockImplementation(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); return response(reply(intent(), body.requestKey)); });
    vi.stubGlobal('fetch', fetcher); await expect(supplierContractService.command(intent())).rejects.toThrow('interrupted');
    const saved = supplierContractService.pending()[0]; expect(saved.record.payload).toEqual(intent());
    await supplierContractService.command(saved.record.payload);
    expect(fetcher.mock.calls[1][1].body).toEqual(fetcher.mock.calls[0][1].body); expect(supplierContractService.pending()).toHaveLength(0);
  });
  it('a changed retry cannot send a different business command under the original key', async () => {
    const fetcher = vi.fn().mockRejectedValue(Error('connection interrupted')); vi.stubGlobal('fetch', fetcher);
    await expect(supplierContractService.command(intent())).rejects.toThrow();
    await expect(supplierContractService.command({ ...intent(), body: { ...intent().body, lines: [] } })).rejects.toThrow('恢复原内容'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['contractId', 'requestKey', 'operation', 'revisionId'] as const)('rejects a mismatched %s receipt and keeps the original request', async field => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); const result = reply(intent(), body.requestKey); result.commandAck[field] = 'FOREIGN'; return response(result); }));
    await expect(supplierContractService.command(intent())).rejects.toThrow('原'); expect(supplierContractService.pending()).toHaveLength(1);
  });
  it('requires every acknowledged fact and rejects numeric quantities instead of accepting lossy readback', () => {
    const result = reply(intent(), 'KEY'); result.item.facts = [{ id: 'OTHER', quantity: '2', unit: 'M' }];
    expect(() => verifySupplierCommand(result, intent(), 'KEY')).toThrow('事实');
    expect(() => verifySupplierCommand({ ...reply(intent(), 'KEY'), item: { ...reply(intent(), 'KEY').item, facts: [{ id: 'FACT1', quantity: 90071992547409.12, unit: 'M' }] } }, intent(), 'KEY')).toThrow('事实');
  });
  it('a deterministic refusal releases the refused intent, while a request key conflict does not', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ok: false, error: { code: 'REVISION_CONFLICT', message: '当前版本已变化' } }, 409))
      .mockResolvedValueOnce(response({ ok: false, error: { code: 'REQUEST_KEY_CONFLICT', message: '原键冲突' } }, 409)); vi.stubGlobal('fetch', fetcher);
    await expect(supplierContractService.command(intent())).rejects.toThrow('版本'); expect(supplierContractService.pending()).toHaveLength(0);
    await expect(supplierContractService.command(intent())).rejects.toThrow('冲突'); expect(supplierContractService.pending()).toHaveLength(1);
  });
  it.each([403, 404, 409])('an unknown original result remains recoverable after a later %s refusal', async status => {
    const fetcher = vi.fn().mockRejectedValueOnce(Error('committed response disconnected'))
      .mockResolvedValueOnce(response({ error: { code: status === 409 ? 'SOURCE_CHANGED' : 'FORBIDDEN', message: '当前来源或权限无法核实' } }, status))
      .mockImplementation(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); return response(reply(intent(), body.requestKey)); });
    vi.stubGlobal('fetch', fetcher);
    await expect(supplierContractService.command(intent())).rejects.toThrow('disconnected');
    const original = supplierContractService.pending()[0].record;
    await expect(supplierContractService.command(original.payload)).rejects.toThrow('无法核实');
    expect(supplierContractService.pending()[0].record).toEqual(original);
    await supplierContractService.command(original.payload);
    expect(fetcher.mock.calls.map(call => JSON.parse(String(call[1].body)).requestKey)).toEqual([original.requestId, original.requestId, original.requestId]);
    expect(supplierContractService.pending()).toHaveLength(0);
  });
  it('late success after changing account is ignored and cannot clear the original operator intent', async () => {
    let finish!: (value: Response) => void; let key = '';
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => { key = JSON.parse(String(init.body)).requestKey; return new Promise<Response>(resolve => { finish = resolve; }); }));
    const pending = supplierContractService.command(intent()); state.actorId = 'OTHER'; finish(response(reply(intent(), key)));
    await expect(pending).rejects.toThrow('账号'); expect(supplierContractService.pending()).toHaveLength(0);
    state.actorId = 'BUYER'; expect(supplierContractService.pending()).toHaveLength(1);
  });
  it('actual grants and credential ceiling are both required; role names add no capability', () => {
    state.permissions = []; expect(supplierCapability()).toBe(false); state.permissions = ['*']; state.ceiling = ['procurement:read']; expect(supplierCapability()).toBe(false);
    state.ceiling = ['*']; expect(supplierCapability()).toBe(true);
  });
  it('a pending approval receipt must bind the submitted exact revision and target', () => {
    const original: SupplierIntent = { kind: 'processing', id: 'OS1', action: 'submit', body: { expectedRevision: 3 } };
    const value = { ok: true, item: { id: 'APP1', targetId: 'REV3', payload: { contractKind: 'processing', contractId: 'OS1', revisionId: 'REV3', revision: 3 } }, commandAck: { schemaVersion: 1, requestKey: 'KEY', operation: 'submit_commitment', contractKind: 'processing', contractId: 'OS1', receiptId: 'RC1', revisionId: 'REV3', approvalId: 'APP1' } };
    expect(verifySupplierCommand(value, original, 'KEY').commandAck.approvalId).toBe('APP1');
    value.item.payload.revisionId = 'OTHER'; expect(() => verifySupplierCommand(value, original, 'KEY')).toThrow('审批');
  });
  it('formal document acknowledgement must use the requested approved revision', () => {
    const original: SupplierIntent = { kind: 'purchase', id: 'PO1', action: 'generate-document', body: { approvedRevisionId: 'REV1' } };
    const value = { ok: true, item: { documentId: 'DOC', revisionId: 'OTHER', version: 1, sha256: 'a'.repeat(64) }, commandAck: { schemaVersion: 1, requestKey: 'KEY', operation: 'generate_document', contractKind: 'purchase', contractId: 'PO1', receiptId: 'RC1', revisionId: 'OTHER', documentId: 'DOC' } };
    expect(() => verifySupplierCommand(value, original, 'KEY')).toThrow('原');
  });
  it('source reads are discarded when the original data center changes', async () => {
    const original = supplierSession(); state.endpoint = 'https://other.invalid/api'; const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(supplierContractService.sources('', original)).rejects.toThrow('数据中心'); expect(fetcher).not.toHaveBeenCalled();
  });
});
