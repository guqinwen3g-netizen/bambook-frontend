/**
 * 收款匹配与财务确认：读取可见的未核销收款、选择发票和金额。
 * claim 立即写核销，HTTP 入口必须持有 invoices:reconcile；销售只能查看匹配。
 * 第三方代付、币种、余额及可见范围校验仍由原核销服务执行。
 */

import { apiService } from './apiService';

export interface ClaimableReceipt {
  voucherId: string;
  voucherNumber: string;
  paymentDate: string;
  currency: string;
  amount: number;
  /** 该笔收款尚未核销的余额（可认领上限之一） */
  unapplied: number;
  customerRelationId: string | null;
  customerName: string | null;
}

export interface ReceiptClaimResult {
  allocationId: string;
  newInvoiceStatus: string;
  newVoucherStatus: string;
}
export function checkedClaimableReceipt(value: unknown): ClaimableReceipt {
  const row = value as ClaimableReceipt | null;
  if (!row || ['voucherId', 'voucherNumber', 'paymentDate', 'currency'].some(key => typeof (row as any)[key] !== 'string' || !(row as any)[key].trim())
    || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0
    || typeof row.unapplied !== 'number' || !Number.isFinite(row.unapplied) || row.unapplied < 0 || row.unapplied > row.amount) throw Error('收款记录或余额未确认，请刷新核对后重试');
  return row;
}

function url(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/finance/receipt-claims${path}`, base);
}

async function readError(res: any, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = await res.json();
    message = data?.error?.message || data?.message || data?.error || fallback;
  } catch {
    /* 非 JSON 响应 → 兜底文案 */
  }
  const err: any = new Error(typeof message === 'string' ? message : fallback);
  err.status = res.status;
  throw err;
}

export const receiptClaimService = {
  async suggest(voucherId: string): Promise<{ invoiceId: string; suggestedAmount: string } | null> {
    const res = await fetch(url(`/${encodeURIComponent(voucherId)}/suggestion`), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, '匹配建议加载失败');
    const data = await res.json();
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'suggestion')) throw Error('匹配建议结果尚未确认，请重试');
    if (data.suggestion === null) return null;
    if (typeof data.suggestion?.invoiceId !== 'string' || !data.suggestion.invoiceId
      || !Number.isFinite(Number(data.suggestion.suggestedAmount)) || Number(data.suggestion.suggestedAmount) <= 0) throw Error('匹配建议结果尚未确认，请重试');
    return data.suggestion;
  },
  /** 待认领收款列表（仅挂自己可见客户、且仍有未核销余额的收款） */
  async listClaimableReceipts(endpoint?: string): Promise<ClaimableReceipt[]> {
    const res = await fetch(url('', endpoint), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, '加载待认领收款失败');
    const data = await res.json();
    if (!Array.isArray(data?.items)) throw Error('收款列表结果尚未确认，请刷新重试');
    return data.items.map(checkedClaimableReceipt);
  },

  /** 认领：把这笔收款核销到指定应收发票（财务确认入口；服务端校验权限/可见性/币种/金额） */
  async claim(
    input: { voucherId: string; invoiceId: string; amount: number; requestId: string },
    endpoint?: string,
  ): Promise<ReceiptClaimResult> {
    const res = await fetch(url('/claim', endpoint), {
      method: 'POST',
      headers: { ...apiService.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, '回款认领失败');
    const result = await res.json();
    if (typeof result?.allocationId !== 'string' || !result.allocationId
      || !['Issued', 'PartiallyPaid', 'Paid'].includes(result.newInvoiceStatus)
      || !['unreconciled', 'partially_reconciled', 'reconciled'].includes(result.newVoucherStatus)) throw Error('核销结果尚未确认，请保留原请求并重新核对');
    return result;
  },
};

export default receiptClaimService;
