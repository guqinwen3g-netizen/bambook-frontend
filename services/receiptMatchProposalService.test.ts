import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { receiptMatchProposalService } from './receiptMatchProposalService';
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: 'http://candidate/api' }), buildApiUrl: (path: string, endpoint: string) => endpoint + path, getAuthHeaders: () => ({ Authorization: 'Bearer synthetic' }) } }));
const item = { id: 'P1', requesterId: 'sales-a', voucherId: 'V1', invoiceId: 'I1', requestId: 'R1', currency: 'USD', requestedAmount: '12.3400', status: 'Pending', revision: 1 };
const input = { voucherId: 'V1', invoiceId: 'I1', amount: '12.34', currency: 'USD', requestId: 'R1' };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const respond = (data: unknown, ok = true, status = 200) => fetchMock.mockResolvedValueOnce({ ok, status, json: async () => data });
it('submits authenticated actual IDs/decimal text and accepts only a matching server receipt', async () => {
  respond({ item, replayed: false }); expect(await receiptMatchProposalService.submit(input)).toEqual({ item, replayed: false });
  expect(fetchMock).toHaveBeenCalledWith('http://candidate/api/v1/finance/receipt-match-proposals/', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
});
it('malformed successful JSON and different-source receipts remain unknown, never acknowledged', async () => {
  for (const data of [{}, { item: { ...item, invoiceId: 'another' }, replayed: false }, { item, replayed: 'false' }]) {
    respond(data); await expect(receiptMatchProposalService.submit(input)).rejects.toThrow(/确认|不一致/);
  }
});
it('decision requires the same proposal and actual corresponding terminal status', async () => {
  respond({ item: { ...item, status: 'Pending' }, replayed: false }); await expect(receiptMatchProposalService.decide('P1', 'confirm', { revision: 1, requestId: 'D1' })).rejects.toThrow('尚未确认');
  respond({ item: { ...item, status: 'Confirmed', revision: 2 }, replayed: true }); expect((await receiptMatchProposalService.decide('P1', 'confirm', { revision: 1, requestId: 'D1' })).replayed).toBe(true);
});
it('preserves server error classification and rejects a malformed list instead of showing a false empty state', async () => {
  respond({ error: { code: 'CONFLICT', message: '余额已变化' } }, false, 409); await expect(receiptMatchProposalService.submit(input)).rejects.toMatchObject({ message: '余额已变化', status: 409, code: 'CONFLICT' });
  respond({ items: null, total: 0 }); await expect(receiptMatchProposalService.list()).rejects.toThrow('列表结果无效');
});
