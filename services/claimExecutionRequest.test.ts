// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { beginClaimExecutionRequest, clearConfirmedClaimExecutionRequest, readClaimExecutionRequest } from './claimExecutionRequest';
const identity = { userId: 'sales-a', endpoint: 'http://candidate/api/v1/claims', dispositionId: 'disp-a' };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it('persists one request before execution and recovers it across retries', () => {
  const first = beginClaimExecutionRequest(identity, { warehouseId: 'warehouse-a' });
  expect(first.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(readClaimExecutionRequest(identity)).toEqual(first);
  expect(beginClaimExecutionRequest(identity, { warehouseId: 'warehouse-a' })).toEqual(first);
  expect(() => beginClaimExecutionRequest(identity, { warehouseId: 'warehouse-b' })).toThrow('原执行资源');
});
it('binds recovery to the actual user, environment and disposition', () => {
  const first = beginClaimExecutionRequest(identity, {});
  for (const changed of [{ userId: 'sales-b' }, { endpoint: 'http://other/api/v1/claims' }, { dispositionId: 'disp-b' }]) {
    expect(readClaimExecutionRequest({ ...identity, ...changed })).toBeNull();
    expect(beginClaimExecutionRequest({ ...identity, ...changed }, {}).clientRequestId).not.toBe(first.clientRequestId);
  }
  clearConfirmedClaimExecutionRequest(identity);
  expect(readClaimExecutionRequest(identity)).toBeNull();
});
it('storage faults or corrupt pending requests never manufacture a replacement request', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw Error('quota'); });
  expect(() => beginClaimExecutionRequest(identity, {})).toThrow('无法保存');
  beginClaimExecutionRequest(identity, {});
  const cacheKey = localStorage.key(0)!;
  localStorage.setItem(cacheKey, '{broken');
  expect(() => beginClaimExecutionRequest(identity, {})).toThrow('避免重复');
  expect(localStorage.getItem(cacheKey)).toBe('{broken');
});
