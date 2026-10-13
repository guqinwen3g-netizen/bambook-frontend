/**
 * FxSettlement API service（阶段 F / F2 外汇核销闭环）.
 * Communicates with /api/v1/finance/fx-settlements endpoints.
 *
 * 契约要点：
 *   - cnyAmount 由服务端计算（foreignAmount × fxRate），客户端不得传入
 *   - 仅 Receipt 外币凭证可结汇；超结 / 币种不一致被服务端拒绝（fail closed）
 *   - Decimal 字段以 string 传输（保精度）
 */
import { apiService } from './apiService';
import type { FxLedger, FxSettlement, VoucherSettlementSummary } from '../types';

export interface FxSettlementCreateInput {
  settlementNumber?: string;
  voucherId: string;
  settleDate: string; // YYYY-MM-DD
  foreignAmount: number | string;
  currency?: string; // 缺省继承凭证币种
  fxRate: number | string;
  bank?: string;
  slipNumber?: string;
  notes?: string;
}

type FxSettlementListParams = {
  voucherId?: string;
  orderId?: string;
  customerRelationId?: string;
  currency?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export const fxSettlementService = {
  async listFxSettlements(endpoint?: string, params?: FxSettlementListParams): Promise<{ items: FxSettlement[]; total: number }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/fx-settlements', base);
    const query = new URLSearchParams();
    if (params?.voucherId) query.set('voucherId', params.voucherId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    if (params?.currency) query.set('currency', params.currency);
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listFxSettlements failed: HTTP ${res.status}`);
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [], total: Number(data.total) || 0 };
  },

  /** 凭证核销摘要：凭证金额 / 已结汇 / 未结汇余额 / 结汇明细 */
  async getVoucherSettlementSummary(voucherId: string, endpoint?: string): Promise<VoucherSettlementSummary> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/vouchers/${encodeURIComponent(voucherId)}/settlements`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getVoucherSettlementSummary failed: HTTP ${res.status}`);
    return data;
  },

  /** 外汇台账（只读聚合）：按币种分行的收汇/已结汇/未结汇 + 未结汇凭证清单 */
  async getFxLedger(params?: { from?: string; to?: string }, endpoint?: string): Promise<FxLedger> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/fx-settlements/ledger', base);
    const query = new URLSearchParams();
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getFxLedger failed: HTTP ${res.status}`);
    return data;
  },

  /** 登记结汇水单（服务端核销校验 + cnyAmount 计算，OVER_SETTLEMENT/CURRENCY_MISMATCH 阻断） */
  async createFxSettlement(input: FxSettlementCreateInput, endpoint?: string): Promise<FxSettlement> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/fx-settlements', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `createFxSettlement failed: HTTP ${res.status}`);
    return data;
  },

  /** 软删结汇水单（回滚核销余额） */
  async deleteFxSettlement(id: string, endpoint?: string): Promise<{ ok: boolean }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/fx-settlements/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `deleteFxSettlement failed: HTTP ${res.status}`);
    return { ok: true };
  },
};
