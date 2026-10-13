// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { receiptClaimService } from './receiptClaimService';
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: 'http://candidate' }), buildApiUrl: (path: string, endpoint: string) => endpoint + path, getAuthHeaders: () => ({ Authorization: 'Bearer synthetic' }) } }));
const receipt = { voucherId: 'V1', voucherNumber: 'V1', paymentDate: '2026-10-01', currency: 'CNY', amount: 100, unapplied: 50, customerRelationId: 'C1', customerName: 'Customer' };
const input = { voucherId: 'V1', invoiceId: 'I1', amount: 12.34, requestId: 'stable-intent' };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it('a malformed list or unknown balance fails rather than reporting zero/open-list success', async () => {
  for (const body of [{}, { items: null }, { items: [{ ...receipt, unapplied: undefined }] }, { items: [{ ...receipt, unapplied: null }] }, { items: [{ ...receipt, unapplied: 101 }] }]) {
    fetchMock.mockResolvedValueOnce(response(body)); await expect(receiptClaimService.listClaimableReceipts()).rejects.toThrow();
  }
  fetchMock.mockResolvedValueOnce(response({ items: [receipt] })); expect(await receiptClaimService.listClaimableReceipts()).toEqual([receipt]);
  fetchMock.mockResolvedValueOnce(response({ items: [] })); expect(await receiptClaimService.listClaimableReceipts()).toEqual([]);
});
it('confirmation requires an actual allocation and exact domain status acknowledgement', async () => {
  for (const body of [{}, { allocationId: 'A1' }, { allocationId: 'A1', newInvoiceStatus: 'Paid', newVoucherStatus: 'something' }]) {
    fetchMock.mockResolvedValueOnce(response(body)); await expect(receiptClaimService.claim(input)).rejects.toThrow('尚未确认');
  }
  const fact = { allocationId: 'A1', newInvoiceStatus: 'PartiallyPaid', newVoucherStatus: 'partially_reconciled' };
  fetchMock.mockResolvedValueOnce(response(fact)); expect(await receiptClaimService.claim(input)).toEqual(fact);
  expect(fetchMock).toHaveBeenLastCalledWith('http://candidate/v1/finance/receipt-claims/claim', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
});
it('no-match is explicit null; malformed suggestion does not silently become no-match', async () => {
  fetchMock.mockResolvedValueOnce(response({})); await expect(receiptClaimService.suggest('V1')).rejects.toThrow('尚未确认');
  fetchMock.mockResolvedValueOnce(response({ suggestion: null })); expect(await receiptClaimService.suggest('V1')).toBeNull();
  fetchMock.mockResolvedValueOnce(response({ suggestion: { invoiceId: 'I1', suggestedAmount: '12.34' } })); expect(await receiptClaimService.suggest('V1')).toEqual({ invoiceId: 'I1', suggestedAmount: '12.34' });
});
