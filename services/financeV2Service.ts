/**
 * financeV2Service.ts — Phase 1-04 财务/成本域 V2 API 服务
 *
 * 封装 /api/v2/finance 下的新增端点：
 *   1. 报价单双轨定价（apply-pricing / pricing-check）
 *   2. PI 形式发票（generate-pi / convert-to-receivable）
 *   3. VAT 增值税发票 CRUD + 状态流转
 *   4. 外汇结汇/付汇 CRUD + 台账 + 凭证摘要
 */
import { apiService } from './apiService';
import { vatInvoiceService } from './vatInvoiceService';

const BASE_PATH = '/v2/finance';

function buildUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`${BASE_PATH}${path}`, base);
}

function authHeaders(): Record<string, string> {
  return apiService.getAuthHeaders();
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data?.message) return data.message;
    if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    return `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ────────────────────────────────────────────────────────────────────
// 1. 报价单双轨定价
// ────────────────────────────────────────────────────────────────────

export interface QuotationPricingInput {
  category: 'garment' | 'fabric';
  fabricCode?: string;
  yarnCode?: string;
  fabricPriceCny?: number;
  fabricConsumptionM?: number;
  fabricLossRate?: number;
  trimmingCostCny?: number;
  cmtCostCny?: number;
  complexity?: 'simple' | 'standard' | 'complex';
  packagingCostCny?: number;
  yarnPriceCnyPerKg?: number;
  weightGsm?: number;
  widthM?: number;
  weavingCostCny?: number;
  weaveType?: 'plain' | 'twill' | 'jacquard';
  dyeingCostCny?: number;
  profitBenchmark?: number;
  quantity?: number;
  purchaseCostCny: number;
  refundRate?: number;
  hsCode?: string;
  exchangeRate?: number;
  profitMargin: number;
  commissionRate?: number;
  commissionRuleId?: string;
}

export interface QuotationPricingResult {
  quotationId: string;
  trackAMedianUsd: number;
  trackBFinalUsd: number;
  deviationPercent: number;
  deviationLevel: 'ok' | 'warn' | 'block';
  canSend: boolean;
}

export const financeV2Service = {
  // ── 报价单双轨定价 ──

  async applyTrackPricing(quotationId: string, input: QuotationPricingInput, endpoint?: string): Promise<QuotationPricingResult> {
    const res = await fetch(buildUrl(`/quotations/${encodeURIComponent(quotationId)}/apply-pricing`, endpoint), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.pricing;
  },

  async getPricingCheck(quotationId: string, endpoint?: string): Promise<QuotationPricingResult> {
    const res = await fetch(buildUrl(`/quotations/${encodeURIComponent(quotationId)}/pricing-check`, endpoint), {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.pricing;
  },

  // ── PI 形式发票 ──

  async generatePi(quotationId: string, input: { issueDate?: string; dueDate?: string; notes?: string }, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl(`/quotations/${encodeURIComponent(quotationId)}/generate-pi`, endpoint), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.invoice;
  },

  async convertToReceivable(invoiceId: string, input: { issueDate?: string; dueDate?: string; notes?: string }, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl(`/invoices/${encodeURIComponent(invoiceId)}/convert-to-receivable`, endpoint), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.invoice;
  },

  // ── VAT 增值税发票 ──

  async listVatInvoices(params: {
    status?: string; direction?: string; relationId?: string; orderId?: string;
    invoiceId?: string; taxRefundId?: string; from?: string; to?: string;
  } = {}, endpoint?: string): Promise<{ items: any[]; total: number }> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
    const qs = query.toString();
    const res = await fetch(buildUrl(`/vat-invoices${qs ? `?${qs}` : ''}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    return await res.json();
  },

  async getVatInvoice(id: string, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl(`/vat-invoices/${encodeURIComponent(id)}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.vatInvoice;
  },

  async createVatInvoice(input: any, endpoint?: string): Promise<any> {
    return {ok:true,vatInvoice:await vatInvoiceService.createVatInvoice(input,endpoint)};
  },
  async updateVatInvoice(id: string, patch: any, endpoint?: string): Promise<any> {
    return {ok:true,vatInvoice:await vatInvoiceService.updateVatInvoice(id,patch,endpoint)};
  },
  async deleteVatInvoice(id: string, endpoint?: string): Promise<void> {
    await vatInvoiceService.deleteVatInvoice(id,endpoint);
  },
  async transitionVatInvoice(id: string, input: any, endpoint?: string): Promise<any> {
    return {ok:true,vatInvoice:await vatInvoiceService.transitionVatInvoice(id,input,endpoint)};
  },

  // ── 外汇结汇 ──

  async listFxSettlements(params: {
    voucherId?: string; orderId?: string; customerRelationId?: string; currency?: string;
  } = {}, endpoint?: string): Promise<{ items: any[]; total: number }> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
    const qs = query.toString();
    const res = await fetch(buildUrl(`/fx-settlements${qs ? `?${qs}` : ''}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    return await res.json();
  },

  async createFxSettlement(input: any, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl('/fx-settlements', endpoint), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data;
  },

  async deleteFxSettlement(id: string, endpoint?: string): Promise<void> {
    const res = await fetch(buildUrl(`/fx-settlements/${encodeURIComponent(id)}`, endpoint), {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await parseError(res));
  },

  async getFxLedger(params: { from?: string; to?: string } = {}, endpoint?: string): Promise<any> {
    const query = new URLSearchParams();
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const qs = query.toString();
    const res = await fetch(buildUrl(`/fx-settlements/ledger${qs ? `?${qs}` : ''}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.ledger;
  },

  async getVoucherSettlementSummary(voucherId: string, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl(`/fx-settlements/voucher-summary/${encodeURIComponent(voucherId)}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.summary;
  },

  // ── 外汇付汇 ──

  async listOutwardRemittances(params: {
    voucherId?: string; orderId?: string; customerRelationId?: string; currency?: string;
  } = {}, endpoint?: string): Promise<{ items: any[]; total: number }> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
    const qs = query.toString();
    const res = await fetch(buildUrl(`/outward-remittances${qs ? `?${qs}` : ''}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    return await res.json();
  },

  async createOutwardRemittance(input: any, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl('/outward-remittances', endpoint), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data;
  },

  async deleteOutwardRemittance(id: string, endpoint?: string): Promise<void> {
    const res = await fetch(buildUrl(`/outward-remittances/${encodeURIComponent(id)}`, endpoint), {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await parseError(res));
  },

  async getVoucherRemittanceSummary(voucherId: string, endpoint?: string): Promise<any> {
    const res = await fetch(buildUrl(`/outward-remittances/voucher-summary/${encodeURIComponent(voucherId)}`, endpoint), { headers: authHeaders() });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    return data.summary;
  },
};
