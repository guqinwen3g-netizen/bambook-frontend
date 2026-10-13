import { apiService } from './apiService';
export interface ReceiptMatchProposal {
  id: string; requesterId: string; voucherId: string; invoiceId: string;
  requestedAmount: string; currency: string; note: string | null;
  status: 'Pending' | 'Confirmed' | 'Rejected' | 'Withdrawn'; revision: number;
  requestId: string; decisionActorId: string | null; decisionNote: string | null; allocationId: string | null;
  invoiceNumber?: string; voucherNumber?: string; payerName?: string | null; customerName?: string | null;
}
export interface ReceiptMatchSubmission { voucherId: string; invoiceId: string; amount: string; currency: string; note?: string; requestId: string }
export interface ReceiptMatchDecision { revision: number; requestId: string; note?: string }
export type ReceiptMatchDecisionAction = 'confirm' | 'reject' | 'withdraw';
async function request<T>(path: string, body?: object): Promise<T> {
  const endpoint = apiService.getStoredConfig().cloudEndpoint;
  const response = await fetch(apiService.buildApiUrl('/v1/finance/receipt-match-proposals' + path, endpoint), {
    method: body ? 'POST' : 'GET', headers: { ...apiService.getAuthHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.message || '暂时无法核对回款建议，请重试原请求'), { status: response.status, code: data?.error?.code });
  return data;
}
function checkedItem(value: unknown): ReceiptMatchProposal {
  const row = value as ReceiptMatchProposal | null;
  if (!row || ['id', 'requesterId', 'voucherId', 'invoiceId', 'requestId', 'currency'].some(field => typeof (row as any)[field] !== 'string' || !(row as any)[field].trim())
    || !['Pending', 'Confirmed', 'Rejected', 'Withdrawn'].includes(row.status) || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.requestedAmount !== 'string' || !Number.isFinite(Number(row.requestedAmount)) || Number(row.requestedAmount) <= 0) throw Error('服务端结果尚未确认，请保留原请求并重新核对');
  return row;
}
export const receiptMatchProposalService = {
  list: async () => {
    const data = await request<{ items: unknown[]; total: number }>('/');
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw Error('回款建议列表结果无效，请刷新重试');
    return { items: data.items.map(checkedItem), total: data.total };
  },
  submit: async (input: ReceiptMatchSubmission) => {
    const data = await request<{ item: unknown; replayed: boolean }>('/', input), item = checkedItem(data.item);
    if (item.requestId !== input.requestId || item.voucherId !== input.voucherId || item.invoiceId !== input.invoiceId
      || item.currency !== input.currency || Number(item.requestedAmount) !== Number(input.amount) || typeof data.replayed !== 'boolean') throw Error('匹配建议回执与原请求不一致，请保留原请求并重新核对');
    return { item, replayed: data.replayed };
  },
  decide: async (id: string, action: ReceiptMatchDecisionAction, input: ReceiptMatchDecision) => {
    const data = await request<{ item: unknown; replayed: boolean }>(`/${encodeURIComponent(id)}/${action}`, input), item = checkedItem(data.item);
    const status = { confirm: 'Confirmed', reject: 'Rejected', withdraw: 'Withdrawn' }[action];
    if (item.id !== id || item.status !== status || typeof data.replayed !== 'boolean') throw Error('处理回执尚未确认，请保留原请求并重新核对');
    return { item, replayed: data.replayed };
  },
};
