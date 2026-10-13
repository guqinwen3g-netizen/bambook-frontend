/**
 * Allocation API service.
 * Communicates with /api/v1/finance/allocations endpoints.
 * 消费后端 task_mqy459a5 allocation route foundation contract。
 */
import { apiService } from './apiService';
import type { InvoiceAllocation, AllocationResult, AllocationDeleteResult } from '../types';

type AllocationListParams = {
  invoiceId?: string;
  voucherId?: string;
  limit?: number;
};

export const allocationService = {
  async listAllocations(endpoint?: string, params?: AllocationListParams): Promise<InvoiceAllocation[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/allocations', base);
    const query = new URLSearchParams();
    if (params?.invoiceId) query.set('invoiceId', params.invoiceId);
    if (params?.voucherId) query.set('voucherId', params.voucherId);
    if (params?.limit) query.set('limit', String(params.limit));

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listAllocations failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  },

  async createAllocation(input: { invoiceId: string; voucherId: string; appliedAmount: number; appliedDate?: string }, endpoint?: string): Promise<AllocationResult> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/allocations', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
      throw new Error(reason);
    }
    return data as AllocationResult;
  },

  async updateAllocation(id: string, input: { appliedAmount?: number; appliedDate?: string }, endpoint?: string): Promise<AllocationResult> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/allocations/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
      throw new Error(reason);
    }
    return data as AllocationResult;
  },

  async deleteAllocation(id: string, endpoint?: string): Promise<AllocationDeleteResult> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/allocations/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
      throw new Error(reason);
    }
    return data as AllocationDeleteResult;
  },
};
