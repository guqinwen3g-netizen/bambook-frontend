// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { beginBusinessRequest, clearAcknowledgedBusinessRequest, readBusinessRequest, listBusinessRequests } from './businessRequestRecovery';
import { getAuthState } from './authService';
import { apiService } from './apiService';
vi.mock('./authService', () => ({ getAuthState: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: vi.fn(), buildApiUrl: (path: string, endpoint: string) => endpoint + path } }));
beforeEach(() => { localStorage.clear(); vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-a' } } as any); vi.mocked(apiService.getStoredConfig).mockReturnValue({ cloudEndpoint: 'http://candidate/api' } as any); });
afterEach(() => vi.restoreAllMocks());
it('persists before writing and reuses the same identity for canonical identical parameters', () => {
  const first = beginBusinessRequest('proposal-v1', { invoiceId: 'I1', amount: '12.34' });
  expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(readBusinessRequest('proposal-v1')).toEqual(first);
  expect(beginBusinessRequest('proposal-v1', { amount: '12.34', invoiceId: 'I1' })).toEqual(first);
  expect(() => beginBusinessRequest('proposal-v1', { amount: '12.35', invoiceId: 'I1' })).toThrow('原内容');
});
it('binds cache to actual actor, operation and endpoint', () => {
  beginBusinessRequest('one', { amount: '1' }); expect(readBusinessRequest('two')).toBeNull();
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-b' } } as any); expect(readBusinessRequest('one')).toBeNull();
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-a' } } as any);
  vi.mocked(apiService.getStoredConfig).mockReturnValue({ cloudEndpoint: 'http://other/api' } as any); expect(readBusinessRequest('one')).toBeNull();
});
it('an old response cannot clear a new actors pending request', () => {
  const old = beginBusinessRequest('one', { amount: '1' });
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-b' } } as any); const current = beginBusinessRequest('one', { amount: '2' });
  clearAcknowledgedBusinessRequest('one', old.requestId); expect(readBusinessRequest('one')).toEqual(current);
  clearAcknowledgedBusinessRequest('one', current.requestId); expect(readBusinessRequest('one')).toBeNull();
});
it('corrupt recovery and unavailable storage do not invent a second request', () => {
  beginBusinessRequest('one', { amount: '1' }); localStorage.setItem(localStorage.key(0)!, '{broken');
  expect(() => beginBusinessRequest('one', { amount: '1' })).toThrow('避免重复');
  localStorage.clear(); vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw Error('quota'); });
  expect(() => beginBusinessRequest('one', { amount: '1' })).toThrow('无法保存'); expect(localStorage.length).toBe(0);
});
it('blocked or silently failed storage never returns a request ready to send', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {});
  expect(() => beginBusinessRequest('one', { amount: '1' })).toThrow('无法保存');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw Error('denied'); });
  expect(() => beginBusinessRequest('one', { amount: '1' })).toThrow('无法读取');
});
it('enumerates only the current actor and endpoint pending intents in the requested family', () => {
  const one = beginBusinessRequest('receipt-direct-claim:one', { amount: '1' }); beginBusinessRequest('proposal:two', { amount: '2' });
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-b' } } as any); beginBusinessRequest('receipt-direct-claim:three', { amount: '3' });
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-a' } } as any);
  expect(listBusinessRequests('receipt-direct-claim:')).toEqual([{ operation: 'receipt-direct-claim:one', record: one }]);
  vi.mocked(apiService.getStoredConfig).mockReturnValue({ cloudEndpoint: 'http://other/api' } as any); expect(listBusinessRequests('receipt-direct-claim:')).toEqual([]);
});
it('a corrupt matching intent is an explicit recovery failure rather than an empty successful list', () => {
  beginBusinessRequest('receipt-direct-claim:one', { amount: '1' }); localStorage.setItem(localStorage.key(0)!, '{broken');
  expect(() => listBusinessRequests('receipt-direct-claim:')).toThrow('核对服务端状态');
});
it('all four recovery operations isolate an explicit second endpoint from the configured endpoint', () => {
  const endpoint2 = 'http://second-candidate/api', operation = 'shipment:update:SH1';
  const first = beginBusinessRequest(operation, { amount: '1', source: 'original' });
  const second = beginBusinessRequest(operation, { amount: '2', source: 'second' }, endpoint2);
  expect(second.requestId).not.toBe(first.requestId);
  expect(beginBusinessRequest(operation, { source: 'second', amount: '2' }, endpoint2)).toEqual(second);
  expect(readBusinessRequest(operation)).toEqual(first); expect(readBusinessRequest(operation, endpoint2)).toEqual(second);
  expect(listBusinessRequests('shipment:update:')).toEqual([{ operation, record: first }]);
  expect(listBusinessRequests('shipment:update:', endpoint2)).toEqual([{ operation, record: second }]);
  clearAcknowledgedBusinessRequest(operation, first.requestId, endpoint2);
  expect(readBusinessRequest(operation, endpoint2)).toEqual(second);
  clearAcknowledgedBusinessRequest(operation, second.requestId, endpoint2);
  expect(readBusinessRequest(operation, endpoint2)).toBeNull(); expect(readBusinessRequest(operation)).toEqual(first);
});
it('an explicit endpoint record survives default-endpoint changes and cannot be cleared by a different actor', () => {
  const endpoint2 = 'http://second-candidate/api', operation = 'shipment:update:SH1';
  const original = beginBusinessRequest(operation, { amount: '2' }, endpoint2);
  vi.mocked(apiService.getStoredConfig).mockReturnValue({ cloudEndpoint: 'http://new-default/api' } as any);
  expect(readBusinessRequest(operation)).toBeNull(); expect(readBusinessRequest(operation, endpoint2)).toEqual(original);
  expect(listBusinessRequests('shipment:update:')).toEqual([]);
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-b' } } as any);
  const other = beginBusinessRequest(operation, { amount: '3' }, endpoint2);
  clearAcknowledgedBusinessRequest(operation, original.requestId, endpoint2);
  expect(readBusinessRequest(operation, endpoint2)).toEqual(other);
  vi.mocked(getAuthState).mockReturnValue({ user: { id: 'sales-a' } } as any);
  expect(readBusinessRequest(operation, endpoint2)).toEqual(original);
  expect(listBusinessRequests('shipment:update:', endpoint2)).toEqual([{ operation, record: original }]);
});
