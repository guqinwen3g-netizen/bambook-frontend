/**
 * OutwardRemittance API service（阶段 C6 付汇水单）.
 * Communicates with /api/v1/finance/outward-remittances endpoints.
 *
 * 契约要点：
 *   - cnyAmount 由服务端计算（foreignAmount × fxRate），客户端不得传入
 *   - 仅 Disbursement 外币凭证可付汇；超付 / 币种不一致被服务端拒绝（fail closed）
 *   - Decimal 字段以 string 传输（保精度）
 */
import { apiService } from './apiService';
import type { OutwardRemittance, VoucherRemittanceSummary } from '../types';

export interface OutwardRemittanceCreateInput {
  remittanceNumber?: string;
  voucherId: string;
  remitDate: string; // YYYY-MM-DD
  foreignAmount: number | string;
  currency?: string; // 缺省继承凭证币种
  fxRate: number | string;
  payeeName?: string;
  payeeBank?: string;
  payeeSwift?: string;
  purpose?: string;
  bank?: string;
  slipNumber?: string;
  notes?: string;
}

type OutwardRemittanceListParams = {
  voucherId?: string;
  from?: string;
  to?: string;
};

export const outwardRemittanceService = {
  async listOutwardRemittances(endpoint?: string, params?: OutwardRemittanceListParams): Promise<{ items: OutwardRemittance[]; total: number }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/outward-remittances', base);
    const query = new URLSearchParams();
    if (params?.voucherId) query.set('voucherId', params.voucherId);
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listOutwardRemittances failed: HTTP ${res.status}`);
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [], total: Number(data.total) || 0 };
  },

  /** 凭证付汇摘要：凭证金额 / 已付汇 / 未付余额 / 付汇明细 */
  async getVoucherRemittanceSummary(voucherId: string, endpoint?: string): Promise<VoucherRemittanceSummary> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/vouchers/${encodeURIComponent(voucherId)}/remittances`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getVoucherRemittanceSummary failed: HTTP ${res.status}`);
    return data;
  },

  /** 登记付汇水单（服务端余额校验 + cnyAmount 计算，OVER_REMITTANCE/CURRENCY_MISMATCH 阻断） */
  async createOutwardRemittance(input: OutwardRemittanceCreateInput, endpoint?: string): Promise<OutwardRemittance> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/outward-remittances', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `createOutwardRemittance failed: HTTP ${res.status}`);
    return data;
  },

  /** 软删付汇水单（回滚未付余额） */
  async deleteOutwardRemittance(id: string, endpoint?: string): Promise<{ ok: boolean }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/outward-remittances/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `deleteOutwardRemittance failed: HTTP ${res.status}`);
    return { ok: true };
  },
};
