// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { devLoginAs } from './authService';
import { readMainApproval, withdrawMainApproval, pendingMainWithdrawals } from './orderMainApprovalService';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: 'http://main-approval.invalid/api' }),
  buildApiUrl: (route: string, endpoint = 'http://main-approval.invalid/api') => endpoint + route,
  getAuthHeaders: () => ({ Authorization: 'Bearer actual-business-session', 'Content-Type': 'application/json' }),
} }));
const version = 'a'.repeat(64), intent = { orderId: 'O1', approvalId: 'A1', reviewContentVersion: version, reason: '核对准确原件后再显式提交' };
const read = (status = 'pending') => ({ item: { id: 'A1', targetId: 'O1', requesterId: 'BUSINESS1', status, reviewContentVersion: version, canApprove: false } });
function receipt(body: { requestKey: string }) { return { ok: true, item: { id: 'A1', status: 'cancelled' }, commandAck: { operation: 'withdraw_order_main_approval',
  approvalId: 'A1', orderId: 'O1', actorId: 'BUSINESS1', status: 'cancelled', reason: intent.reason, requestKey: body.requestKey, commandHash: 'b'.repeat(64), reviewContentVersion: version } }; }
beforeEach(async () => { vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', mocks.fetch);
  await devLoginAs('business-session', { id: 'BUSINESS1', displayName: '来源业务', email: '', roles: [], permissions: ['orders:read', 'orders:write'], departmentIds: [], department: null }); });
afterEach(() => vi.unstubAllGlobals());
it('reads the native legacy HTTP envelope without inventing an ok flag', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => read() });
  expect(await readMainApproval('A1')).toMatchObject({ id: 'A1', canApprove: false, status: 'pending' });
});
it('keeps a committed withdrawal pending until its exact cancelled source can be read, then replays its original key', async () => {
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => options.method === 'POST'
    ? { ok: true, json: async () => receipt(JSON.parse(String(options.body))) }
    : Promise.reject(Error('source read disconnected')));
  await expect(withdrawMainApproval(intent)).rejects.toThrow('source read disconnected');
  expect(pendingMainWithdrawals()).toHaveLength(1); const first = JSON.parse(mocks.fetch.mock.calls[0][1].body);
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => options.method === 'POST' ? receipt(JSON.parse(String(options.body))) : read('cancelled') }));
  await withdrawMainApproval(structuredClone(intent));
  expect(JSON.parse(mocks.fetch.mock.calls[2][1].body)).toEqual(first); expect(pendingMainWithdrawals()).toEqual([]);
});
it('never clears recovery for the wrong approval, actor or unchanged pending source', async () => {
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => options.method === 'POST' ? receipt(JSON.parse(String(options.body))) : read('pending') }));
  await expect(withdrawMainApproval(intent)).rejects.toThrow('尚未核对为已撤回'); expect(pendingMainWithdrawals()).toHaveLength(1);
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => ({ ok: true, json: async () => ({ ...receipt(JSON.parse(String(options.body))), item: { id: 'OTHER', status: 'cancelled' } }) }));
  await expect(withdrawMainApproval(intent)).rejects.toThrow('回执待核'); expect(pendingMainWithdrawals()).toHaveLength(1);
});
